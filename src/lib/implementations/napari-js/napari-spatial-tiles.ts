import { Colormap, colormapFromLut } from 'napari-js';
import type { ImageLayer, Layer, RGBA, ShapesLayer, Viewer } from 'napari-js';

import type { Rgb } from '../../contracts/colormap-lut';
import { ALL_GENES, type SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import type { SpatialViewState } from '../../contracts/display-types';
import {
  NO_CATEGORY, NO_OBSERVATION, SpatialBounds, SpatialColumn, SpatialDataset, SpatialDensityRaster, SpatialImageRef,
  SpatialPolygonTile,
  SpatialPolygons, SpatialTranscriptCounts, SpatialTranscriptSummary, SpatialTranscriptTile,
  isCategoricalColumn,
} from '../../contracts/spatial-dataset.contract';
import {
  DEFAULT_CATEGORICAL_PALETTE, MISSING_COLOR, contrastWindow, lutFor, parseHex, resolveCategoryColors,
} from '../../spatial/spatial-encoding';
import { SpatialSelectionMask } from '../../spatial/spatial-selection';
import {
  DataRect, INFERNO_SCALE, POLYGON_LEVEL_MIN_CELL_PX, TranscriptGlyph, allGenesPlan, cellTypeColumnFor,
  cellsShown, colorDensityWindow, densityAutoRange, groupedMarkerPx, quantileOf, tilesInRectFrom,
  defaultGlyphFor, discreteColormapStops, glyphOutline, glyphRings, pixelsPerDataUnit,
  polygonLevelFor, tileId, tilesInRect, transcriptLevelFor, transcriptMarkerPx,
  typicalCellDiameter, visibleArea, visibleDataRect, geneBinSize, groupTranscripts, clipTranscripts,
  clusterColorMap,
} from '../../spatial/spatial-tiles';

/** The all-gene pyramid's finest bin (250 µm source tiles / 128) and default level count, used
 *  to group a gene selection on the same ladder when a dataset has no pyramid. */
const PYRAMID_BASE_BIN_UM = 250 / 128;
const PYRAMID_LEVELS = 7;
/** Icons get a dark rim only while there are at most this many, at least this big (px). */
const GLYPH_OUTLINE_MAX = 20_000;
const GLYPH_OUTLINE_MIN_PX = 8;

/**
 * Level-of-detail cell outlines, transcripts and transcript density for the 2D spatial view.
 *
 * WHY A SEPARATE CLASS
 * --------------------
 * Everything else the spatial view draws is built once per (dataset, view) and only
 * restyled afterwards. These layers also depend on the CAMERA: which tiles are on screen
 * and which level of detail the zoom calls for. Keeping that loop — plan on camera idle,
 * fetch tiles, merge, draw — out of the visualizer service keeps both readable.
 *
 * LAYER ORDER
 * -----------
 * napari-js's layer list is append-only (add / remove / clear), so order is kept by
 * re-adding: cell fill, cell outline, the transcript density, then transcripts on top.
 * The service's observation markers sit under all of them; while outlines are drawn the
 * markers are hidden (a cell is its outline then, not a dot), so the cells never have to
 * be ordered against them. The density goes OVER the markers on purpose: under 10^5
 * dots it would only show in the gaps between cells. {@link afterObservations} restores
 * the order after the service re-adds its markers.
 *
 * ONE LAYER PER GROUP
 * -------------------
 * Each group is one merged layer over every visible tile, rebuilt when the tile set or
 * level changes. Recolouring (a new cell-type column, a selection) only rewrites the
 * per-shape values — the geometry is not re-expanded.
 */
export interface SpatialTileHost {
  /** Latest dataset/view/selection, as the spatial subscription saw them. */
  latest(): [SpatialDataset | null, SpatialViewState, SpatialSelectionMask] | null;
  /** Canvas size in CSS pixels. */
  canvasSize(): [number, number];
  /** The continuous LUT the view is using (so cells coloured by a gene match the markers). */
  continuousLut(view: SpatialViewState): Rgb[];
  /** Outlines appeared or disappeared: the markers' visibility follows. */
  polygonsShownChanged(shown: boolean): void;
  /** The density window changed (auto-derived or set). */
  densityChanged?(stats: { lo: number; hi: number; max: number }): void;
  /** Estimated transcripts in view for the current selection, against the budget. */
  estimateChanged?(estimate: TranscriptEstimate | null): void;
  /** Transcripts of each selected gene inside the view, or null when not known. */
  geneCountsChanged?(counts: Record<string, number> | null): void;
  /** The layers whose data is in flight now ("Transcripts", "Cells"…); empty when none. */
  loadingChanged?(layers: string[]): void;
}

/** Xenium Explorer's "Estimated Transcript Points". */
export interface TranscriptEstimate {
  /** Transcripts of the visible genes estimated to be in view. */
  points: number;
  /** The marker budget. */
  max: number;
}

type Group = 'density' | 'cellFill' | 'cellOutline' | 'nucleusOutline' | 'transcripts' | 'transcriptOutline';
const ORDER: Group[] = [
  'cellFill', 'cellOutline', 'nucleusOutline', 'density', 'transcripts', 'transcriptOutline',
];

/** Transcripts drawn at once. Past this a screen is solid colour anyway; the level
 *  policy keeps a normal view far below it. */
const MAX_TRANSCRIPTS = 400_000;
const MAX_CELL_TILES = 48;
const MAX_TRANSCRIPT_TILES = 36;
const MAX_BIN_TILES = 64;

/** A transcript fetch the planner can key before running. */
interface TranscriptJob {
  /** What one entry is — decides what hovering it says. */
  kind: 'genes' | 'individual' | 'bins';
  /** For bins: their size and grid origin, so a hovered bin's square can be recovered. */
  bin?: { size: number; origin: [number, number] };
  /** Identifies what will be drawn, so an unchanged plan is a no-op. */
  key: string;
  /** Fetch and merge; `px` is each entry's marker diameter in screen pixels. A job may
   *  switch to another kind once it sees the data (individual → bins); it then says so. */
  load(): Promise<TranscriptLoad>;
}

interface TranscriptLoad {
  merged: SpatialTranscriptTile;
  px: Float32Array;
  /** For a gene selection: group it on this bin ladder once hidden genes are dropped. */
  ladder?: { baseBin: number; levels: number; start: number | null };
  /** Already one marker per cluster per bin (zoomed out, from the density grids): no cells. */
  clustered?: { group: Int32Array; names: string[]; genes: string[][]; bin: number; origin: [number, number] };
  kind?: TranscriptJob['kind'];
  bin?: TranscriptJob['bin'];
}

/** Where a layer sits in world space: the dataset's affine onto its tissue image. */
interface Placement { scale: [number, number]; translate: [number, number] }

/** Transcript colours: per-entry RGBA for points, values + colormap for shapes. */
interface TranscriptFaces { rgba: RGBA[]; values: Float32Array; colormap: Colormap }
const CAMERA_IDLE_MS = 120;
/** First retry of a view with a failed tile; doubles each time, up to MAX_TILE_RETRIES. */
const TILE_RETRY_MS = 1000;
const MAX_TILE_RETRIES = 3;

const UNASSIGNED_RGBA: RGBA = [0.62, 0.62, 0.62, 0.55];

export class NapariSpatialTileLayers {
  private viewer: Viewer | null = null;
  private cameraOff: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Set when a tile of the current plan failed to load (see fetchAll). */
  private planIncomplete = false;
  /** Consecutive retries of an incomplete view. */
  private tileRetries = 0;
  private token = 0;
  private readonly layers = new Map<Group, Layer>();
  /** What each group currently shows, so an unchanged plan is a no-op. */
  private readonly keys = new Map<Group, string>();
  private polygonsShown = false;
  /** Rings currently drawn and the (dataset, set, tiles) they came from. */
  private currentRings: SpatialPolygonTile | null = null;
  private cellGeometryKey: string | null = null;
  private currentNuclei: SpatialPolygonTile | null = null;
  private cellStyleKey: string | null = null;
  /** Selection identity → revision, so a change key can name a selection cheaply. */
  private lastSelection: SpatialSelectionMask | null = null;
  private selectionRevision = 0;

  constructor(private readonly port: SpatialDataPort, private readonly host: SpatialTileHost) {}

  // ── lifecycle ─────────────────────────────────────────────────────────────────────

  attach(viewer: Viewer): void {
    if (this.viewer === viewer) return;
    this.detach();
    this.viewer = viewer;
    this.cameraOff = viewer.camera.changed.connect(() => this.schedule());
  }

  /**
   * Group a gene selection for the zoom: one marker per gene-tree cluster (a gene in no
   * cluster is its own) per bin of the pyramid ladder, starting at the finest bin whose
   * markers are 14 px apart and stepping up while the markers would exceed the budget.
   * Null to draw every transcript: zoomed in, with the selection within the budget.
   */
  private groupSelection(
    t: SpatialTranscriptTile, view: SpatialViewState, ladder: NonNullable<TranscriptLoad['ladder']>,
    pxPerUnit: number,
  ): { merged: SpatialTranscriptTile; px: Float32Array; bin: number; group: Int32Array; names: string[] } | null {
    const budget = Math.max(1, view.transcriptBudget);
    const genes = view.transcriptGenes;
    const groups = view.transcriptGeneGroups;
    const names = [...groups.map((g) => g.name), ...genes];
    const clusterOf = genes.map((gene, slot) => {
      const g = groups.findIndex((x) => x.genes.includes(gene));
      return g >= 0 ? g : groups.length + slot;
    });
    const keyOf = (slot: number) => clusterOf[slot] ?? groups.length + slot;
    let bin = ladder.start;
    if (bin === null) {
      // Every transcript, if they fit the max and none was cut off at the cap.
      if (t.count <= budget && t.count < MAX_TRANSCRIPTS) return null;
      bin = ladder.baseBin;
    }
    const top = ladder.baseBin * 2 ** (ladder.levels - 1);
    let grouped = groupTranscripts(t, bin, keyOf);
    // Over the max: combine into larger markers, a level at a time.
    while (grouped.tile.count > budget && bin < top) {
      bin *= 2;
      grouped = groupTranscripts(t, bin, keyOf);
    }
    const refCount = quantileOf(grouped.tile.weight, 0.95);
    const binPx = bin * pxPerUnit;
    const px = new Float32Array(grouped.tile.count);
    for (let i = 0; i < grouped.tile.count; i++) {
      px[i] = groupedMarkerPx(grouped.tile.weight[i], refCount, binPx, view.transcriptScale);
    }
    return { merged: grouped.tile, px, bin, group: grouped.group, names };
  }

  /** µm per observation unit of the drawn dataset, for describing a grouped marker's area. */
  private micronsPerUnit: number | null = null;

  /** Loads in flight, per layer label, for the loading badge. */
  private readonly loading = new Map<string, number>();

  /** Report `label` loading while `work` is in flight. */
  private async track<T>(label: string, work: Promise<T>): Promise<T> {
    this.loading.set(label, (this.loading.get(label) ?? 0) + 1);
    this.host.loadingChanged?.([...this.loading.keys()]);
    try {
      return await work;
    } finally {
      const n = (this.loading.get(label) ?? 1) - 1;
      if (n > 0) this.loading.set(label, n);
      else this.loading.delete(label);
      this.host.loadingChanged?.([...this.loading.keys()]);
    }
  }

  /** The loaded per-gene transcripts the in-view counts are taken from. */
  private countSource: { merged: SpatialTranscriptTile; genes: string[] } | null = null;

  /**
   * Transcripts of each selected gene inside `rect`: each entry counts for the transcripts it
   * stands for (an aggregate at a coarse level holds several). Null without per-gene data.
   */
  geneCountsIn(rect: DataRect): Record<string, number> | null {
    const src = this.countSource;
    if (!src) return null;
    const out: Record<string, number> = {};
    for (const g of src.genes) out[g] = 0;
    const { x, y, weight, gene } = src.merged;
    for (let i = 0; i < src.merged.count; i++) {
      if (x[i] < rect.x0 || x[i] > rect.x1 || y[i] < rect.y0 || y[i] > rect.y1) continue;
      const name = src.genes[gene[i]];
      if (name !== undefined) out[name] += weight[i];
    }
    return out;
  }

  /** Whether `layer` is one of the overlays drawn here (density, cells, transcripts). */
  owns(layer: Layer): boolean {
    for (const l of this.layers.values()) if (l === layer) return true;
    return false;
  }

  detach(): void {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    this.drawn = null;
    this.cameraOff?.();
    this.cameraOff = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.token++;
    this.tileRetries = 0;
    this.countSource = null;
    this.loading.clear();
    this.host.loadingChanged?.([]);
    if (this.viewer) {
      for (const layer of this.layers.values()) {
        if (this.viewer.layers.items.includes(layer)) this.viewer.layers.remove(layer);
      }
    }
    this.layers.clear();
    this.keys.clear();
    this.setPolygonsShown(false);
    this.viewer = null;
  }

  /** True while outlines are on screen — the service hides its dots then. */
  get outlinesShown(): boolean {
    return this.polygonsShown;
  }

  /** Dataset, view or selection changed: re-plan now rather than on camera idle. */
  refresh(): void {
    this.schedule(0);
  }

  /** Called right after the service adds its marker layer: everything goes back on top. */
  afterObservations(): void {
    const v = this.viewer;
    if (!v) return;
    for (const g of ORDER) {
      const layer = this.layers.get(g);
      if (!layer) continue;
      if (v.layers.items.includes(layer)) v.layers.remove(layer);
      v.layers.add(layer);
    }
  }

  // ── planning ──────────────────────────────────────────────────────────────────────

  private schedule(delay = CAMERA_IDLE_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.plan().catch((err) => console.warn('[napari-js] spatial tile plan failed', err));
    }, delay);
  }

  private async plan(): Promise<void> {
    const viewer = this.viewer;
    const latest = this.host.latest();
    if (!viewer || !latest) return;
    const [dataset, view, selection] = latest;
    const token = ++this.token;
    const stale = () => token !== this.token || this.viewer !== viewer;
    this.planIncomplete = false;

    if (!dataset) {
      for (const g of ORDER) this.drop(g);
      this.dropCells();
      return;
    }
    const [w, h] = this.host.canvasSize();
    const ref = dataset.imageRef;
    const rect = visibleDataRect(viewer.camera.center, viewer.camera.zoom, w, h, ref);
    const pxPerUnit = pixelsPerDataUnit(viewer.camera.zoom, ref);
    if (!rect) return;

    this.planEstimate(dataset, view, viewer, w, h, stale)
      .catch((err) => console.warn('[napari-js] transcript estimate failed', err));
    // A group whose request failed (a column, a feature vector, a density grid) leaves the
    // others drawn and marks the plan incomplete, so it is retried like a failed tile.
    const settle = (group: string, work: Promise<void>) => work.catch((err) => {
      console.warn(`[napari-js] spatial ${group} plan failed`, err);
      this.planIncomplete = true;
    });
    await Promise.all([
      settle('density', this.planDensity(dataset, view, stale)),
      settle('cells', this.planCells(dataset, view, selection, rect, pxPerUnit, stale)),
      settle('transcripts', this.planTranscripts(dataset, view, rect, pxPerUnit, stale)),
    ]);
    if (stale()) return;
    this.host.geneCountsChanged?.(this.geneCountsIn(rect));
    // A tile that failed left a hole the cache keys do not record, so try the same view
    // again, backing off, a bounded number of times.
    if (!this.planIncomplete) {
      this.tileRetries = 0;
    } else if (this.tileRetries < MAX_TILE_RETRIES) {
      this.schedule(TILE_RETRY_MS * 2 ** this.tileRetries++);
    }
  }

  // ── cells ─────────────────────────────────────────────────────────────────────────

  private async planCells(
    dataset: SpatialDataset, view: SpatialViewState, selection: SpatialSelectionMask,
    rect: DataRect, pxPerUnit: number, stale: () => boolean,
  ): Promise<void> {
    const tiled = dataset.polygonTiles;
    const whole = !tiled && dataset.polygons && this.port.getPolygons;
    if (!cellsShown(dataset, view) || (!tiled && !whole)) {
      this.dropCells();
      return;
    }
    const diameter = typicalCellDiameter(dataset.observations.radius);
    // Whole-dataset rings have one level and no coarser fallback, so they are drawn as
    // soon as a cell is big enough to read as a shape rather than a dot.
    const level = tiled
      ? polygonLevelFor(pxPerUnit, diameter, tiled.levels.length)
      : (pxPerUnit * diameter >= POLYGON_LEVEL_MIN_CELL_PX[2] ? 0 : -1);
    if (level < 0) {
      this.dropCells();
      return;
    }

    // Groups switched off in the list: their cells are left out of the geometry.
    const hidden = await this.hiddenCodes(dataset, view);
    if (stale()) return;
    const label = view.cellSet === 'both' ? 'Cells and nuclei'
      : view.cellSet === 'nucleus' ? 'Nuclei' : 'Cells';
    const geometry = await this.track(label, this.cellGeometry(dataset, view, rect, level, hidden, stale));
    if (!geometry) return;
    const { rings, nuclei, geometryKey } = geometry;

    const geometryChanged = geometryKey !== this.cellGeometryKey;
    const styleKey = [
      geometryKey, view.cellColorMode, view.cellColorGene, view.cellSingleColor,
      this.cellTypeColumnName(dataset, view),
      this.selectionRev(selection), view.logScale, view.percentileClip.join(),
      JSON.stringify(view.continuousColormap), view.cellDraw, view.cellOpacity,
    ].join('|');
    const present = ['cellFill', 'cellOutline', 'nucleusOutline'].some((g) => {
      const l = this.layers.get(g as Group);
      return l && this.viewer!.layers.items.includes(l);
    });
    if (!geometryChanged && styleKey === this.cellStyleKey && present) {
      this.setPolygonsShown(true);
      return;
    }
    const colors = await this.cellColors(dataset, view, selection, rings.observation);
    if (stale()) return;

    this.currentRings = rings;
    this.currentNuclei = nuclei;
    // A geometry missing a failed tile is drawn but not remembered, so the retry refetches it.
    this.cellGeometryKey = this.planIncomplete ? null : geometryKey;
    this.cellStyleKey = styleKey;
    const ref = dataset.imageRef;
    const common = { scale: ref?.scale ?? [1, 1], translate: ref?.translate ?? [0, 0] } as const;
    const fill = view.cellDraw !== 'outline';
    const outline = view.cellDraw !== 'fill';

    this.upsertShapes('cellFill', fill, geometryChanged, rings, {
      name: 'cells', draw: 'fill', opacity: view.cellOpacity, ...colors, ...common,
    });
    this.upsertShapes('cellOutline', outline, geometryChanged, rings, fill
      // Over a fill, a dark outline separates neighbours of the same type.
      ? { name: 'cell outlines', draw: 'outline', color: [0.08, 0.08, 0.1, 1], opacity: 0.7, ...common }
      : { name: 'cell outlines', draw: 'outline', opacity: 1, ...colors, ...common });
    // "Both": nuclei outlined over the cells, light so they read against any fill.
    if (nuclei) {
      this.upsertShapes('nucleusOutline', true, geometryChanged, nuclei, {
        name: 'nucleus outlines', draw: 'outline', color: [0.95, 0.95, 0.98, 1], opacity: 0.8, ...common,
      });
    } else {
      this.drop('nucleusOutline');
    }
    this.setPolygonsShown(true);
  }

  private selectionRev(selection: SpatialSelectionMask): number {
    if (selection !== this.lastSelection) {
      this.lastSelection = selection;
      this.selectionRevision++;
    }
    return this.selectionRevision;
  }

  /** Per-shape values + colormap for the rings' owners. */
  /**
   * Per-shape values + colormap for the rings' owners, by the view's cell-colour mode
   * (Xenium Explorer's "Cell Color"). A selection mutes what it leaves out.
   */
  private async cellColors(
    dataset: SpatialDataset, view: SpatialViewState, selection: SpatialSelectionMask,
    owners: Uint32Array,
  ): Promise<{ values?: Float32Array; colormap?: Colormap; contrastLimits?: [number, number]; color?: RGBA }> {
    const muted = selection.count > 0 ? selection.mask : null;
    const mode = view.cellColorMode;

    if (mode === 'single') {
      const [r, g, b] = parseHex(view.cellSingleColor);
      return { color: [r / 255, g / 255, b / 255, 1] };
    }

    const continuous = async (raw: Float32Array, log: boolean) => {
      const values = new Float32Array(owners.length);
      for (let i = 0; i < owners.length; i++) {
        const v = raw[owners[i]] ?? NaN;
        values[i] = log ? Math.log1p(Math.max(0, v)) : v;
      }
      const [lo, hi] = contrastWindow(
        log ? raw.map((v) => Math.log1p(Math.max(0, v))) : raw,
        view.percentileClip[0], view.percentileClip[1],
      );
      return {
        values,
        colormap: colormapFromLut('spatial-continuous', this.host.continuousLut(view)),
        contrastLimits: [lo, hi] as [number, number],
      };
    };
    if (mode === 'gene' && view.cellColorGene) {
      return continuous(await this.port.getFeatureVector(view.cellColorGene), true);
    }
    if (mode === 'transcriptDensity' && dataset.columns.some((c) => c.name === 'transcript_density')) {
      const column = await this.port.getColumn('transcript_density');
      if (!isCategoricalColumn(column)) return continuous(column.values, false);
    }

    const name = mode === 'segmentation' && dataset.columns.some((c) => c.name === 'segmentation_method')
      ? 'segmentation_method'
      : this.cellTypeColumnName(dataset, view);
    const codes = name ? await this.categoricalCodes(name) : null;
    const { colormap, valueOf } = this.categoricalColormap(codes?.meta ?? null);
    const values = new Float32Array(owners.length);
    for (let i = 0; i < owners.length; i++) {
      const o = owners[i];
      const code = !codes || (muted && !muted[o]) ? -1 : codes.codes[o];
      values[i] = valueOf(code === NO_CATEGORY ? -1 : code);
    }
    return { values, colormap, contrastLimits: [0, 1] };
  }

  /** Codes of the group column that are switched off, or null when none are. */
  private async hiddenCodes(
    dataset: SpatialDataset, view: SpatialViewState,
  ): Promise<{ codes: Uint16Array; hidden: Uint8Array } | null> {
    if (!view.hiddenGroups.length) return null;
    const name = this.cellTypeColumnName(dataset, view);
    const col = name ? await this.categoricalCodes(name) : null;
    if (!col || col.meta.kind !== 'categorical') return null;
    const off = new Set(view.hiddenGroups);
    const hidden = Uint8Array.from(col.meta.categories, (c) => (off.has(c) ? 1 : 0));
    return { codes: col.codes, hidden };
  }

  private cellTypeColumnName(dataset: SpatialDataset, view: SpatialViewState): string | null {
    return cellTypeColumnFor(dataset, view);
  }

  private async categoricalCodes(name: string):
    Promise<{ codes: Uint16Array; meta: SpatialColumn['meta'] } | null> {
    const column = await this.port.getColumn(name);
    return isCategoricalColumn(column) ? { codes: column.codes, meta: column.meta } : null;
  }

  private categoricalColormap(meta: SpatialColumn['meta'] | null):
    { colormap: Colormap; valueOf: (code: number) => number; rgb: Rgb[] } {
    const hex = meta && meta.kind === 'categorical'
      ? resolveCategoryColors(meta)
      : [DEFAULT_CATEGORICAL_PALETTE[0]];
    const rgb = hex.map(parseHex);
    const { stops, valueOf } = discreteColormapStops(rgb, MISSING_COLOR);
    return { colormap: new Colormap('spatial-categories', stops), valueOf, rgb };
  }

  /**
   * The cell rings (and, for "both", the nucleus rings) covering `rect` at `level`, minus
   * the hidden groups — reused when nothing that decides them changed. Null when the
   * view went stale or the dataset has no set to draw.
   */
  private async cellGeometry(
    dataset: SpatialDataset, view: SpatialViewState, rect: DataRect, level: number,
    hidden: { codes: Uint16Array; hidden: Uint8Array } | null, stale: () => boolean,
  ): Promise<{ rings: SpatialPolygonTile; nuclei: SpatialPolygonTile | null; geometryKey: string } | null> {
    const tiled = dataset.polygonTiles;
    const hiddenKey = view.hiddenGroups.join('\u0001');
    let rings: SpatialPolygonTile;
    let nuclei: SpatialPolygonTile | null = null;
    let geometryKey: string;
    if (tiled) {
      const both = view.cellSet === 'both';
      const set = !both && view.cellSet && tiled.sets.some((s) => s.name === view.cellSet)
        ? view.cellSet : (tiled.defaultSet ?? tiled.sets[0]?.name);
      if (!set) return null;
      const nucleusSet = both ? tiled.sets.find((s) => s.name !== set)?.name : undefined;
      const keys = tilesInRect(rect, level, tiled.levels, tiled.bounds, MAX_CELL_TILES);
      geometryKey = `${dataset.id}|${set}|${nucleusSet ?? ''}|${hiddenKey}|${keys.map(tileId).join(',')}`;
      if (geometryKey === this.cellGeometryKey && this.currentRings) {
        rings = this.currentRings;
        nuclei = this.currentNuclei;
      } else {
        const [tiles, nucleusTiles] = await Promise.all([
          this.fetchAll(keys, (k) => this.port.getPolygonTile!(set, k.level, k.gx, k.gy)),
          nucleusSet
            ? this.fetchAll(keys, (k) => this.port.getPolygonTile!(nucleusSet, k.level, k.gx, k.gy))
            : Promise.resolve(null),
        ]);
        if (stale()) return null;
        rings = filterRings(mergePolygonTiles(tiles), hidden);
        nuclei = nucleusTiles ? filterRings(mergePolygonTiles(nucleusTiles), hidden) : null;
      }
    } else {
      geometryKey = `${dataset.id}|whole|${hiddenKey}`;
      if (geometryKey === this.cellGeometryKey && this.currentRings) {
        rings = this.currentRings;
      } else {
        const polys: SpatialPolygons = await this.port.getPolygons!();
        if (stale()) return null;
        // Whole-dataset rings are index-aligned with the observations.
        rings = filterRings(
          { ...polys, observation: Uint32Array.from({ length: polys.count }, (_v, i) => i) }, hidden,
        );
      }
    }
    return { rings, nuclei, geometryKey };
  }

  // ── transcripts ───────────────────────────────────────────────────────────────────

  private async planTranscripts(
    dataset: SpatialDataset, view: SpatialViewState, rect: DataRect, pxPerUnit: number,
    stale: () => boolean,
  ): Promise<void> {
    const mode = view.transcriptMode;
    const job = (mode === 'circles' || mode === 'glyphs')
      && (this.port.getTranscriptTile || (this.port.getTranscriptGeneBins && dataset.transcriptGeneBins))
      ? (view.transcriptAllGenes
        ? this.allGenesJob(dataset, view, rect, pxPerUnit)
        : this.geneJob(dataset, view, rect, pxPerUnit))
      : null;
    if (!job) {
      this.drop('transcripts');
      this.drop('transcriptOutline');
      this.drawn = null;
      this.countSource = null;
      return;
    }
    // Marker sizes follow the zoom, so the zoom is part of the key; a pan that keeps
    // the same tiles on screen changes nothing.
    const planKey = [
      dataset.id, mode, job.key, view.transcriptColorBy, this.cellTypeColumnName(dataset, view),
      view.transcriptScale, view.transcriptOpacity, JSON.stringify(view.transcriptGlyphs),
      pxPerUnit.toPrecision(4), view.hiddenGroups.join('\u0001'), view.transcriptHiddenGenes.join(','),
      JSON.stringify(view.transcriptGeneColors), JSON.stringify(view.transcriptGeneGroups),
    ].join('|');
    const current = this.layers.get('transcripts');
    if (planKey === this.keys.get('transcripts') && current && this.viewer!.layers.items.includes(current)) {
      return;
    }
    const loaded = await this.track('Transcripts', job.load());
    if (stale()) return;
    // Per-gene counts in view come from what was loaded, before hidden genes are dropped:
    // a hidden gene still has transcripts there. Summed density grids (no per-gene levels,
    // zoomed out) hold clusters, not genes: no per-gene counts there, rather than a guess.
    this.countSource = (loaded.kind ?? job.kind) === 'genes' && !loaded.clustered
      ? { merged: loaded.merged, genes: [...view.transcriptGenes] } : null;
    const hidden = await this.hiddenCodes(dataset, view);
    if (stale()) return;
    // Density-grid markers carry no cells and were built from the visible genes only.
    const filtered = loaded.clustered ? { merged: loaded.merged, px: loaded.px }
      : filterTranscripts(loaded.merged, loaded.px, hidden,
        (loaded.kind ?? job.kind) === 'genes' ? hiddenGeneSlots(view) : null);
    let { merged, px } = filtered;
    let selectionBin: number | null = loaded.clustered?.bin ?? null;
    let entryGroup: Int32Array | null = loaded.clustered?.group ?? null;
    let groupNames: string[] | null = loaded.clustered?.names ?? null;
    if (loaded.ladder) {
      const g = this.groupSelection(merged, view, loaded.ladder, pxPerUnit);
      if (g) ({ merged, px, bin: selectionBin, group: entryGroup, names: groupNames } = g);
    }
    // A bin of the all-gene pyramid mixes genes and carries none, so it cannot be coloured
    // by gene: colour it by its dominant cell's type until individual transcripts show.
    const kind = loaded.kind ?? job.kind;
    const colorView = kind === 'bins' && view.transcriptColorBy !== 'cellType'
      ? { ...view, transcriptColorBy: 'cellType' as const }
      // Density-grid markers have no cell to take a type from: they take their cluster's colour.
      : loaded.clustered && view.transcriptColorBy === 'cellType'
        ? { ...view, transcriptColorBy: 'cluster' as const } : view;
    // Each entry's cluster: its marker's group, or the gene-tree group its gene is in.
    const geneCluster = view.transcriptGenes.map((g) =>
      view.transcriptGeneGroups.find((x) => x.genes.includes(g))?.name ?? g);
    const clusterOf = (i: number): string | null => (entryGroup && groupNames
      ? groupNames[entryGroup[i]] ?? null
      : geneCluster[merged.gene[i]] ?? null);
    const faces = await this.transcriptColors(dataset, colorView, merged, kind === 'genes' ? clusterOf : undefined);
    if (stale()) return;

    if (this.planIncomplete) this.keys.delete('transcripts');
    else this.keys.set('transcripts', planKey);
    const diam = px.map((d) => d / pxPerUnit);
    this.drawn = {
      kind: loaded.kind ?? job.kind,
      bin: selectionBin ? { size: selectionBin, origin: loaded.clustered?.origin ?? [0, 0] }
        : (loaded.kind ? loaded.bin : job.bin),
      merged, radius: diam.map((d) => d / 2),
      genes: [...view.transcriptGenes], ref: dataset.imageRef ?? null, grid: null,
      ...(entryGroup && groupNames ? { entryGroup, groupNames } : {}),
      ...(loaded.clustered ? { groupGenes: loaded.clustered.genes } : {}),
    };
    this.hoverCache.clear();
    this.micronsPerUnit = dataset.micronsPerUnit ?? null;
    const typeColumn = this.cellTypeColumnName(dataset, view);
    this.hoverTypes = typeColumn ? await this.categoricalCodes(typeColumn).catch(() => null) : null;
    if (stale()) return;
    const ref = dataset.imageRef;
    const place: Placement = { scale: ref?.scale ?? [1, 1], translate: ref?.translate ?? [0, 0] };
    if (mode === 'circles') {
      this.drop('transcriptOutline');
      this.drawTranscriptCircles(merged, diam, faces.rgba, view, place);
    } else {
      this.drawTranscriptGlyphs(merged, diam, faces, view, place, pxPerUnit);
    }
  }

  /** One sized circle per entry, the size saying how many transcripts it stands for. */
  private drawTranscriptCircles(
    merged: SpatialTranscriptTile, diam: Float32Array, rgba: RGBA[], view: SpatialViewState,
    { scale, translate }: Placement,
  ): void {
    const positions = new Float32Array(merged.count * 2);
    for (let i = 0; i < merged.count; i++) {
      positions[2 * i] = merged.x[i];
      positions[2 * i + 1] = merged.y[i];
    }
    const layer = this.viewer!.addPoints(positions, {
      name: 'transcripts',
      size: diam,
      faceColor: rgba,
      // A dark rim: a transcript coloured by its cell's type is otherwise the same
      // colour as the cell fill it sits on, and vanishes into it.
      borderColor: [0.04, 0.04, 0.05, 0.9],
      borderWidth: 0.18 * median(diam),
      opacity: view.transcriptOpacity,
      scale,
      translate,
    });
    this.replace('transcripts', layer);
  }

  private drawTranscriptGlyphs(
    merged: SpatialTranscriptTile, diam: Float32Array, faces: TranscriptFaces, view: SpatialViewState,
    { scale, translate }: Placement, pxPerUnit: number,
  ): void {
    // Glyphs: each entry becomes its gene's icon polygon, filled through a discrete
    // colormap and outlined dark so small icons stay readable over the tissue. With every
    // gene drawn there is one icon for all of them — 18,000 shapes would say nothing.
    const genes = view.transcriptGenes;
    const glyphFor = (slot: number): TranscriptGlyph =>
      (view.transcriptGlyphs[genes[slot]] as TranscriptGlyph | undefined) ?? defaultGlyphFor(slot);
    const single = view.transcriptAllGenes
      ? glyphOutline((view.transcriptGlyphs[ALL_GENES] as TranscriptGlyph | undefined) ?? 'circle')
      : null;
    const outlines = single ? [] : genes.map((_g, slot) => glyphOutline(glyphFor(slot)));
    const radius = diam.map((d) => d / 2);
    const { coords, offsets } = glyphRings(
      merged.x, merged.y, radius, (i) => single ?? outlines[merged.gene[i]],
    );
    const fill = this.viewer!.addShapes(coords, offsets, {
      name: 'transcripts',
      draw: 'fill',
      values: faces.values,
      colormap: faces.colormap,
      contrastLimits: [0, 1],
      opacity: view.transcriptOpacity,
      scale,
      translate,
    });
    this.replace('transcripts', fill);
    // A dark rim keeps a few large icons readable over the tissue; on many small ones the
    // rims merge into a solid dark sheet that hides every colour, so they are left off.
    const medianPx = median(diam) * pxPerUnit;
    if (merged.count > GLYPH_OUTLINE_MAX || medianPx < GLYPH_OUTLINE_MIN_PX) {
      this.drop('transcriptOutline');
      return;
    }
    const edge = this.viewer!.addShapes(coords, offsets, {
      name: 'transcript outlines',
      draw: 'outline',
      color: [0.05, 0.05, 0.05, 1],
      opacity: Math.min(1, view.transcriptOpacity + 0.1),
      scale,
      translate,
    });
    this.replace('transcriptOutline', edge);
  }

  // ── hover ─────────────────────────────────────────────────────────────────────────

  private drawn: DrawnTranscripts | null = null;
  private hoverTypes: { codes: Uint16Array; meta: SpatialColumn['meta'] } | null = null;
  /** Details already fetched, by hovered entry. */
  private readonly hoverCache = new Map<string, string[]>();
  private hoverKey: string | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Tooltip lines for the transcript marker under world point `(wx, wy)`, or null.
   *
   * Returns what is known at once (gene, count, cell type); anything that needs the
   * server — distinct genes in a group, its top genes and cells, the cell's display id —
   * arrives through `onDetails` once the pointer has rested on the marker briefly.
   */
  hoverAt(
    wx: number, wy: number, radiusWorld: number, onDetails: (lines: string[]) => void,
  ): string[] | null {
    const d = this.drawn;
    const layer = this.layers.get('transcripts');
    if (!d || !layer || !this.viewer?.layers.items.includes(layer) || !d.merged.count) {
      this.hoverKey = null;
      return null;
    }
    const sx = d.ref?.scale?.[0] ?? 1;
    const sy = d.ref?.scale?.[1] ?? 1;
    const x = (wx - (d.ref?.translate?.[0] ?? 0)) / sx;
    const y = (wy - (d.ref?.translate?.[1] ?? 0)) / sy;
    const i = pickNearest(d, x, y, radiusWorld / Math.abs(sx));
    if (i < 0) {
      this.hoverKey = null;
      return null;
    }
    const key = `${d.kind}|${d.merged.x[i]}|${d.merged.y[i]}|${d.merged.gene[i]}`;
    const cached = this.hoverCache.get(key);
    if (cached) return cached;
    if (key !== this.hoverKey) {
      this.hoverKey = key;
      if (this.hoverTimer) clearTimeout(this.hoverTimer);
      this.hoverTimer = setTimeout(() => void this.fetchDetails(d, i, key, onDetails), 150);
    }
    return this.describe(d, i, null);
  }

  private async fetchDetails(
    d: DrawnTranscripts, i: number, key: string, onDetails: (lines: string[]) => void,
  ): Promise<void> {
    if (!this.port.getTranscriptSummary || this.hoverKey !== key) return;
    const obs = d.merged.observation[i];
    const cells = obs === NO_OBSERVATION ? [] : [obs];
    let box: [number, number, number, number] | undefined;
    if ((d.kind === 'bins' || d.kind === 'genes') && d.bin) {
      const { size, origin } = d.bin;
      const bx = Math.floor((d.merged.x[i] - origin[0]) / size);
      const by = Math.floor((d.merged.y[i] - origin[1]) / size);
      const x0 = origin[0] + bx * size;
      const y0 = origin[1] + by * size;
      box = [x0, y0, x0 + size, y0 + size];
    } else if (d.kind === 'individual') {
      const e = 0.02;
      box = [d.merged.x[i] - e, d.merged.y[i] - e, d.merged.x[i] + e, d.merged.y[i] + e];
    }
    const genes = d.groupGenes && d.entryGroup ? d.groupGenes[d.entryGroup[i]] : undefined;
    try {
      const summary = await this.port.getTranscriptSummary({ box, cells, ...(genes ? { genes } : {}) });
      const lines = this.describe(d, i, summary);
      this.hoverCache.set(key, lines);
      if (this.hoverKey === key) onDetails(lines);
    } catch (err) {
      console.warn('[napari-js] transcript details unavailable', err);
    }
  }

  /** The tooltip text for entry `i`, with the server's details when they have arrived. */
  private describe(d: DrawnTranscripts, i: number, s: SpatialTranscriptSummary | null): string[] {
    const t = d.merged;
    const n = t.weight[i];
    const obs = t.observation[i];
    const fmt = (v: number) => v.toLocaleString();
    const typeOf = (o: number) => {
      const types = this.hoverTypes;
      if (!types || o === NO_OBSERVATION || types.meta.kind !== 'categorical') return null;
      const c = types.codes[o];
      return c === NO_CATEGORY ? null : types.meta.categories[c] ?? null;
    };
    const cellLine = (o: number, prefix: string) => {
      if (o === NO_OBSERVATION) return 'outside any cell';
      const id = s?.cellIds?.[o] ?? `#${o}`;
      const type = typeOf(o);
      return `${prefix} ${id}${type ? ` · ${type}` : ''}`;
    };

    if (d.kind === 'bins') {
      const lines = [`${fmt(n)} transcripts · all genes`];
      if (d.bin) lines.push(`${d.bin.size.toFixed(1)} × ${d.bin.size.toFixed(1)} µm area`);
      if (s?.transcripts !== undefined) {
        lines.push(`${fmt(s.genes ?? 0)} distinct genes · ${fmt(s.cells ?? 0)} cell${s.cells === 1 ? '' : 's'}`
          + (s.unassigned ? ` · ${fmt(s.unassigned)} outside cells` : ''));
        if (s.topGenes?.length) {
          lines.push(`top genes: ${s.topGenes.slice(0, 5).map((g) => `${g.name} ${fmt(g.count)}`).join(', ')}`);
        }
      }
      lines.push(cellLine(obs, 'mostly cell'));
      if (!s && this.port.getTranscriptSummary) lines.push('loading details…');
      return lines;
    }
    if (d.kind === 'individual') {
      const gene = s?.topGenes?.[0]?.name;
      return [
        gene ? `${gene} transcript` : 'Transcript',
        cellLine(obs, 'in cell'),
        ...(!s && this.port.getTranscriptSummary ? ['loading details…'] : []),
      ];
    }
    const gene = d.genes[t.gene[i]] ?? 'transcript';
    if (d.bin) {
      const um = d.bin.size * (this.micronsPerUnit ?? 1);
      const group = d.entryGroup && d.groupNames ? d.groupNames[d.entryGroup[i]] : gene;
      const top = s?.topGenes?.length
        ? [s.topGenes.slice(0, 6).map((g) => `${g.name} ${fmt(g.count)}`).join(', ')] : [];
      return [
        `${group} · ${fmt(n)} transcript${n === 1 ? '' : 's'}`,
        ...(d.groupGenes ? top : group !== gene ? [`mostly ${gene}`] : []),
        `${um.toFixed(1)} × ${um.toFixed(1)} µm area · zoom in to split`,
        ...(obs === NO_OBSERVATION && d.groupGenes ? [] : [cellLine(obs, 'mostly cell')]),
        ...(!s && d.groupGenes && this.port.getTranscriptSummary ? ['loading details…'] : []),
      ];
    }
    return n > 1
      ? [`${gene} · ${fmt(n)} transcripts`, 'grouped: zoom in to split', cellLine(obs, 'near cell')]
      : [`${gene} transcript`, cellLine(obs, 'in cell')];
  }

  /** Physical marker size needs µm; null when the dataset's unit is unknown. */
  private pxPerMicron(dataset: SpatialDataset, pxPerUnit: number): number | undefined {
    return dataset.micronsPerUnit ? pxPerUnit / dataset.micronsPerUnit : undefined;
  }

  /**
   * The chosen genes, at the level the zoom calls for — or coarser, while the markers in
   * view would exceed the budget.
   */
  private geneJob(
    dataset: SpatialDataset, view: SpatialViewState, rect: DataRect, pxPerUnit: number,
  ): TranscriptJob | null {
    const meta = dataset.transcriptTiles;
    const genes = view.transcriptGenes;
    if (!meta || !genes.length) return null;
    const first = transcriptLevelFor(pxPerUnit, meta.levels);
    const keysAt = (l: number) => tilesInRect(rect, l, meta.levels, meta.bounds, MAX_TRANSCRIPT_TILES);
    const query = { genes, quality: view.transcriptQuality };
    const pxPerMicron = this.pxPerMicron(dataset, pxPerUnit);
    const mx = (rect.x1 - rect.x0) * 0.25;
    const my = (rect.y1 - rect.y0) * 0.25;
    const around: DataRect = { x0: rect.x0 - mx, y0: rect.y0 - my, x1: rect.x1 + mx, y1: rect.y1 + my };
    // Zoomed out, each gene's transcripts are grouped on the all-gene pyramid's bin ladder,
    // so a gene selection reads like "all genes" does: one marker per gene per area, sized
    // by how many it holds; zoomed in far enough, every transcript is its own marker.
    const ladder = dataset.transcriptBins?.levels;
    const baseBin = ladder?.[0]?.binSize
      ?? (dataset.micronsPerUnit ? PYRAMID_BASE_BIN_UM / dataset.micronsPerUnit : 0);
    const bin = geneBinSize(pxPerUnit, baseBin, ladder?.length ?? PYRAMID_LEVELS);
    // Zoomed out to bins as wide as the density grid, a selection is drawn from the per-gene
    // density grids — one cached request per cluster — rather than 10x's coarse per-gene
    // tiles, which take minutes for a few hundred genes.
    // With the pyramid's per-gene levels, every zoom of a selection reads them: the level the
    // zoom calls for, coarser while the markers would exceed the max.
    // Both are built from high-quality calls only: with low-quality calls included, the
    // quality-aware tiles below serve every zoom (as long as there are tiles to serve).
    const highOnly = view.transcriptQuality !== 'all' || !this.port.getTranscriptTile;
    const geneBins = dataset.transcriptGeneBins;
    const fromGeneBins = highOnly && geneBins && this.port.getTranscriptGeneBins;
    if (fromGeneBins && (bin !== null || !this.port.getTranscriptTile)) {
      return this.geneBinsJob(dataset, view, around, geneBins, bin ?? geneBins.levels[0].binSize, mx, my, rect);
    }
    const grid = dataset.density?.gridSize[0] ?? 0;
    if (highOnly && bin !== null && grid > 0 && this.port.getDensity && bin >= grid * 0.75) {
      return this.clusterDensityJob(dataset, view, around, pxPerUnit, Math.max(bin, grid), mx, my, rect);
    }
    return {
      kind: 'genes',
      // The clip window, in quarter-view steps: a pan past the margin re-clips.
      key: `genes|${genes.join(',')}|${view.transcriptQuality}|${view.transcriptBudget}|${bin ?? 'each'}|`
        + `${Math.floor(rect.x0 / (mx || 1))},${Math.floor(rect.y0 / (my || 1))}|${keysAt(first).map(tileId)}`,
      load: async () => {
        // The zoom's own level only: over the budget, the transcripts are combined into
        // larger markers (groupSelection), never fetched from slower coarse levels.
        const tiles = await this.fetchAll(keysAt(first),
          (k) => this.port.getTranscriptTile!(k.level, k.gx, k.gy, query));
        // Only what is on screen (and a margin, so a small pan needs nothing new) counts
        // against the budget and the cap; a tile reaches far past the view.
        const merged = mergeTranscriptTiles(tiles.map((t) => clipTranscripts(t, around)), MAX_TRANSCRIPTS);
        const px = new Float32Array(merged.count);
        for (let i = 0; i < merged.count; i++) {
          px[i] = transcriptMarkerPx(merged.weight[i], view.transcriptScale, pxPerMicron);
        }
        return baseBin > 0
          ? { merged, px, ladder: { baseBin, levels: ladder?.length ?? PYRAMID_LEVELS, start: bin } }
          : { merged, px };
      },
    };
  }

  /**
   * A gene selection from the pyramid's per-gene levels: starting at the level whose bins are
   * `startBin`, fetch the view's tiles for the selected genes and step to a coarser level while
   * one marker per cluster per bin would exceed the max. Hidden genes are fetched too (their
   * counts in view still show) and dropped before drawing; grouping by cluster happens there.
   */
  private geneBinsJob(
    dataset: SpatialDataset, view: SpatialViewState, around: DataRect,
    meta: NonNullable<SpatialDataset['transcriptGeneBins']>, startBin: number, mx: number, my: number, rect: DataRect,
  ): TranscriptJob {
    const genes = view.transcriptGenes;
    const levels = meta.levels;
    let first = levels.findIndex((l) => l.binSize >= startBin * 0.999);
    if (first < 0) first = levels.length - 1;
    const budget = Math.max(1, view.transcriptBudget);
    const hidden = new Set(view.transcriptHiddenGenes);
    const clusters = this.selectionClusters(view);
    const clusterOf = new Map<number, number>();
    clusters.forEach((c, ci) => c.genes.forEach((g) => clusterOf.set(genes.indexOf(g), ci)));
    const keysAt = (m: number) => tilesInRectFrom(meta.origin, around, m,
      levels.map((l) => ({ tileSize: l.tileSize })), null, MAX_BIN_TILES);
    return {
      kind: 'genes',
      key: `gene-bins|${genes.join(',')}|${budget}|${first}|${JSON.stringify(view.transcriptGeneGroups)}|`
        + `${Math.floor(rect.x0 / (mx || 1))},${Math.floor(rect.y0 / (my || 1))}`,
      load: async () => {
        let m = first;
        for (;;) {
          const tiles = await this.fetchAll(keysAt(m),
            (k) => this.port.getTranscriptGeneBins!(k.level, k.gx, k.gy, genes));
          const clipped = tiles.map((t) => clipTranscripts(t, around));
          // Past the cap a merge would drop whole genes (the tail of every tile): go coarser.
          if (clipped.reduce((n, t) => n + t.count, 0) > MAX_TRANSCRIPTS && m < levels.length - 1) {
            m++;
            continue;
          }
          const merged = mergeTranscriptTiles(clipped, MAX_TRANSCRIPTS);
          // Markers this level would draw: one per (visible cluster, bin).
          const seen = new Set<string>();
          const bin = levels[m].binSize;
          for (let i = 0; i < merged.count; i++) {
            if (hidden.has(genes[merged.gene[i]])) continue;
            const c = clusterOf.get(merged.gene[i]);
            if (c === undefined) continue;
            seen.add(`${c}|${Math.floor(merged.x[i] / bin)}|${Math.floor(merged.y[i] / bin)}`);
          }
          if (seen.size <= budget || m >= levels.length - 1) {
            return { merged, px: new Float32Array(merged.count), ladder: { baseBin: bin, levels: 1, start: bin } };
          }
          m++;
        }
      },
    };
  }

  /** The selection's clusters: each gene-tree group's visible genes, then each ungrouped gene. */
  private selectionClusters(view: SpatialViewState): { name: string; genes: string[]; slot: number }[] {
    const hidden = new Set(view.transcriptHiddenGenes);
    const slots = new Map(view.transcriptGenes.map((g, i) => [g, i]));
    const taken = new Set<string>();
    const out: { name: string; genes: string[]; slot: number }[] = [];
    for (const g of view.transcriptGeneGroups) {
      const genes = g.genes.filter((x) => slots.has(x) && !hidden.has(x) && !taken.has(x));
      genes.forEach((x) => taken.add(x));
      if (genes.length) out.push({ name: g.name, genes, slot: slots.get(genes[0])! });
    }
    for (const gene of view.transcriptGenes) {
      if (!taken.has(gene) && !hidden.has(gene)) out.push({ name: gene, genes: [gene], slot: slots.get(gene)! });
    }
    return out;
  }

  /**
   * Per-gene density grids summed for `genes`, cached (a cluster is asked for once per bin).
   * Keyed by dataset too: this manager outlives a dataset, and another may share gene names.
   */
  private densityFor(dataset: string, genes: string[], bin: number): Promise<SpatialDensityRaster> {
    const key = `${dataset}|${bin}|${genes.join(',')}`;
    let p = this.densityCache.get(key);
    if (!p) {
      p = this.port.getDensity!(genes, bin);
      p.catch(() => this.densityCache.delete(key));
      this.densityCache.set(key, p);
      if (this.densityCache.size > 256) this.densityCache.delete(this.densityCache.keys().next().value!);
    }
    return p;
  }

  private readonly densityCache = new Map<string, Promise<SpatialDensityRaster>>();

  /**
   * A gene selection zoomed out: one marker per cluster per bin, from the per-gene density
   * grids. The bin starts where markers are 14 px apart and doubles until the markers fit the
   * max; each marker sits at the count-weighted centre of the finer grid inside it, so markers
   * follow the tissue rather than a lattice.
   */
  private clusterDensityJob(
    dataset: SpatialDataset, view: SpatialViewState, around: DataRect, pxPerUnit: number, startBin: number,
    mx: number, my: number, rect: DataRect,
  ): TranscriptJob {
    const grid = dataset.density!.gridSize[0];
    const clusters = this.selectionClusters(view);
    let first = grid;
    while (first < startBin * 0.999) first *= 2;
    const budget = Math.max(1, view.transcriptBudget);
    return {
      kind: 'genes',
      key: `clusters|${clusters.map((c) => `${c.name}:${c.genes.join('+')}`).join(';')}|${budget}|${first}|`
        + `${Math.floor(rect.x0 / (mx || 1))},${Math.floor(rect.y0 / (my || 1))}`,
      load: async () => {
        let bin = first;
        for (;;) {
          // The finer grid gives each marker its centre; the server bins 1, 2, 4 or 8 cells.
          const fine = Math.min(bin >= grid * 2 ? bin / 2 : bin, grid * 8);
          const rasters = await Promise.all(clusters.map((c) => this.densityFor(dataset.id, c.genes, fine)));
          const out = clusterMarkers(rasters, clusters.map((c) => c.slot), bin, around);
          if (out.tile.count <= budget || bin >= grid * 2 ** 12) {
            const refCount = quantileOf(out.tile.weight, 0.95);
            const binPx = bin * pxPerUnit;
            const px = new Float32Array(out.tile.count);
            for (let i = 0; i < out.tile.count; i++) {
              px[i] = groupedMarkerPx(out.tile.weight[i], refCount, binPx, view.transcriptScale);
            }
            return {
              merged: out.tile, px, kind: 'genes',
              clustered: {
                group: out.group, names: clusters.map((c) => c.name), genes: clusters.map((c) => c.genes), bin,
                origin: rasters[0]?.meta.origin ?? [0, 0],
              },
            };
          }
          bin *= 2;
        }
      },
    };
  }

  /**
   * Every gene: the transcripts themselves once they fit the budget, else bins of the
   * all-gene pyramid sized by how many transcripts each holds.
   */
  private allGenesJob(
    dataset: SpatialDataset, view: SpatialViewState, rect: DataRect, pxPerUnit: number,
  ): TranscriptJob | null {
    const bins = dataset.transcriptBins;
    const tiles = dataset.transcriptTiles;
    const bounds = bins?.bounds ?? tiles?.bounds;
    if (!bounds) return null;
    const plan = allGenesPlan({
      rect, bounds, pxPerUnit, budget: view.transcriptBudget,
      total: bins?.count ?? tiles?.count ?? 0,
      levels: bins && this.port.getTranscriptBins ? bins.levels : [],
      canIndividual: !!tiles,
    });

    if (plan.kind === 'individual' && tiles) {
      const keys = tilesInRect(rect, 0, tiles.levels, tiles.bounds, MAX_TRANSCRIPT_TILES);
      // Each tile clipped to the view, rounded outward to 10 units so small pans hit cache.
      const r10 = (v: number, up: boolean) => (up ? Math.ceil(v / 10) : Math.floor(v / 10)) * 10;
      const size = tiles.levels[0].tileSize;
      const boxes = keys.map((k): [number, number, number, number] => [
        Math.max(k.gx * size, r10(rect.x0, false)), Math.max(k.gy * size, r10(rect.y0, false)),
        Math.min((k.gx + 1) * size, r10(rect.x1, true)), Math.min((k.gy + 1) * size, r10(rect.y1, true)),
      ]);
      const pxPerMicron = this.pxPerMicron(dataset, pxPerUnit);
      return {
        kind: 'individual',
        key: `all|individual|${view.transcriptBudget}|${boxes.map((b) => b.join(',')).join(';')}`,
        load: async () => {
          const got = await this.fetchAll(keys.map((k, i) => ({ ...k, box: boxes[i] })),
            (k) => this.port.getTranscriptTile!(0, k.gx, k.gy, { genes: [ALL_GENES], box: k.box }));
          // The plan estimated the view from the dataset's average density; expression is
          // uneven, so a dense view can hold far more. Rather than cut the excess off, show
          // it grouped — the bin level the planner would pick if it had known.
          const cap = Math.max(view.transcriptBudget * 1.5, 1);
          const loaded = got.reduce((n, t) => n + t.count, 0);
          if (loaded > cap && bins && this.port.getTranscriptBins) {
            const fallback = allGenesPlan({
              rect, bounds, pxPerUnit, budget: view.transcriptBudget, total: bins.count,
              levels: bins.levels, canIndividual: false,
            });
            if (fallback.kind === 'bins') {
              const job = this.binsJob(view, rect, pxPerUnit, bounds, bins, fallback.level);
              return { ...(await job.load()), kind: job.kind, bin: job.bin };
            }
          }
          const merged = mergeTranscriptTiles(got, cap);
          const px = new Float32Array(merged.count);
          for (let i = 0; i < merged.count; i++) px[i] = transcriptMarkerPx(1, view.transcriptScale, pxPerMicron);
          return { merged, px };
        },
      };
    }

    if (plan.kind === 'bins' && bins && this.port.getTranscriptBins) {
      return this.binsJob(view, rect, pxPerUnit, bounds, bins, plan.level);
    }
    return null;
  }

  /** Bins of the all-gene pyramid at `level`, sized by how many transcripts each holds. */
  private binsJob(
    view: SpatialViewState, rect: DataRect, pxPerUnit: number, bounds: SpatialBounds,
    bins: NonNullable<SpatialDataset['transcriptBins']>, level: number,
  ): TranscriptJob {
    const lv = bins.levels[level];
    const keys = tilesInRectFrom(bins.origin, rect, level,
      bins.levels.map((l) => ({ tileSize: l.tileSize })), bounds, MAX_BIN_TILES);
    return {
      kind: 'bins',
      bin: { size: lv.binSize, origin: bins.origin },
      key: `all|bins|${level}|${view.transcriptBudget}|${keys.map(tileId)}`,
      load: async () => {
        const got = await this.fetchAll(keys, (k) => this.port.getTranscriptBins!(k.level, k.gx, k.gy));
        const merged = mergeTranscriptTiles(got, Math.max(view.transcriptBudget * 1.5, 1));
        const refCount = quantileOf(merged.weight, 0.95);
        const binPx = lv.binSize * pxPerUnit;
        const px = new Float32Array(merged.count);
        for (let i = 0; i < merged.count; i++) {
          px[i] = groupedMarkerPx(merged.weight[i], refCount, binPx, view.transcriptScale);
        }
        return { merged, px };
      },
    };
  }

  /** Per-entry colours both as RGBA (points) and as colormap values (glyph shapes). */
  private async transcriptColors(
    dataset: SpatialDataset, view: SpatialViewState, t: SpatialTranscriptTile,
    clusterOf?: (i: number) => string | null,
  ): Promise<TranscriptFaces> {
    let rgb: Rgb[];
    let codeOf: (i: number) => number;
    if (view.transcriptColorBy === 'cluster' && clusterOf) {
      // A cluster named like a group of the cells' grouping takes that group's colour, so a
      // cluster's transcripts and its cells agree; any other cluster takes a palette colour.
      const name = this.cellTypeColumnName(dataset, view);
      const codes = name ? await this.categoricalCodes(name).catch(() => null) : null;
      const cellColor = new Map<string, string>();
      if (codes?.meta.kind === 'categorical') {
        const colors = resolveCategoryColors(codes.meta);
        codes.meta.categories.forEach((c, k) => cellColor.set(c, colors[k]));
      }
      const colors = clusterColorMap(view.transcriptGenes, view.transcriptGeneGroups, cellColor,
        DEFAULT_CATEGORICAL_PALETTE);
      const index = new Map<string, number>();
      const hex: string[] = [];
      const codeFor = (cluster: string) => {
        let k = index.get(cluster);
        if (k === undefined) {
          k = hex.length;
          index.set(cluster, k);
          hex.push(colors.get(cluster) ?? cellColor.get(cluster) ?? DEFAULT_CATEGORICAL_PALETTE[0]);
        }
        return k;
      };
      const code = new Int32Array(t.count);
      for (let i = 0; i < t.count; i++) {
        const c = clusterOf(i);
        code[i] = c === null ? -1 : codeFor(c);
      }
      rgb = hex.map(parseHex);
      codeOf = (i) => code[i];
    } else if (view.transcriptColorBy === 'gene' || view.transcriptColorBy === 'cluster') {
      // All genes: codes are the dataset's gene indices, folded onto the palette.
      const n = view.transcriptAllGenes ? DEFAULT_CATEGORICAL_PALETTE.length : view.transcriptGenes.length;
      rgb = Array.from({ length: n }, (_g, i) => parseHex(
        (!view.transcriptAllGenes && view.transcriptGeneColors[view.transcriptGenes[i]])
        || DEFAULT_CATEGORICAL_PALETTE[i % DEFAULT_CATEGORICAL_PALETTE.length]));
      codeOf = view.transcriptAllGenes ? (i) => t.gene[i] % n : (i) => t.gene[i];
    } else {
      const name = this.cellTypeColumnName(dataset, view);
      const codes = name ? await this.categoricalCodes(name) : null;
      rgb = codes?.meta.kind === 'categorical' ? resolveCategoryColors(codes.meta).map(parseHex) : [];
      codeOf = (i) => {
        const o = t.observation[i];
        if (!codes || o === NO_OBSERVATION) return -1;
        const c = codes.codes[o];
        return c === NO_CATEGORY ? -1 : c;
      };
    }
    const { stops, valueOf } = discreteColormapStops(rgb, MISSING_COLOR);
    const rgba: RGBA[] = new Array(t.count);
    const values = new Float32Array(t.count);
    const tuples: RGBA[] = rgb.map(([r, g, b]) => [r / 255, g / 255, b / 255, 1]);
    for (let i = 0; i < t.count; i++) {
      const c = codeOf(i);
      rgba[i] = c < 0 ? UNASSIGNED_RGBA : tuples[c];
      values[i] = valueOf(c);
    }
    return { rgba, values, colormap: new Colormap('transcript-categories', stops) };
  }

  // ── density ───────────────────────────────────────────────────────────────────────

  private async planDensity(
    dataset: SpatialDataset, view: SpatialViewState, stale: () => boolean,
  ): Promise<void> {
    const hiddenGenes = new Set(view.transcriptHiddenGenes);
    const genes = view.transcriptAllGenes
      ? [ALL_GENES]
      : view.transcriptGenes.filter((g) => !hiddenGenes.has(g));
    if (!dataset.density || !this.port.getDensity || view.transcriptMode !== 'density' || !genes.length) {
      this.drop('density');
      this.densityStats = null;
      return;
    }
    const lut = lutFor(view.densityColormap ?? INFERNO_SCALE);
    const key = [dataset.id, genes.join(','), view.densityBin, view.densityOpacity,
      JSON.stringify(view.densityRange), JSON.stringify(view.densityColormap)].join('|');
    if (key === this.keys.get('density') && this.layers.has('density')) return;
    const raster = await this.track('Transcript density', this.port.getDensity(genes, view.densityBin));
    if (stale()) return;

    // Bins drawn as squares, as Xenium Explorer does; the window is in transcripts/µm².
    const meta = raster.meta;
    const area = meta.gridSize[0] * meta.gridSize[1];
    const perArea = raster.values.map((v) => v / area);
    const [lo, hi] = view.densityRange ?? densityAutoRange(perArea);
    this.densityStats = { lo, hi, max: perArea.reduce((m, v) => (v > m ? v : m), 0) };
    const rgba = colorDensityWindow(perArea, lut, view.densityOpacity, lo, hi);
    const ref = dataset.imageRef;
    const sx = ref?.scale?.[0] ?? 1;
    const sy = ref?.scale?.[1] ?? 1;
    const layer: ImageLayer = this.viewer!.addImage(
      { kind: 'typed', width: meta.cols, height: meta.rows, channels: 4, dtype: 'uint8', data: rgba },
      {
        name: `density · ${view.transcriptAllGenes ? 'all genes' : genes.join(', ')}`,
        scale: [meta.gridSize[0] * sx, meta.gridSize[1] * sy],
        translate: [
          meta.origin[0] * sx + (ref?.translate?.[0] ?? 0),
          meta.origin[1] * sy + (ref?.translate?.[1] ?? 0),
        ],
        blending: 'translucent',
        interpolation: 'nearest',
      },
    );
    this.keys.set('density', key);
    this.replace('density', layer);
    this.host.densityChanged?.(this.densityStats);
  }

  private countsCache: { key: string; counts: Promise<SpatialTranscriptCounts> } | null = null;

  /**
   * Transcripts in view for the visible genes: each gene's dataset total times the share
   * of the tissue on screen. An estimate — expression is not uniform — which is also what
   * Xenium Explorer shows; it tells the user whether the budget will force grouping.
   */
  private async planEstimate(
    dataset: SpatialDataset, view: SpatialViewState, viewer: Viewer, w: number, h: number,
    stale: () => boolean,
  ): Promise<void> {
    const tiles = dataset.transcriptTiles;
    if (!tiles || !this.port.getTranscriptCounts || view.transcriptMode === 'off') {
      this.host.estimateChanged?.(null);
      return;
    }
    const hiddenGenes = new Set(view.transcriptHiddenGenes);
    const genes = view.transcriptAllGenes ? [] : view.transcriptGenes.filter((g) => !hiddenGenes.has(g));
    const key = `${dataset.id}|${genes.join(',')}`;
    if (this.countsCache?.key !== key) {
      this.countsCache = { key, counts: this.port.getTranscriptCounts(genes) };
    }
    let counts: SpatialTranscriptCounts;
    try {
      counts = await this.countsCache.counts;
    } catch {
      this.countsCache = null;
      return;
    }
    if (stale()) return;
    const inView = visibleDataRect(viewer.camera.center, viewer.camera.zoom, w, h, dataset.imageRef, 0);
    if (!inView) return;
    const b = counts.bounds;
    const share = Math.min(1, visibleArea(inView, b) / Math.max(1, (b[2] - b[0]) * (b[3] - b[1])));
    const selected = view.transcriptAllGenes
      ? counts.total
      : genes.reduce((sum, g) => sum + (counts.counts[g] ?? 0), 0);
    this.host.estimateChanged?.({ points: Math.round(selected * share), max: view.transcriptBudget });
  }

  /** The density window in use and the densest bin, for the panel's threshold control. */
  densityStats: { lo: number; hi: number; max: number } | null = null;

  // ── layer bookkeeping ─────────────────────────────────────────────────────────────

  /**
   * Fetch every tile, drawing what arrived. A failure does not fail the view, but it marks the
   * plan incomplete: the caller must not cache it as done, and `plan()` retries it.
   */
  private async fetchAll<K, T>(keys: K[], load: (k: K) => Promise<T>): Promise<T[]> {
    const settled = await Promise.allSettled(keys.map(load));
    const out: T[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') out.push(s.value);
      else console.warn('[napari-js] spatial tile failed', s.reason);
    }
    if (out.length < keys.length) this.planIncomplete = true;
    return out;
  }

  /**
   * Put a shapes layer in place for `group`: a geometry change builds a new layer, a
   * colour-only change mutates values/colormap on the existing one.
   */
  private upsertShapes(
    group: Group, wanted: boolean, geometryChanged: boolean, rings: SpatialPolygons,
    opts: Parameters<Viewer['addShapes']>[2] & object,
  ): void {
    if (!wanted) {
      this.drop(group);
      return;
    }
    const existing = this.layers.get(group) as ShapesLayer | undefined;
    if (existing && !geometryChanged && this.viewer!.layers.items.includes(existing)) {
      // Flat colour has no values; clearing them is what switches the layer to `color`.
      existing.values = opts.values ?? null;
      if (opts.colormap) existing.colormap = opts.colormap;
      if (opts.contrastLimits) existing.contrastLimits = opts.contrastLimits;
      if (opts.color) existing.color = opts.color;
      if (opts.opacity !== undefined) existing.opacity = opts.opacity;
      this.viewer!.requestRender();
      return;
    }
    const layer = this.viewer!.addShapes(rings.coords, rings.offsets, opts);
    this.replace(group, layer);
  }

  /**
   * Install `layer` as `group`'s layer and restore the order of the groups above it.
   * The layer was just added by the caller (so it is on top); groups that belong above
   * it are removed and re-added.
   */
  private replace(group: Group, layer: Layer): void {
    const v = this.viewer!;
    const old = this.layers.get(group);
    if (old && old !== layer && v.layers.items.includes(old)) v.layers.remove(old);
    this.layers.set(group, layer);
    for (const g of ORDER.slice(ORDER.indexOf(group) + 1)) {
      const above = this.layers.get(g);
      if (!above || !v.layers.items.includes(above)) continue;
      v.layers.remove(above);
      v.layers.add(above);
    }
    v.requestRender();
  }

  private drop(group: Group): void {
    const layer = this.layers.get(group);
    if (layer && this.viewer?.layers.items.includes(layer)) this.viewer.layers.remove(layer);
    this.layers.delete(group);
    this.keys.delete(group);
  }

  private dropCells(): void {
    this.drop('cellFill');
    this.drop('cellOutline');
    this.drop('nucleusOutline');
    this.currentNuclei = null;
    this.cellGeometryKey = null;
    this.cellStyleKey = null;
    this.currentRings = null;
    this.setPolygonsShown(false);
  }

  private setPolygonsShown(shown: boolean): void {
    if (shown === this.polygonsShown) return;
    this.polygonsShown = shown;
    this.host.polygonsShownChanged(shown);
  }
}

/** What the transcript layer currently shows — what hovering needs to name a marker. */
interface DrawnTranscripts {
  kind: TranscriptJob['kind'];
  bin?: TranscriptJob['bin'];
  merged: SpatialTranscriptTile;
  /** Marker radius per entry, in observation units. */
  radius: Float32Array;
  genes: string[];
  ref: SpatialImageRef | null;
  /** For a grouped gene selection: each entry's group, and the groups' names. */
  entryGroup?: Int32Array;
  groupNames?: string[];
  /** Each group's genes, when the markers came from the density grids (for the hover). */
  groupGenes?: string[][];
  /** Lazily built spatial index: bucket → entry indices. */
  grid: { size: number; buckets: Map<number, number[]> } | null;
}

/** Index of the entry under `(x, y)` — within its own radius or `tolerance` — or -1. */
export function pickNearest(
  d: Pick<DrawnTranscripts, 'merged' | 'radius' | 'grid'>, x: number, y: number, tolerance: number,
): number {
  const t = d.merged;
  if (!d.grid) {
    let maxR = 0;
    for (let i = 0; i < t.count; i++) if (d.radius[i] > maxR) maxR = d.radius[i];
    const size = Math.max(maxR * 2, tolerance * 2, 1e-6);
    const buckets = new Map<number, number[]>();
    for (let i = 0; i < t.count; i++) {
      const k = bucketKey(Math.floor(t.x[i] / size), Math.floor(t.y[i] / size));
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = []));
      b.push(i);
    }
    d.grid = { size, buckets };
  }
  const { size, buckets } = d.grid;
  const gx = Math.floor(x / size);
  const gy = Math.floor(y / size);
  let best = -1;
  let bestD = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const i of buckets.get(bucketKey(gx + dx, gy + dy)) ?? []) {
        const dist = Math.hypot(t.x[i] - x, t.y[i] - y);
        if (dist <= Math.max(d.radius[i], tolerance) && dist < bestD) {
          bestD = dist;
          best = i;
        }
      }
    }
  }
  return best;
}

function bucketKey(gx: number, gy: number): number {
  return (gx + 32768) * 65536 + (gy + 32768);
}

/** Rings whose owning cell is in a switched-off group removed. */
export function filterRings(
  rings: SpatialPolygonTile, hidden: { codes: Uint16Array; hidden: Uint8Array } | null,
): SpatialPolygonTile {
  if (!hidden) return rings;
  const keep: number[] = [];
  let vertices = 0;
  for (let i = 0; i < rings.count; i++) {
    const code = hidden.codes[rings.observation[i]];
    if (code !== NO_CATEGORY && hidden.hidden[code]) continue;
    keep.push(i);
    vertices += rings.offsets[i + 1] - rings.offsets[i];
  }
  if (keep.length === rings.count) return rings;
  const observation = new Uint32Array(keep.length);
  const offsets = new Uint32Array(keep.length + 1);
  const coords = new Float32Array(vertices * 2);
  let v = 0;
  keep.forEach((i, r) => {
    observation[r] = rings.observation[i];
    offsets[r] = v;
    const a = rings.offsets[i] * 2;
    const b = rings.offsets[i + 1] * 2;
    coords.set(rings.coords.subarray(a, b), v * 2);
    v += (b - a) / 2;
  });
  offsets[keep.length] = v;
  return { count: keep.length, observation, offsets, coords };
}

/** Slots (indices into the selected genes) switched off with their eye toggle. */
function hiddenGeneSlots(view: SpatialViewState): Uint8Array | null {
  if (!view.transcriptHiddenGenes.length) return null;
  const off = new Set(view.transcriptHiddenGenes);
  return Uint8Array.from(view.transcriptGenes, (g) => (off.has(g) ? 1 : 0));
}

/** Entries in a hidden group's cell, or of a hidden gene, removed (with their sizes). */
export function filterTranscripts(
  t: SpatialTranscriptTile, px: Float32Array,
  hidden: { codes: Uint16Array; hidden: Uint8Array } | null, hiddenGenes: Uint8Array | null,
): { merged: SpatialTranscriptTile; px: Float32Array } {
  if (!hidden && !hiddenGenes) return { merged: t, px };
  const keep: number[] = [];
  for (let i = 0; i < t.count; i++) {
    if (hiddenGenes && hiddenGenes[t.gene[i]]) continue;
    const o = t.observation[i];
    if (hidden && o !== NO_OBSERVATION) {
      const code = hidden.codes[o];
      if (code !== NO_CATEGORY && hidden.hidden[code]) continue;
    }
    keep.push(i);
  }
  const pick = <T extends Float32Array | Uint32Array | Uint16Array>(a: T): T => {
    const out = new (a.constructor as new (n: number) => T)(keep.length);
    keep.forEach((i, k) => { out[k] = a[i]; });
    return out;
  };
  return {
    merged: {
      count: keep.length, aggregated: t.aggregated, x: pick(t.x), y: pick(t.y), z: pick(t.z),
      weight: pick(t.weight), observation: pick(t.observation), gene: pick(t.gene),
    },
    px: pick(px),
  };
}

function median(v: Float32Array): number {
  if (!v.length) return 0;
  const step = Math.max(1, Math.floor(v.length / 1024));
  const sample: number[] = [];
  for (let i = 0; i < v.length; i += step) sample.push(v[i]);
  sample.sort((a, b) => a - b);
  return sample[sample.length >> 1];
}

/** Concatenate tiles' rings into one set, dropping rings already seen (a cell straddling
 *  two tiles may be listed by both). */
export function mergePolygonTiles(tiles: SpatialPolygonTile[]): SpatialPolygonTile {
  const seen = new Set<number>();
  let rings = 0;
  let vertices = 0;
  for (const t of tiles) {
    for (let i = 0; i < t.count; i++) {
      if (seen.has(t.observation[i])) continue;
      seen.add(t.observation[i]);
      rings++;
      vertices += t.offsets[i + 1] - t.offsets[i];
    }
  }
  seen.clear();
  const observation = new Uint32Array(rings);
  const offsets = new Uint32Array(rings + 1);
  const coords = new Float32Array(vertices * 2);
  let r = 0;
  let v = 0;
  for (const t of tiles) {
    for (let i = 0; i < t.count; i++) {
      const o = t.observation[i];
      if (seen.has(o)) continue;
      seen.add(o);
      observation[r] = o;
      offsets[r] = v;
      const a = t.offsets[i] * 2;
      const b = t.offsets[i + 1] * 2;
      coords.set(t.coords.subarray(a, b), v * 2);
      v += (b - a) / 2;
      r++;
    }
  }
  offsets[rings] = v;
  return { count: rings, observation, offsets, coords };
}

/** Concatenate transcript tiles, stopping at `limit` entries. */
export function mergeTranscriptTiles(tiles: SpatialTranscriptTile[], limit = Infinity): SpatialTranscriptTile {
  let n = 0;
  for (const t of tiles) n += t.count;
  n = Math.min(n, limit);
  const out: SpatialTranscriptTile = {
    count: n,
    aggregated: tiles.some((t) => t.aggregated),
    x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
    weight: new Uint32Array(n), observation: new Uint32Array(n), gene: new Uint16Array(n),
  };
  let o = 0;
  for (const t of tiles) {
    const k = Math.min(t.count, n - o);
    if (k <= 0) break;
    for (const f of ['x', 'y', 'z', 'weight', 'observation', 'gene'] as const) {
      (out[f] as Float32Array).set((t[f] as Float32Array).subarray(0, k), o);
    }
    o += k;
  }
  return out;
}

/**
 * One marker per (cluster, `bin` square) from per-cluster density grids: the counts of the grid
 * cells inside `area` summed per square, at their count-weighted centre. `slots[c]` is the gene
 * slot whose icon cluster c's markers take.
 */
export function clusterMarkers(
  rasters: SpatialDensityRaster[], slots: number[], bin: number, area: DataRect,
): { tile: SpatialTranscriptTile; group: Int32Array } {
  const x: number[] = [];
  const y: number[] = [];
  const w: number[] = [];
  const gene: number[] = [];
  const group: number[] = [];
  rasters.forEach((r, c) => {
    const [cw, ch] = r.meta.gridSize;
    const [ox, oy] = r.meta.origin;
    const { rows, cols } = r.meta;
    const c0 = Math.max(0, Math.floor((area.x0 - ox) / cw));
    const c1 = Math.min(cols - 1, Math.floor((area.x1 - ox) / cw));
    const r0 = Math.max(0, Math.floor((area.y0 - oy) / ch));
    const r1 = Math.min(rows - 1, Math.floor((area.y1 - oy) / ch));
    const squares = new Map<number, { n: number; sx: number; sy: number }>();
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const v = r.values[row * cols + col];
        if (!(v > 0)) continue;
        const cx = ox + (col + 0.5) * cw;
        const cy = oy + (row + 0.5) * ch;
        const key = Math.floor((cy - oy) / bin) * 1e6 + Math.floor((cx - ox) / bin);
        const s = squares.get(key) ?? { n: 0, sx: 0, sy: 0 };
        s.n += v;
        s.sx += v * cx;
        s.sy += v * cy;
        squares.set(key, s);
      }
    }
    for (const s of squares.values()) {
      x.push(s.sx / s.n);
      y.push(s.sy / s.n);
      w.push(Math.round(s.n));
      gene.push(slots[c]);
      group.push(c);
    }
  });
  const n = w.length;
  return {
    tile: {
      count: n, aggregated: true,
      x: Float32Array.from(x), y: Float32Array.from(y), z: new Float32Array(n),
      weight: Uint32Array.from(w), observation: new Uint32Array(n).fill(NO_OBSERVATION),
      gene: Uint16Array.from(gene),
    },
    group: Int32Array.from(group),
  };
}
