import type { ImageLayer, Viewer } from 'napari-js';

import { ALL_GENES, type SpatialDataPort } from '../../../contracts/ports/spatial-data.port';
import type { SpatialViewState } from '../../../contracts/display-types';
import type { SpatialDataset, SpatialTranscriptCounts } from '../../../contracts/spatial-dataset.contract';
import { lutFor } from '../../../spatial/spatial-encoding';
import { visibleArea, visibleDataRect } from '../../../spatial/lod';
import { INFERNO_SCALE, colorDensityWindow, densityAutoRange } from '../../../spatial/density-raster';
import type { OrderedLayerGroups, TileGroup } from './layer-groups';
import type { PlanContext } from './plan-context';

/** The density window in use and the densest bin (transcripts per unit area). */
export interface DensityStats {
  lo: number;
  hi: number;
  max: number;
}

/** Xenium Explorer's "Estimated Transcript Points". */
export interface TranscriptEstimate {
  /** Transcripts of the visible genes estimated to be in view. */
  points: number;
  /** The marker budget. */
  max: number;
}

/**
 * The transcript density image of the 2D spatial view: the visible genes' summed density
 * raster, coloured through the view's window and colormap, one layer in the `density` group.
 */
export class DensityLayer {
  /** The density window in use and the densest bin, for the panel's threshold control. */
  stats: DensityStats | null = null;

  constructor(
    private readonly port: SpatialDataPort,
    private readonly groups: OrderedLayerGroups<TileGroup>,
    private readonly changed: (stats: DensityStats) => void,
  ) {}

  /** Draw the view's density, or drop it; an unchanged (genes, bin, window, colormap) is a no-op. */
  async plan(dataset: SpatialDataset, view: SpatialViewState, ctx: PlanContext): Promise<void> {
    const hiddenGenes = new Set(view.transcriptHiddenGenes);
    const genes = view.transcriptAllGenes ? [ALL_GENES] : view.transcriptGenes.filter((g) => !hiddenGenes.has(g));
    if (!dataset.density || !this.port.getDensity || view.transcriptMode !== 'density' || !genes.length) {
      this.groups.drop('density');
      this.stats = null;
      return;
    }
    const lut = lutFor(view.densityColormap ?? INFERNO_SCALE);
    const key = [
      dataset.id,
      genes.join(','),
      view.densityBin,
      view.densityOpacity,
      JSON.stringify(view.densityRange),
      JSON.stringify(view.densityColormap),
    ].join('|');
    if (key === this.groups.key('density') && this.groups.has('density')) return;
    const raster = await ctx.track('Transcript density', this.port.getDensity(genes, view.densityBin));
    if (ctx.stale()) return;

    // Bins drawn as squares, as Xenium Explorer does; the window is in transcripts/µm².
    const meta = raster.meta;
    const area = meta.gridSize[0] * meta.gridSize[1];
    const perArea = raster.values.map((v) => v / area);
    const [lo, hi] = view.densityRange ?? densityAutoRange(perArea);
    this.stats = { lo, hi, max: perArea.reduce((m, v) => (v > m ? v : m), 0) };
    const rgba = colorDensityWindow(perArea, lut, view.densityOpacity, lo, hi);
    const ref = dataset.imageRef;
    const sx = ref?.scale?.[0] ?? 1;
    const sy = ref?.scale?.[1] ?? 1;
    const layer: ImageLayer = this.groups.viewer!.addImage(
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
    this.groups.setKey('density', key);
    this.groups.replace('density', layer);
    this.changed(this.stats);
  }
}

/**
 * Transcripts in view for the visible genes, against the marker budget — it tells the user
 * whether the budget will force grouping. Caches the per-gene dataset totals for the latest
 * gene set.
 */
export class TranscriptEstimator {
  /** Per-gene dataset totals for the in-view estimate, for the latest gene set. */
  private countsCache: { key: string; counts: Promise<SpatialTranscriptCounts> } | null = null;

  constructor(
    private readonly port: SpatialDataPort,
    private readonly changed: (estimate: TranscriptEstimate | null) => void,
  ) {}

  /**
   * Transcripts in view for the visible genes: each gene's dataset total times the share
   * of the tissue on screen. An estimate — expression is not uniform — which is also what
   * Xenium Explorer shows; it tells the user whether the budget will force grouping.
   */
  async plan(
    dataset: SpatialDataset,
    view: SpatialViewState,
    viewer: Viewer,
    w: number,
    h: number,
    ctx: PlanContext,
  ): Promise<void> {
    const tiles = dataset.transcriptTiles;
    if (!tiles || !this.port.getTranscriptCounts || view.transcriptMode === 'off') {
      this.changed(null);
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
    if (ctx.stale()) return;
    const inView = visibleDataRect(viewer.camera.center, viewer.camera.zoom, w, h, dataset.imageRef, 0);
    if (!inView) return;
    const b = counts.bounds;
    const share = Math.min(1, visibleArea(inView, b) / Math.max(1, (b[2] - b[0]) * (b[3] - b[1])));
    const selected = view.transcriptAllGenes
      ? counts.total
      : genes.reduce((sum, g) => sum + (counts.counts[g] ?? 0), 0);
    this.changed({ points: Math.round(selected * share), max: view.transcriptBudget });
  }
}
