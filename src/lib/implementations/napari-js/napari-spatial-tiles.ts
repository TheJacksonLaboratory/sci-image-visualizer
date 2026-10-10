import { Colormap } from 'napari-js';
import type { Layer, RGBA, Viewer } from 'napari-js';

import type { Rgb } from '../../contracts/colormap-lut';
import { ALL_GENES, type SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import type { SpatialViewState } from '../../contracts/display-types';
import {
  NO_CATEGORY, NO_OBSERVATION, SpatialDataset, SpatialTranscriptTile,
} from '../../contracts/spatial-dataset.contract';
import {
  DEFAULT_CATEGORICAL_PALETTE, MISSING_COLOR, parseHex, resolveCategoryColors,
} from '../../spatial/spatial-encoding';
import { SpatialSelectionMask } from '../../spatial/spatial-selection';
import { DataRect, cellTypeColumnFor, pixelsPerDataUnit, visibleDataRect } from '../../spatial/lod';
import { clusterColorMap } from '../../spatial/transcript-grouping';
import { TranscriptGlyph, defaultGlyphFor, glyphOutline, glyphRings } from '../../spatial/glyphs';
import { discreteColormapStops } from '../../spatial/density-raster';
import { filterTranscripts, hiddenGeneSlots, median } from '../../spatial/spatial-tile-merge';
import { CategoricalLookup } from './spatial-tiles/categorical-lookup';
import { LoadTracker, PlanContext } from './spatial-tiles/plan-context';
import { OrderedLayerGroups, TILE_LAYER_ORDER, TileGroup } from './spatial-tiles/layer-groups';
import { TranscriptHover } from './spatial-tiles/transcript-hover';
import { CellLayers } from './spatial-tiles/cell-layers';
import { TranscriptJobPlanner, groupSelection } from './spatial-tiles/transcript-jobs';
import {
  DensityLayer, DensityStats, TranscriptEstimate, TranscriptEstimator,
} from './spatial-tiles/density-layer';

export type { TranscriptEstimate } from './spatial-tiles/density-layer';

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
 * re-adding: cell fill, cell outline, the transcript density, then transcripts on top. Each
 * removal disposes the layer's GPU visual (re-uploaded on the next frame), so a plan restores
 * the order once, after all its groups are in place, and moves only the layers that are out
 * of place ({@link restoreOrder}). `LayerList.move` in napari-js would remove the re-upload.
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
  densityChanged?(stats: DensityStats): void;
  /** Estimated transcripts in view for the current selection, against the budget. */
  estimateChanged?(estimate: TranscriptEstimate | null): void;
  /** Transcripts of each selected gene inside the view, or null when not known. */
  geneCountsChanged?(counts: Record<string, number> | null): void;
  /** The layers whose data is in flight now ("Transcripts", "Cells"…); empty when none. */
  loadingChanged?(layers: string[]): void;
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
  /** Consecutive retries of an incomplete view. */
  private tileRetries = 0;
  private token = 0;
  /** The overlays' layers, one per group, in their fixed order. */
  private readonly groups = new OrderedLayerGroups<TileGroup>(TILE_LAYER_ORDER);

  /** Loads in flight, per layer label, for the loading badge. */
  private readonly loads = new LoadTracker((labels) => this.host.loadingChanged?.(labels));

  /** The loaded per-gene transcripts the in-view counts are taken from. */
  private countSource: { merged: SpatialTranscriptTile; genes: string[] } | null = null;

  // density + estimate

  private readonly lookup: CategoricalLookup;
  private readonly jobs: TranscriptJobPlanner;
  private readonly density: DensityLayer;
  private readonly cells: CellLayers;
  private readonly estimator: TranscriptEstimator;
  private readonly hover: TranscriptHover;

  constructor(private readonly port: SpatialDataPort, private readonly host: SpatialTileHost) {
    this.lookup = new CategoricalLookup(port);
    this.jobs = new TranscriptJobPlanner(port);
    this.cells = new CellLayers(port, this.groups, this.lookup, host);
    this.density = new DensityLayer(port, this.groups, (stats) => host.densityChanged?.(stats));
    this.estimator = new TranscriptEstimator(port, (estimate) => host.estimateChanged?.(estimate));
    this.hover = new TranscriptHover(port, () => {
      return this.groups.shown('transcripts');
    });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────

  attach(viewer: Viewer): void {
    if (this.viewer === viewer) return;
    this.detach();
    this.viewer = viewer;
    this.groups.attach(viewer);
    this.cameraOff = viewer.camera.changed.connect(() => this.schedule());
  }

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

  /**
   * Tooltip lines for the transcript marker under world point `(wx, wy)`, or null; the
   * server's details arrive through `onDetails` once the pointer rests (see TranscriptHover).
   */
  hoverAt(wx: number, wy: number, radiusWorld: number, onDetails: (lines: string[]) => void): string[] | null {
    return this.hover.hoverAt(wx, wy, radiusWorld, onDetails);
  }

  /** Whether `layer` is one of the overlays drawn here (density, cells, transcripts). */
  owns(layer: Layer): boolean {
    return this.groups.owns(layer);
  }

  detach(): void {
    this.hover.dispose();
    this.cameraOff?.();
    this.cameraOff = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.token++;
    this.tileRetries = 0;
    this.countSource = null;
    this.loads.clear();
    this.groups.detach();
    this.cells.detached();
    this.viewer = null;
  }

  /** True while outlines are on screen — the service hides its dots then. */
  get outlinesShown(): boolean {
    return this.cells.outlinesShown;
  }

  /** The density window in use and the densest bin, for the panel's threshold control. */
  get densityStats(): DensityStats | null {
    return this.density.stats;
  }

  /** Dataset, view or selection changed: re-plan now rather than on camera idle. */
  refresh(): void {
    this.schedule(0);
  }

  /** Called right after the service adds its marker layer: everything goes back on top. */
  afterObservations(): void {
    this.groups.restoreOrder(true);
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
    const ctx = new PlanContext(() => token !== this.token || this.viewer !== viewer, this.loads);

    if (!dataset) {
      this.groups.dropAll();
      this.cells.drop();
      return;
    }
    const [w, h] = this.host.canvasSize();
    const ref = dataset.imageRef;
    const rect = visibleDataRect(viewer.camera.center, viewer.camera.zoom, w, h, ref);
    const pxPerUnit = pixelsPerDataUnit(viewer.camera.zoom, ref);
    if (!rect) return;

    this.estimator.plan(dataset, view, viewer, w, h, ctx)
      .catch((err) => console.warn('[napari-js] transcript estimate failed', err));
    // A group whose request failed (a column, a feature vector, a density grid) leaves the
    // others drawn and marks the plan incomplete, so it is retried like a failed tile.
    const settle = (group: string, work: Promise<void>) => work.catch((err) => {
      console.warn(`[napari-js] spatial ${group} plan failed`, err);
      ctx.markIncomplete();
    });
    await Promise.all([
      settle('density', this.density.plan(dataset, view, ctx)),
      settle('cells', this.cells.plan(dataset, view, selection, rect, pxPerUnit, ctx)),
      settle('transcripts', this.planTranscripts(dataset, view, rect, pxPerUnit, ctx)),
    ]);
    this.groups.restoreOrder(false);
    if (ctx.stale()) return;
    this.host.geneCountsChanged?.(this.geneCountsIn(rect));
    // A tile that failed left a hole the cache keys do not record, so try the same view
    // again, backing off, a bounded number of times.
    if (!ctx.incomplete) {
      this.tileRetries = 0;
    } else if (this.tileRetries < MAX_TILE_RETRIES) {
      this.schedule(TILE_RETRY_MS * 2 ** this.tileRetries++);
    }
  }

  // ── transcripts ───────────────────────────────────────────────────────────────────

  private async planTranscripts(
    dataset: SpatialDataset, view: SpatialViewState, rect: DataRect, pxPerUnit: number,
    ctx: PlanContext,
  ): Promise<void> {
    const mode = view.transcriptMode;
    const job = this.jobs.jobFor(dataset, view, rect, pxPerUnit);
    if (!job) {
      this.groups.drop('transcripts');
      this.groups.drop('transcriptOutline');
      this.hover.clear();
      this.countSource = null;
      return;
    }
    // Marker sizes follow the zoom, so the zoom is part of the key; a pan that keeps
    // the same tiles on screen changes nothing.
    const planKey = [
      dataset.id, mode, job.key, view.transcriptColorBy, cellTypeColumnFor(dataset, view),
      view.transcriptScale, view.transcriptOpacity, JSON.stringify(view.transcriptGlyphs),
      pxPerUnit.toPrecision(4), view.hiddenGroups.join('\u0001'), view.transcriptHiddenGenes.join(','),
      JSON.stringify(view.transcriptGeneColors), JSON.stringify(view.transcriptGeneGroups),
    ].join('|');
    if (planKey === this.groups.key('transcripts') && this.groups.shown('transcripts')) {
      return;
    }
    const loaded = await ctx.track('Transcripts', job.load(ctx));
    if (ctx.stale()) return;
    // Per-gene counts in view come from what was loaded, before hidden genes are dropped:
    // a hidden gene still has transcripts there. Summed density grids (no per-gene levels,
    // zoomed out) hold clusters, not genes: no per-gene counts there, rather than a guess.
    this.countSource = (loaded.kind ?? job.kind) === 'genes' && !loaded.clustered
      ? { merged: loaded.merged, genes: [...view.transcriptGenes] } : null;
    const hidden = await this.lookup.hiddenCodes(dataset, view);
    if (ctx.stale()) return;
    // Density-grid markers carry no cells and were built from the visible genes only.
    const filtered = loaded.clustered ? { merged: loaded.merged, px: loaded.px }
      : filterTranscripts(loaded.merged, loaded.px, hidden,
        (loaded.kind ?? job.kind) === 'genes' ? hiddenGeneSlots(view) : null);
    let { merged, px } = filtered;
    let selectionBin: number | null = loaded.clustered?.bin ?? null;
    let entryGroup: Int32Array | null = loaded.clustered?.group ?? null;
    let groupNames: string[] | null = loaded.clustered?.names ?? null;
    if (loaded.ladder) {
      const g = groupSelection(merged, view, loaded.ladder, pxPerUnit);
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
    if (ctx.stale()) return;

    if (ctx.incomplete) this.groups.forgetKey('transcripts');
    else this.groups.setKey('transcripts', planKey);
    const diam = px.map((d) => d / pxPerUnit);
    this.hover.setDrawn({
      kind: loaded.kind ?? job.kind,
      bin: selectionBin ? { size: selectionBin, origin: loaded.clustered?.origin ?? [0, 0] }
        : (loaded.kind ? loaded.bin : job.bin),
      merged, radius: diam.map((d) => d / 2),
      genes: [...view.transcriptGenes], ref: dataset.imageRef ?? null, grid: null,
      ...(entryGroup && groupNames ? { entryGroup, groupNames } : {}),
      ...(loaded.clustered ? { groupGenes: loaded.clustered.genes } : {}),
    }, dataset.micronsPerUnit ?? null);
    const typeColumn = cellTypeColumnFor(dataset, view);
    this.hover.setTypes(typeColumn ? await this.lookup.codes(typeColumn).catch(() => null) : null);
    if (ctx.stale()) return;
    const ref = dataset.imageRef;
    const place: Placement = { scale: ref?.scale ?? [1, 1], translate: ref?.translate ?? [0, 0] };
    if (mode === 'circles') {
      this.groups.drop('transcriptOutline');
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
    this.groups.replace('transcripts', layer);
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
    this.groups.replace('transcripts', fill);
    // A dark rim keeps a few large icons readable over the tissue; on many small ones the
    // rims merge into a solid dark sheet that hides every colour, so they are left off.
    const medianPx = median(diam) * pxPerUnit;
    if (merged.count > GLYPH_OUTLINE_MAX || medianPx < GLYPH_OUTLINE_MIN_PX) {
      this.groups.drop('transcriptOutline');
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
    this.groups.replace('transcriptOutline', edge);
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
      const name = cellTypeColumnFor(dataset, view);
      const codes = name ? await this.lookup.codes(name).catch(() => null) : null;
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
      const name = cellTypeColumnFor(dataset, view);
      const codes = name ? await this.lookup.codes(name) : null;
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

}
