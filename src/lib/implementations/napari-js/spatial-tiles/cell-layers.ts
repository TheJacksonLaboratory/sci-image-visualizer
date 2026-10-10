import { Colormap, colormapFromLut } from 'napari-js';
import type { RGBA } from 'napari-js';

import type { Rgb } from '../../../contracts/colormap-lut';
import type { SpatialDataPort } from '../../../contracts/ports/spatial-data.port';
import type { SpatialViewState } from '../../../contracts/display-types';
import {
  NO_CATEGORY, SpatialColumn, SpatialDataset, SpatialPolygonTile, SpatialPolygons, isCategoricalColumn,
} from '../../../contracts/spatial-dataset.contract';
import {
  DEFAULT_CATEGORICAL_PALETTE, MISSING_COLOR, contrastWindow, parseHex, resolveCategoryColors,
} from '../../../spatial/spatial-encoding';
import { SpatialSelectionMask } from '../../../spatial/spatial-selection';
import {
  DataRect, POLYGON_LEVEL_MIN_CELL_PX, cellTypeColumnFor, cellsShown, polygonLevelFor, tileId, tilesInRect,
  typicalCellDiameter,
} from '../../../spatial/lod';
import { discreteColormapStops } from '../../../spatial/density-raster';
import { filterRings, mergePolygonTiles } from '../../../spatial/spatial-tile-merge';
import type { CategoricalLookup, HiddenCodes } from './categorical-lookup';
import type { OrderedLayerGroups, TileGroup } from './layer-groups';
import type { PlanContext } from './plan-context';

const MAX_CELL_TILES = 48;

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

  constructor(
    private readonly port: SpatialDataPort,
    private readonly groups: OrderedLayerGroups<TileGroup>,
    private readonly lookup: CategoricalLookup,
    private readonly host: CellLayersHost,
  ) {}

  /** True while outlines are on screen — the service hides its dots then. */
  get outlinesShown(): boolean {
    return this.polygonsShown;
  }

  /** The viewer went away (its layers with it): the outlines are no longer shown. */
  detached(): void {
    this.setPolygonsShown(false);
  }

  /** Draw the cells covering `rect` at the level `pxPerUnit` calls for, or drop them. */
  async plan(
    dataset: SpatialDataset, view: SpatialViewState, selection: SpatialSelectionMask,
    rect: DataRect, pxPerUnit: number, ctx: PlanContext,
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
      : (pxPerUnit * diameter >= POLYGON_LEVEL_MIN_CELL_PX[2] ? 0 : -1);
    if (level < 0) {
      this.drop();
      return;
    }

    // Groups switched off in the list: their cells are left out of the geometry.
    const hidden = await this.lookup.hiddenCodes(dataset, view);
    if (ctx.stale()) return;
    const label = view.cellSet === 'both' ? 'Cells and nuclei'
      : view.cellSet === 'nucleus' ? 'Nuclei' : 'Cells';
    const geometry = await ctx.track(label, this.cellGeometry(dataset, view, rect, level, hidden, ctx));
    if (!geometry) return;
    const { rings, nuclei, geometryKey } = geometry;

    const geometryChanged = geometryKey !== this.cellGeometryKey;
    const styleKey = [
      geometryKey, view.cellColorMode, view.cellColorGene, view.cellSingleColor,
      cellTypeColumnFor(dataset, view),
      this.selectionRev(selection), view.logScale, view.percentileClip.join(),
      JSON.stringify(view.continuousColormap), view.cellDraw, view.cellOpacity,
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
    const ref = dataset.imageRef;
    const common = { scale: ref?.scale ?? [1, 1], translate: ref?.translate ?? [0, 0] } as const;
    const fill = view.cellDraw !== 'outline';
    const outline = view.cellDraw !== 'fill';

    this.groups.upsertShapes('cellFill', fill, geometryChanged, rings, {
      name: 'cells', draw: 'fill', opacity: view.cellOpacity, ...colors, ...common,
    });
    this.groups.upsertShapes('cellOutline', outline, geometryChanged, rings, fill
      // Over a fill, a dark outline separates neighbours of the same type.
      ? { name: 'cell outlines', draw: 'outline', color: [0.08, 0.08, 0.1, 1], opacity: 0.7, ...common }
      : { name: 'cell outlines', draw: 'outline', opacity: 1, ...colors, ...common });
    // "Both": nuclei outlined over the cells, light so they read against any fill.
    if (nuclei) {
      this.groups.upsertShapes('nucleusOutline', true, geometryChanged, nuclei, {
        name: 'nucleus outlines', draw: 'outline', color: [0.95, 0.95, 0.98, 1], opacity: 0.8, ...common,
      });
    } else {
      this.groups.drop('nucleusOutline');
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
      : cellTypeColumnFor(dataset, view);
    const codes = name ? await this.lookup.codes(name) : null;
    const { colormap, valueOf } = this.categoricalColormap(codes?.meta ?? null);
    const values = new Float32Array(owners.length);
    for (let i = 0; i < owners.length; i++) {
      const o = owners[i];
      const code = !codes || (muted && !muted[o]) ? -1 : codes.codes[o];
      values[i] = valueOf(code === NO_CATEGORY ? -1 : code);
    }
    return { values, colormap, contrastLimits: [0, 1] };
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
    hidden: HiddenCodes | null, ctx: PlanContext,
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
          { ...polys, observation: Uint32Array.from({ length: polys.count }, (_v, i) => i) }, hidden,
        );
      }
    }
    return { rings, nuclei, geometryKey };
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
