import { colormapFromLut, mapScalarRGBA } from 'napari-js';
import type { Colormap, RGBA } from 'napari-js';

import type { Rgb } from '../../../contracts/colormap-lut';
import type { SpatialDataPort } from '../../../contracts/ports/spatial-data.port';
import type { SpatialViewState } from '../../../contracts/display-types';
import {
  NO_CATEGORY,
  SpatialColumn,
  SpatialDataset,
  SpatialPolygonTile,
  SpatialPolygons,
  isCategoricalColumn,
} from '../../../contracts/spatial-dataset.contract';
import {
  DEFAULT_CATEGORICAL_PALETTE,
  MISSING_COLOR,
  GroupColorOverrides,
  categoryColorsFor,
  contrastWindow,
  parseHex,
} from '../../../spatial/spatial-encoding';
import { SpatialSelectionMask } from '../../../spatial/spatial-selection';
import {
  DataRect,
  POLYGON_LEVEL_MIN_CELL_PX,
  cellTypeColumnFor,
  cellsShown,
  drawnCellSets,
  polygonLevelFor,
  tileId,
  tilesInRect,
  typicalCellDiameter,
} from '../../../spatial/lod';
import { filterRings, mergePolygonTiles } from '../../../spatial/spatial-tile-merge';
import { observationIndex, planeCellRings } from '../../../spatial/plane-cells';
import type { RegionSource } from '../../../region-source/region-source';
import { regionLevelFor, regionTileId, regionTilesInRect } from '../../../region-source/region-tiles';
import { geneFilterKey } from '../../../spatial/spatial-gene-filter';
import { ContrastWindowCache } from '../napari-spatial-encoding';
import type { CategoricalLookup, HiddenCodes } from './categorical-lookup';
import type { OrderedLayerGroups, TileGroup } from './layer-groups';
import type { PlanContext } from './plan-context';

const MAX_CELL_TILES = 48;

/** The cells' colours as a shapes layer takes them: per-shape RGBA, values over a colormap, or
 *  one colour. */
export interface CellColors {
  values?: Float32Array;
  colormap?: Colormap;
  contrastLimits?: [number, number];
  color?: RGBA;
  faceColor?: Float32Array;
}

/** What the cell layers need from the service. */
export interface CellLayersHost {
  /** The continuous LUT the view is using (so cells coloured by a gene match the markers). */
  continuousLut(view: SpatialViewState): Rgb[];
  /** Outlines appeared or disappeared: the markers' visibility follows. */
  polygonsShownChanged(shown: boolean): void;
}

/**
 * The cell outlines of the 2D spatial view, at the polygon level the zoom calls for: a fill,
 * an outline or both (plus nucleus outlines for the "both" cell set), coloured by the view's
 * cell-colour mode, with switched-off groups left out of the geometry.
 *
 * Geometry and style are keyed apart, so a recolour (a new cell-type column, a selection)
 * rewrites the per-shape values of the existing layers and never re-expands the rings.
 */
export class CellLayers {
  private polygonsShown = false;
  /** Rings currently drawn and the (dataset, set, tiles) they came from. */
  private currentRings: SpatialPolygonTile | null = null;
  private cellGeometryKey: string | null = null;
  private currentNuclei: SpatialPolygonTile | null = null;
  private cellStyleKey: string | null = null;
  /** Selection identity → revision, so a change key can name a selection cheaply. */
  private lastSelection: SpatialSelectionMask | null = null;
  private selectionRevision = 0;
  /** Continuous colourings' windows, per (vector, clip, log): `contrastWindow` sorts every
   *  value, and a selection or opacity change recolours with the vector unchanged (SPATIAL-12). */
  private readonly contrastWindows = new ContrastWindowCache();
  /**
   * The plane of a 3D segmentation the view shows (see {@link setPlane}), or null: every set draws
   * its own tiles.
   */
  private plane: number | null = null;
  /** The region set opened for a boundary set's per-plane outlines: its id and the source. */
  private planeSource: { id: string; source: Promise<RegionSource> } | null = null;

  constructor(
    private readonly port: SpatialDataPort,
    private readonly groups: OrderedLayerGroups<TileGroup>,
    private readonly lookup: CategoricalLookup,
    private readonly host: CellLayersHost,
  ) {}

  /** True while outlines are on screen. */
  get outlinesShown(): boolean {
    return this.polygonsShown;
  }

  /**
   * Show plane `plane` (an index into the region set's planes) of a 3D segmentation, or none: a
   * boundary set that names its region set (`regionSource`, a cell outlined on every plane it spans)
   * then draws that plane's outlines, rather than one outline per cell, so the cells follow the
   * slice. Its cells keep the view's colouring, groups and selection.
   */
  setPlane(plane: number | null): void {
    this.plane = plane;
  }

  /** Close the region set opened for the per-plane outlines. */
  dispose(): void {
    const opened = this.planeSource;
    this.planeSource = null;
    void opened?.source.then(
      (s) => s.dispose(),
      () => undefined,
    );
  }

  /** The viewer went away (its layers with it): the outlines are no longer shown. */
  detached(): void {
    this.setPolygonsShown(false);
  }

  /** Draw the cells covering `rect` at the level `pxPerUnit` calls for, or drop them. */
  async plan(
    dataset: SpatialDataset,
    view: SpatialViewState,
    selection: SpatialSelectionMask,
    rect: DataRect,
    pxPerUnit: number,
    ctx: PlanContext,
  ): Promise<void> {
    const tiled = dataset.polygonTiles;
    const whole = !tiled && dataset.polygons && this.port.getPolygons;
    if (!cellsShown(dataset, view) || (!tiled && !whole)) {
      this.drop();
      return;
    }
    const diameter = typicalCellDiameter(dataset.observations.radius);
    // Whole-dataset rings have one level and no coarser fallback, so they are drawn as
    // soon as a cell is big enough to read as a shape rather than a dot.
    const level = tiled
      ? polygonLevelFor(pxPerUnit, diameter, tiled.levels.length)
      : pxPerUnit * diameter >= POLYGON_LEVEL_MIN_CELL_PX[2]
        ? 0
        : -1;
    if (level < 0) {
      this.drop();
      return;
    }

    // Groups switched off in the list: their cells are left out of the geometry.
    const hidden = await this.lookup.hiddenCodes(dataset, view);
    if (ctx.stale()) return;
    const label = view.cellSet === 'both' ? 'Cells and nuclei' : view.cellSet === 'nucleus' ? 'Nuclei' : 'Cells';
    const geometry = await ctx.track(label, this.cellGeometry(dataset, view, rect, level, hidden, ctx, pxPerUnit));
    if (!geometry) return;
    const { rings, nuclei, geometryKey } = geometry;

    const geometryChanged = geometryKey !== this.cellGeometryKey;
    const styleKey = [
      geometryKey,
      view.cellColorMode,
      view.cellColorGene,
      view.cellColorMode === 'column' ? JSON.stringify(view.colorBy) : '',
      view.cellSingleColor,
      cellTypeColumnFor(dataset, view),
      this.selectionRev(selection),
      view.logScale,
      view.percentileClip.join(),
      JSON.stringify(view.continuousColormap),
      view.cellDraw,
      view.cellOpacity,
      // Any grouping's: the cells may be coloured by segmentation method rather than the cell type.
      JSON.stringify(view.groupColors),
    ].join('|');
    const present = (['cellFill', 'cellOutline', 'nucleusOutline'] as const).some((g) => this.groups.shown(g));
    if (!geometryChanged && styleKey === this.cellStyleKey && present) {
      this.setPolygonsShown(true);
      return;
    }
    const colors = await this.cellColors(dataset, view, selection, rings.observation);
    if (ctx.stale()) return;

    this.currentRings = rings;
    this.currentNuclei = nuclei;
    // A geometry missing a failed tile is drawn but not remembered, so the retry refetches it.
    this.cellGeometryKey = ctx.incomplete ? null : geometryKey;
    this.cellStyleKey = styleKey;
    this.drawCells(dataset, view, geometry, colors, geometryChanged);
    this.setPolygonsShown(true);
  }

  /**
   * The cell layers: the fill and the outline the view's draw mode asks for, and with "both" the
   * nucleus outlines over them. A geometry change builds new layers; a style change restyles them.
   */
  private drawCells(
    dataset: SpatialDataset,
    view: SpatialViewState,
    { rings, nuclei }: { rings: SpatialPolygonTile; nuclei: SpatialPolygonTile | null },
    colors: CellColors,
    geometryChanged: boolean,
  ): void {
    const ref = dataset.imageRef;
    const common = { scale: ref?.scale ?? [1, 1], translate: ref?.translate ?? [0, 0] } as const;
    const fill = view.cellDraw !== 'outline';
    const outline = view.cellDraw !== 'fill';

    this.groups.upsertShapes('cellFill', fill, geometryChanged, rings, {
      name: 'cells',
      draw: 'fill',
      opacity: view.cellOpacity,
      ...colors,
      ...common,
    });
    this.groups.upsertShapes(
      'cellOutline',
      outline,
      geometryChanged,
      rings,
      fill
        ? // Over a fill, a dark outline separates neighbours of the same type.
          { name: 'cell outlines', draw: 'outline', color: [0.08, 0.08, 0.1, 1], opacity: 0.7, ...common }
        : { name: 'cell outlines', draw: 'outline', opacity: 1, ...colors, ...common },
    );
    // "Both": nuclei outlined over the cells, light so they read against any fill.
    if (nuclei) {
      this.groups.upsertShapes('nucleusOutline', true, geometryChanged, nuclei, {
        name: 'nucleus outlines',
        draw: 'outline',
        color: [0.95, 0.95, 0.98, 1],
        opacity: 0.8,
        ...common,
      });
    } else {
      this.groups.drop('nucleusOutline');
    }
  }

  private selectionRev(selection: SpatialSelectionMask): number {
    if (selection !== this.lastSelection) {
      this.lastSelection = selection;
      this.selectionRevision++;
    }
    return this.selectionRevision;
  }

  /**
   * The rings' colours by their owners, by the view's cell-colour mode (Xenium Explorer's "Cell
   * Color"): one RGBA per shape for a grouping, values + colormap for a measurement, one colour
   * for "single". A selection mutes what it leaves out.
   */
  private async cellColors(
    dataset: SpatialDataset,
    view: SpatialViewState,
    selection: SpatialSelectionMask,
    owners: Uint32Array,
  ): Promise<CellColors> {
    return cellColorsFor(
      {
        port: this.port,
        lookup: this.lookup,
        contrastWindows: this.contrastWindows,
        continuousLut: (v) => this.host.continuousLut(v),
      },
      dataset,
      view,
      selection,
      owners,
    );
  }

  /**
   * The cell rings (and, for "both", the nucleus rings) covering `rect` at `level`, minus
   * the hidden groups — reused when nothing that decides them changed. Null when the
   * view went stale or the dataset has no set to draw.
   */
  private async cellGeometry(
    dataset: SpatialDataset,
    view: SpatialViewState,
    rect: DataRect,
    level: number,
    hidden: HiddenCodes | null,
    ctx: PlanContext,
    pxPerUnit = 1,
  ): Promise<{ rings: SpatialPolygonTile; nuclei: SpatialPolygonTile | null; geometryKey: string } | null> {
    const tiled = dataset.polygonTiles;
    const hiddenKey = `${view.hiddenGroups.join('\u0001')}|${geneFilterKey(view)}`;
    let rings: SpatialPolygonTile;
    let nuclei: SpatialPolygonTile | null = null;
    let geometryKey: string;
    if (tiled) {
      const drawn = drawnCellSets(tiled, view.cellSet);
      if (!drawn) return null;
      const { set, nucleusSet } = drawn;
      const regionSource = tiled.sets.find((s) => s.name === set)?.regionSource;
      if (!nucleusSet && regionSource && this.plane !== null) {
        const onPlane = await this.planeGeometry(
          dataset,
          set,
          regionSource,
          rect,
          pxPerUnit,
          hidden,
          hiddenKey,
          ctx,
        );
        if (onPlane !== undefined) return onPlane;
      }
      const keys = tilesInRect(rect, level, tiled.levels, tiled.bounds, MAX_CELL_TILES);
      geometryKey = `${dataset.id}|${set}|${nucleusSet ?? ''}|${hiddenKey}|${keys.map(tileId).join(',')}`;
      if (geometryKey === this.cellGeometryKey && this.currentRings) {
        rings = this.currentRings;
        nuclei = this.currentNuclei;
      } else {
        const [tiles, nucleusTiles] = await Promise.all([
          ctx.fetchAll(keys, (k) => this.port.getPolygonTile!(set, k.level, k.gx, k.gy)),
          nucleusSet
            ? ctx.fetchAll(keys, (k) => this.port.getPolygonTile!(nucleusSet, k.level, k.gx, k.gy))
            : Promise.resolve(null),
        ]);
        if (ctx.stale()) return null;
        rings = filterRings(mergePolygonTiles(tiles), hidden);
        nuclei = nucleusTiles ? filterRings(mergePolygonTiles(nucleusTiles), hidden) : null;
      }
    } else {
      geometryKey = `${dataset.id}|whole|${hiddenKey}`;
      if (geometryKey === this.cellGeometryKey && this.currentRings) {
        rings = this.currentRings;
      } else {
        const polys: SpatialPolygons = await this.port.getPolygons!();
        if (ctx.stale()) return null;
        // Whole-dataset rings are index-aligned with the observations.
        rings = filterRings(
          { ...polys, observation: Uint32Array.from({ length: polys.count }, (_v, i) => i) },
          hidden,
        );
      }
    }
    return { rings, nuclei, geometryKey };
  }

  /**
   * The cells of boundary set `set` on the plane shown, from its region set (`regionSource`): the
   * plane's tiles meeting `rect`, at the detail the zoom calls for, each outline owned by its cell
   * (by its id among the observations'), minus the hidden groups. Undefined when it cannot be drawn
   * so (no observation ids to tell its cells by, no port to open the set, or a plane it has not), so
   * the set's own tiles are drawn; null when the view went stale.
   */
  private async planeGeometry(
    dataset: SpatialDataset,
    set: string,
    regionSource: string,
    rect: DataRect,
    pxPerUnit: number,
    hidden: HiddenCodes | null,
    hiddenKey: string,
    ctx: PlanContext,
  ): Promise<{ rings: SpatialPolygonTile; nuclei: null; geometryKey: string } | null | undefined> {
    const index = observationIndex(dataset.observations);
    const plane = this.plane;
    if (!index || plane === null || !this.port.openRegionSet) return undefined;
    let source: RegionSource;
    try {
      source = await this.openPlaneSource(regionSource);
    } catch (err) {
      console.warn("[napari-js] the cells' per-plane outlines could not be opened: drawn as one per cell", err);
      return undefined;
    }
    if (ctx.stale()) return null;
    const info = source.info;
    const z = info.planes[plane];
    if (z === undefined) return undefined;
    // The region set's coordinates are the image's pixels: the view's rectangle and zoom in them.
    const ref = dataset.imageRef;
    const [sx, sy] = ref?.scale ?? [1, 1];
    const [tx, ty] = ref?.translate ?? [0, 0];
    const box: [number, number, number, number] = [
      rect.x0 * sx + tx,
      rect.y0 * sy + ty,
      rect.x1 * sx + tx,
      rect.y1 * sy + ty,
    ];
    const level = regionLevelFor(pxPerUnit / Math.abs(sx || 1), info.levels);
    const keys = regionTilesInRect(box, level, info.tileSize, info.bounds, MAX_CELL_TILES);
    const geometryKey = `${dataset.id}|${set}|plane ${plane}|${hiddenKey}|${keys.map(regionTileId).join(',')}`;
    if (geometryKey === this.cellGeometryKey && this.currentRings) {
      return { rings: this.currentRings, nuclei: null, geometryKey };
    }
    const tiles = await ctx.fetchAll(keys, (k) => source.getTile(z, k));
    if (ctx.stale()) return null;
    const rings = filterRings(planeCellRings(tiles, index, ref), hidden);
    return { rings, nuclei: null, geometryKey };
  }

  /** The region set `id`, opened once (another id closes the one before). */
  private openPlaneSource(id: string): Promise<RegionSource> {
    if (this.planeSource?.id !== id) {
      this.dispose();
      const source = this.port.openRegionSet!(id);
      this.planeSource = { id, source };
      // A set that failed to open is asked for again next time.
      source.catch(() => {
        if (this.planeSource?.source === source) this.planeSource = null;
      });
    }
    return this.planeSource!.source;
  }

  /** Remove the cell layers and forget what they showed. */
  drop(): void {
    this.groups.drop('cellFill');
    this.groups.drop('cellOutline');
    this.groups.drop('nucleusOutline');
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

/** What {@link cellColorsFor} reads with: the port, the categorical columns, the windows cache, the LUT. */
export interface CellColorDeps {
  port: SpatialDataPort;
  lookup: CategoricalLookup;
  contrastWindows: ContrastWindowCache;
  continuousLut(view: SpatialViewState): Rgb[];
}

/**
 * The cells' colours by their owners (`owners[i]` the observation of shape i), by the view's
 * cell-colour mode (Xenium Explorer's "Cell Color"): one RGBA per shape for a grouping, values +
 * colormap for a measurement, one colour for "single". A selection mutes what it leaves out. The 2D
 * cell outlines and the 3D cells both colour by it.
 */
export async function cellColorsFor(
  deps: CellColorDeps,
  dataset: SpatialDataset,
  view: SpatialViewState,
  selection: SpatialSelectionMask,
  owners: Uint32Array,
): Promise<CellColors> {
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
    const [clipLo, clipHi] = view.percentileClip;
    // Keyed by the SOURCE vector (the log copy would be new on every call), as the 3D cloud's.
    const [lo, hi] = deps.contrastWindows.get(raw, clipLo, clipHi, log, () =>
      contrastWindow(log ? raw.map((v) => Math.log1p(Math.max(0, v))) : raw, clipLo, clipHi),
    );
    return {
      values,
      colormap: colormapFromLut('spatial-continuous', deps.continuousLut(view)),
      contrastLimits: [lo, hi] as [number, number],
    };
  };
  if (mode === 'gene' && view.cellColorGene) {
    return continuous(await deps.port.getFeatureVector(view.cellColorGene), true);
  }
  // A measurement: the numeric column the observations are coloured by, as the markers are.
  if (mode === 'column' && view.colorBy?.kind === 'column') {
    const column = await deps.port.getColumn(view.colorBy.name);
    if (!isCategoricalColumn(column)) return continuous(column.values, view.logScale);
  }
  if (mode === 'transcriptDensity' && dataset.columns.some((c) => c.name === 'transcript_density')) {
    const column = await deps.port.getColumn('transcript_density');
    if (!isCategoricalColumn(column)) return continuous(column.values, false);
  }

  const name =
    mode === 'segmentation' && dataset.columns.some((c) => c.name === 'segmentation_method')
      ? 'segmentation_method'
      : cellTypeColumnFor(dataset, view);
  const codes = name ? await deps.lookup.codes(name) : null;
  const palette = categoryRgba(name, codes?.meta ?? null, view.groupColors);
  const missing = rgba01(MISSING_COLOR);
  // One RGBA per shape (napari Shapes' `face_color`): any number of categories keeps its own
  // colour, where a colormap band per category ran out of LUT entries past ~127.
  const faceColor = new Float32Array(owners.length * 4);
  for (let i = 0; i < owners.length; i++) {
    const o = owners[i];
    const code = !codes || (muted && !muted[o]) ? NO_CATEGORY : codes.codes[o];
    faceColor.set(palette[code] ?? missing, i * 4);
  }
  return { faceColor };
}

/** {@link cellColorsFor}'s colours as one RGBA (0..1) per shape, `n` shapes. */
export function cellColorsRgba(colors: CellColors, n: number): Float32Array {
  if (colors.faceColor) return colors.faceColor;
  const out = new Float32Array(n * 4);
  if (colors.values && colors.colormap && colors.contrastLimits) {
    const [climLo, climHi] = colors.contrastLimits;
    const opts = { climLo, climHi, gamma: 1, invert: false, colormap: colors.colormap };
    for (let i = 0; i < n; i++) {
      const v = colors.values[i];
      out.set(Number.isFinite(v) ? mapScalarRGBA(v, opts) : [0.5, 0.5, 0.5, 1], i * 4);
    }
    return out;
  }
  const c = colors.color ?? [1, 1, 1, 1];
  for (let i = 0; i < n; i++) out.set(c, i * 4);
  return out;
}

/** An 8-bit RGB as an opaque 0..1 RGBA. */
function rgba01([r, g, b]: readonly [number, number, number]): RGBA {
  return [r / 255, g / 255, b / 255, 1];
}

/** A grouping's category colours, as 0..1 RGBA by category code (one default without a grouping). */
function categoryRgba(
  name: string | null,
  meta: SpatialColumn['meta'] | null,
  overrides: GroupColorOverrides | undefined,
): RGBA[] {
  const hex =
    name && meta && meta.kind === 'categorical'
      ? categoryColorsFor(name, meta, overrides)
      : [DEFAULT_CATEGORICAL_PALETTE[0]];
  return hex.map((h) => rgba01(parseHex(h)));
}
