import { Colormap, colormapFromLut } from 'napari-js';
import type { ImageLayer, Layer, RGBA, ShapesLayer, Viewer } from 'napari-js';

import type { Rgb } from '../../contracts/colormap-lut';
import type { SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import type { SpatialViewState } from '../../contracts/display-types';
import {
  NO_CATEGORY, NO_OBSERVATION, SpatialColumn, SpatialDataset, SpatialPolygonTile, SpatialPolygons,
  SpatialTranscriptTile, isCategoricalColumn,
} from '../../contracts/spatial-dataset.contract';
import {
  DEFAULT_CATEGORICAL_PALETTE, MISSING_COLOR, contrastWindow, parseHex, resolveCategoryColors,
} from '../../spatial/spatial-encoding';
import { SpatialSelectionMask } from '../../spatial/spatial-selection';
import {
  DataRect, POLYGON_LEVEL_MIN_CELL_PX, TileKey, TranscriptGlyph, cellTypeColumnFor, cellsShown,
  colorDensity,
  defaultGlyphFor, discreteColormapStops, glyphOutline, glyphRings, pixelsPerDataUnit,
  polygonLevelFor, smoothRaster, tileId, tilesInRect, transcriptLevelFor, transcriptMarkerPx,
  typicalCellDiameter, visibleDataRect,
} from '../../spatial/spatial-tiles';

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
}

type Group = 'density' | 'cellFill' | 'cellOutline' | 'transcripts' | 'transcriptOutline';
const ORDER: Group[] = ['cellFill', 'cellOutline', 'density', 'transcripts', 'transcriptOutline'];

/** Transcripts drawn at once. Past this a screen is solid colour anyway; the level
 *  policy keeps a normal view far below it. */
const MAX_TRANSCRIPTS = 400_000;
const MAX_CELL_TILES = 48;
const MAX_TRANSCRIPT_TILES = 36;
const CAMERA_IDLE_MS = 120;

const UNASSIGNED_RGBA: RGBA = [0.62, 0.62, 0.62, 0.55];

export class NapariSpatialTileLayers {
  private viewer: Viewer | null = null;
  private cameraOff: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private token = 0;
  private readonly layers = new Map<Group, Layer>();
  /** What each group currently shows, so an unchanged plan is a no-op. */
  private readonly keys = new Map<Group, string>();
  private polygonsShown = false;
  /** Rings currently drawn and the (dataset, set, tiles) they came from. */
  private currentRings: SpatialPolygonTile | null = null;
  private cellGeometryKey: string | null = null;
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

  detach(): void {
    this.cameraOff?.();
    this.cameraOff = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.token++;
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
      void this.plan();
    }, delay);
  }

  private async plan(): Promise<void> {
    const viewer = this.viewer;
    const latest = this.host.latest();
    if (!viewer || !latest) return;
    const [dataset, view, selection] = latest;
    const token = ++this.token;
    const stale = () => token !== this.token || this.viewer !== viewer;

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

    await Promise.all([
      this.planDensity(dataset, view, stale),
      this.planCells(dataset, view, selection, rect, pxPerUnit, stale),
      this.planTranscripts(dataset, view, rect, pxPerUnit, stale),
    ]);
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

    let rings: SpatialPolygonTile;
    let geometryKey: string;
    if (tiled) {
      const set = view.cellSet && tiled.sets.some((s) => s.name === view.cellSet)
        ? view.cellSet : (tiled.defaultSet ?? tiled.sets[0]?.name);
      if (!set) return;
      const keys = tilesInRect(rect, level, tiled.levels, tiled.bounds, MAX_CELL_TILES);
      geometryKey = `${dataset.id}|${set}|${keys.map(tileId).join(',')}`;
      if (geometryKey === this.cellGeometryKey && this.currentRings) {
        rings = this.currentRings;
      } else {
        const tiles = await this.fetchAll(keys, (k) => this.port.getPolygonTile!(set, k.level, k.gx, k.gy));
        if (stale()) return;
        rings = mergePolygonTiles(tiles);
      }
    } else {
      geometryKey = `${dataset.id}|whole`;
      if (geometryKey === this.cellGeometryKey && this.currentRings) {
        rings = this.currentRings;
      } else {
        const polys: SpatialPolygons = await this.port.getPolygons!();
        if (stale()) return;
        // Whole-dataset rings are index-aligned with the observations.
        rings = { ...polys, observation: Uint32Array.from({ length: polys.count }, (_v, i) => i) };
      }
    }

    const geometryChanged = geometryKey !== this.cellGeometryKey;
    const styleKey = [
      geometryKey, JSON.stringify(view.colorBy), this.cellTypeColumnName(dataset, view),
      this.selectionRev(selection), view.logScale, view.percentileClip.join(),
      JSON.stringify(view.continuousColormap), view.cellDraw, view.cellOpacity,
    ].join('|');
    const present = ['cellFill', 'cellOutline'].some((g) => {
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
    this.cellGeometryKey = geometryKey;
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
  private async cellColors(
    dataset: SpatialDataset, view: SpatialViewState, selection: SpatialSelectionMask,
    owners: Uint32Array,
  ): Promise<{ values: Float32Array; colormap: Colormap; contrastLimits: [number, number] }> {
    const muted = selection.count > 0 ? selection.mask : null;
    // The explicit colour source wins; otherwise the cell type.
    const colorBy = view.colorBy;
    if (colorBy?.kind === 'feature' || (colorBy?.kind === 'column'
      && dataset.columns.find((c) => c.name === colorBy.name)?.kind === 'continuous')) {
      const raw = colorBy.kind === 'feature'
        ? await this.port.getFeatureVector(colorBy.name)
        : ((await this.port.getColumn(colorBy.name)) as { values: Float32Array }).values;
      const values = new Float32Array(owners.length);
      for (let i = 0; i < owners.length; i++) {
        const v = raw[owners[i]] ?? NaN;
        values[i] = view.logScale ? Math.log1p(Math.max(0, v)) : v;
      }
      const [lo, hi] = contrastWindow(
        view.logScale ? raw.map((v) => Math.log1p(Math.max(0, v))) : raw,
        view.percentileClip[0], view.percentileClip[1],
      );
      return {
        values,
        colormap: colormapFromLut('spatial-continuous', this.host.continuousLut(view)),
        contrastLimits: [lo, hi],
      };
    }
    const column = colorBy?.kind === 'column' ? colorBy.name : this.cellTypeColumnName(dataset, view);
    const codes = column ? await this.categoricalCodes(column) : null;
    const { colormap, valueOf } = this.categoricalColormap(codes?.meta ?? null);
    const values = new Float32Array(owners.length);
    for (let i = 0; i < owners.length; i++) {
      const o = owners[i];
      const code = !codes || (muted && !muted[o]) ? -1 : codes.codes[o];
      values[i] = valueOf(code === NO_CATEGORY ? -1 : code);
    }
    return { values, colormap, contrastLimits: [0, 1] };
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

  // ── transcripts ───────────────────────────────────────────────────────────────────

  private async planTranscripts(
    dataset: SpatialDataset, view: SpatialViewState, rect: DataRect, pxPerUnit: number,
    stale: () => boolean,
  ): Promise<void> {
    const meta = dataset.transcriptTiles;
    const mode = view.transcriptMode;
    const genes = view.transcriptGenes;
    if (!meta || !this.port.getTranscriptTile || (mode !== 'circles' && mode !== 'glyphs') || !genes.length) {
      this.drop('transcripts');
      this.drop('transcriptOutline');
      return;
    }
    const level = transcriptLevelFor(pxPerUnit, meta.levels);
    const keys = tilesInRect(rect, level, meta.levels, meta.bounds, MAX_TRANSCRIPT_TILES);
    // Marker sizes follow the zoom, so the zoom is part of the key; a pan that keeps
    // the same tiles on screen changes nothing.
    const planKey = [
      dataset.id, mode, genes.join(','), view.transcriptQuality, view.transcriptColorBy,
      this.cellTypeColumnName(dataset, view), view.transcriptScale, view.transcriptOpacity,
      JSON.stringify(view.transcriptGlyphs), pxPerUnit.toPrecision(4), keys.map(tileId).join(','),
    ].join('|');
    const current = this.layers.get('transcripts');
    if (planKey === this.keys.get('transcripts') && current && this.viewer!.layers.items.includes(current)) {
      return;
    }
    const query = { genes, quality: view.transcriptQuality };
    const tiles = await this.fetchAll(keys, (k) => this.port.getTranscriptTile!(k.level, k.gx, k.gy, query));
    if (stale()) return;
    const merged = mergeTranscriptTiles(tiles, MAX_TRANSCRIPTS);

    // Colours: the cell type of the owning cell, or the gene.
    const faces = await this.transcriptColors(dataset, view, merged);
    if (stale()) return;

    // Marker size is chosen in SCREEN pixels and converted at the current zoom; a
    // camera change re-plans, so markers keep their on-screen size across zooms.
    // Physical where the unit is known (µm), clamped to a screen-pixel range.
    const pxPerMicron = dataset.micronsPerUnit ? pxPerUnit / dataset.micronsPerUnit : undefined;
    const diam = new Float32Array(merged.count);
    for (let i = 0; i < merged.count; i++) {
      diam[i] = transcriptMarkerPx(merged.weight[i], view.transcriptScale, pxPerMicron) / pxPerUnit;
    }
    const ref = dataset.imageRef;
    this.keys.set('transcripts', planKey);
    const scale: [number, number] = ref?.scale ?? [1, 1];
    const translate: [number, number] = ref?.translate ?? [0, 0];
    if (mode === 'circles') {
      this.drop('transcriptOutline');
      const positions = new Float32Array(merged.count * 2);
      for (let i = 0; i < merged.count; i++) {
        positions[2 * i] = merged.x[i];
        positions[2 * i + 1] = merged.y[i];
      }
      const layer = this.viewer!.addPoints(positions, {
        name: 'transcripts',
        size: diam,
        faceColor: faces.rgba,
        // A dark rim: a transcript coloured by its cell's type is otherwise the same
        // colour as the cell fill it sits on, and vanishes into it.
        borderColor: [0.04, 0.04, 0.05, 0.9],
        borderWidth: 0.18 * median(diam),
        opacity: view.transcriptOpacity,
        scale,
        translate,
      });
      this.replace('transcripts', layer);
      return;
    }

    // Glyphs: each entry becomes its gene's icon polygon, filled through a discrete
    // colormap and outlined dark so small icons stay readable over the tissue.
    const glyphFor = (slot: number): TranscriptGlyph =>
      (view.transcriptGlyphs[genes[slot]] as TranscriptGlyph | undefined) ?? defaultGlyphFor(slot);
    const outlines = genes.map((_g, slot) => glyphOutline(glyphFor(slot)));
    const radius = diam.map((d) => d / 2);
    const { coords, offsets } = glyphRings(merged.x, merged.y, radius, (i) => outlines[merged.gene[i]]);
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

  /** Per-entry colours both as RGBA (points) and as colormap values (glyph shapes). */
  private async transcriptColors(
    dataset: SpatialDataset, view: SpatialViewState, t: SpatialTranscriptTile,
  ): Promise<{ rgba: RGBA[]; values: Float32Array; colormap: Colormap }> {
    let rgb: Rgb[];
    let codeOf: (i: number) => number;
    if (view.transcriptColorBy === 'gene') {
      rgb = view.transcriptGenes.map((_g, i) =>
        parseHex(DEFAULT_CATEGORICAL_PALETTE[i % DEFAULT_CATEGORICAL_PALETTE.length]));
      codeOf = (i) => t.gene[i];
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
    const meta = dataset.density;
    if (!meta || !this.port.getDensity || view.transcriptMode !== 'density' || !view.transcriptGenes.length) {
      this.drop('density');
      return;
    }
    const lut = this.host.continuousLut(view);
    const key = [dataset.id, view.transcriptGenes.join(','), view.densityOpacity,
      view.logScale, lut.length, lut[0]?.join(), lut[lut.length - 1]?.join()].join('|');
    if (key === this.keys.get('density') && this.layers.has('density')) return;
    const raster = await this.port.getDensity(view.transcriptGenes);
    if (stale()) return;

    const { rows, cols } = meta;
    // ~1.5 raster cells: about a cell diameter at Xenium's 10 µm grid.
    const smooth = smoothRaster(raster.values, rows, cols, 1.5);
    const rgba = colorDensity(smooth, lut, view.densityOpacity);
    const ref = dataset.imageRef;
    const sx = ref?.scale?.[0] ?? 1;
    const sy = ref?.scale?.[1] ?? 1;
    const layer: ImageLayer = this.viewer!.addImage(
      { kind: 'typed', width: cols, height: rows, channels: 4, dtype: 'uint8', data: rgba },
      {
        name: `density · ${view.transcriptGenes.join(', ')}`,
        scale: [meta.gridSize[0] * sx, meta.gridSize[1] * sy],
        translate: [
          meta.origin[0] * sx + (ref?.translate?.[0] ?? 0),
          meta.origin[1] * sy + (ref?.translate?.[1] ?? 0),
        ],
        blending: 'translucent',
      },
    );
    this.keys.set('density', key);
    this.replace('density', layer);
  }

  // ── layer bookkeeping ─────────────────────────────────────────────────────────────

  private async fetchAll<T>(keys: TileKey[], load: (k: TileKey) => Promise<T>): Promise<T[]> {
    const settled = await Promise.allSettled(keys.map(load));
    const out: T[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') out.push(s.value);
      else console.warn('[napari-js] spatial tile failed', s.reason);
    }
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
      if (opts.values) existing.values = opts.values;
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
