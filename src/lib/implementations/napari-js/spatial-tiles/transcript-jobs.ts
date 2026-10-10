import { LruCache } from 'napari-js';

import { ALL_GENES, type SpatialDataPort } from '../../../contracts/ports/spatial-data.port';
import type { SpatialViewState } from '../../../contracts/display-types';
import {
  SpatialBounds, SpatialDataset, SpatialDensityRaster, SpatialTranscriptTile,
} from '../../../contracts/spatial-dataset.contract';
import { DataRect, tileId, tilesInRect, tilesInRectFrom, transcriptLevelFor } from '../../../spatial/lod';
import {
  allGenesPlan, clipTranscripts, geneBinSize, groupTranscripts, groupedMarkerPx, quantileOf, transcriptMarkerPx,
} from '../../../spatial/transcript-grouping';
import { clusterMarkers, mergeTranscriptTiles } from '../../../spatial/spatial-tile-merge';
import type { PlanContext } from './plan-context';
import type { TranscriptBin, TranscriptKind } from './transcript-hover';

/** The all-gene pyramid's finest bin (250 µm source tiles / 128) and default level count, used
 *  to group a gene selection on the same ladder when a dataset has no pyramid. */
const PYRAMID_BASE_BIN_UM = 250 / 128;
const PYRAMID_LEVELS = 7;
/** Transcripts drawn at once. Past this a screen is solid colour anyway; the level
 *  policy keeps a normal view far below it. */
const MAX_TRANSCRIPTS = 400_000;
const MAX_TRANSCRIPT_TILES = 36;
const MAX_BIN_TILES = 64;
/** Summed per-cluster density grids kept (one per cluster × bin × dataset). */
const DENSITY_CACHE_SIZE = 256;

/** A transcript fetch the planner can key before running. */
export interface TranscriptJob {
  /** What one entry is — decides what hovering it says. */
  kind: TranscriptKind;
  /** For bins: their size and grid origin, so a hovered bin's square can be recovered. */
  bin?: TranscriptBin;
  /** Identifies what will be drawn, so an unchanged plan is a no-op. */
  key: string;
  /** Fetch and merge; `px` is each entry's marker diameter in screen pixels. A job may
   *  switch to another kind once it sees the data (individual → bins); it then says so. */
  load(ctx: PlanContext): Promise<TranscriptLoad>;
}

export interface TranscriptLoad {
  merged: SpatialTranscriptTile;
  px: Float32Array;
  /** For a gene selection: group it on this bin ladder once hidden genes are dropped. */
  ladder?: { baseBin: number; levels: number; start: number | null };
  /** Already one marker per cluster per bin (zoomed out, from the density grids): no cells. */
  clustered?: { group: Int32Array; names: string[]; genes: string[][]; bin: number; origin: [number, number] };
  kind?: TranscriptJob['kind'];
  bin?: TranscriptJob['bin'];
}

/**
 * Decides which transcripts the 2D spatial view fetches, at which level, for the current
 * camera and selection: a {@link TranscriptJob} that can be keyed before it runs (so an
 * unchanged plan is a no-op) and that fetches and merges when run.
 *
 * Pure apart from the port, so the level policy is testable without a viewer. Owns the
 * cache of summed per-cluster density grids a zoomed-out gene selection is drawn from.
 */
export class TranscriptJobPlanner {
  /** Summed per-cluster density grids (see densityFor). */
  private readonly densityCache = new LruCache<Promise<SpatialDensityRaster>>(DENSITY_CACHE_SIZE);

  constructor(private readonly port: SpatialDataPort) {}

  /**
   * The job that draws the view's transcripts as markers (circles or icons), or null when the
   * view draws none or the port cannot serve them.
   */
  jobFor(
    dataset: SpatialDataset, view: SpatialViewState, rect: DataRect, pxPerUnit: number,
  ): TranscriptJob | null {
    const mode = view.transcriptMode;
    if (mode !== 'circles' && mode !== 'glyphs') return null;
    const geneBins = this.port.getTranscriptGeneBins && dataset.transcriptGeneBins;
    if (!this.port.getTranscriptTile && !geneBins) return null;
    return view.transcriptAllGenes
      ? this.allGenesJob(dataset, view, rect, pxPerUnit)
      : this.geneJob(dataset, view, rect, pxPerUnit);
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
    const pxPerMicron = pxPerMicronOf(dataset, pxPerUnit);
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
        + `${clipKey(rect, mx, my)}|${keysAt(first).map(tileId)}`,
      load: async (ctx) => {
        // The zoom's own level only: over the budget, the transcripts are combined into
        // larger markers (groupSelection), never fetched from slower coarse levels.
        const tiles = await ctx.fetchAll(keysAt(first),
          (k) => this.port.getTranscriptTile!(k.level, k.gx, k.gy, query));
        // Only what is on screen (and a margin, so a small pan needs nothing new) counts
        // against the budget and the cap; a tile reaches far past the view.
        const merged = mergeTranscriptTiles(tiles.map((t) => clipTranscripts(t, around)), MAX_TRANSCRIPTS);
        const px = Float32Array.from(merged.weight,
          (w) => transcriptMarkerPx(w, view.transcriptScale, pxPerMicron));
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
        + clipKey(rect, mx, my),
      load: async (ctx) => {
        let m = first;
        for (;;) {
          const tiles = await ctx.fetchAll(keysAt(m),
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
   * Least-recently-USED eviction, so the clusters in view stay cached; a failed request is
   * dropped so the next plan asks again.
   */
  private densityFor(dataset: string, genes: string[], bin: number): Promise<SpatialDensityRaster> {
    const key = `${dataset}|${bin}|${genes.join(',')}`;
    let p = this.densityCache.get(key);
    if (!p) {
      const request = this.port.getDensity!(genes, bin);
      request.catch(() => {
        if (this.densityCache.get(key) === request) this.densityCache.delete(key);
      });
      this.densityCache.set(key, request);
      p = request;
    }
    return p;
  }

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
        + clipKey(rect, mx, my),
      load: async () => {
        let bin = first;
        for (;;) {
          // The finer grid gives each marker its centre; the server bins 1, 2, 4 or 8 cells.
          const fine = Math.min(bin >= grid * 2 ? bin / 2 : bin, grid * 8);
          const rasters = await Promise.all(clusters.map((c) => this.densityFor(dataset.id, c.genes, fine)));
          const out = clusterMarkers(rasters, clusters.map((c) => c.slot), bin, around);
          if (out.tile.count <= budget || bin >= grid * 2 ** 12) {
            const px = groupedSizes(out.tile.weight, bin * pxPerUnit, view.transcriptScale);
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
      const pxPerMicron = pxPerMicronOf(dataset, pxPerUnit);
      return {
        kind: 'individual',
        key: `all|individual|${view.transcriptBudget}|${boxes.map((b) => b.join(',')).join(';')}`,
        load: async (ctx) => {
          const got = await ctx.fetchAll(keys.map((k, i) => ({ ...k, box: boxes[i] })),
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
              return { ...(await job.load(ctx)), kind: job.kind, bin: job.bin };
            }
          }
          const merged = mergeTranscriptTiles(got, cap);
          // One transcript per entry: every marker is the same size.
          const px = new Float32Array(merged.count).fill(transcriptMarkerPx(1, view.transcriptScale, pxPerMicron));
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
      load: async (ctx) => {
        const got = await ctx.fetchAll(keys, (k) => this.port.getTranscriptBins!(k.level, k.gx, k.gy));
        const merged = mergeTranscriptTiles(got, Math.max(view.transcriptBudget * 1.5, 1));
        return { merged, px: groupedSizes(merged.weight, lv.binSize * pxPerUnit, view.transcriptScale) };
      },
    };
  }
}

/**
 * Group a gene selection for the zoom: one marker per gene-tree cluster (a gene in no
 * cluster is its own) per bin of the pyramid ladder, starting at the finest bin whose
 * markers are 14 px apart and stepping up while the markers would exceed the budget.
 * Null to draw every transcript: zoomed in, with the selection within the budget.
 */
export function groupSelection(
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
  const px = groupedSizes(grouped.tile.weight, bin * pxPerUnit, view.transcriptScale);
  return { merged: grouped.tile, px, bin, group: grouped.group, names };
}

/** Screen sizes of grouped markers: by weight against the 95th-percentile weight, over `binPx`. */
function groupedSizes(weight: Uint32Array, binPx: number, scale: number): Float32Array {
  const refCount = quantileOf(weight, 0.95);
  return Float32Array.from(weight, (w) => groupedMarkerPx(w, refCount, binPx, scale));
}

/** The clip window in quarter-view steps, for a job key: a pan past the margin re-clips. */
function clipKey(rect: DataRect, mx: number, my: number): string {
  return `${Math.floor(rect.x0 / (mx || 1))},${Math.floor(rect.y0 / (my || 1))}`;
}

/** Physical marker size needs µm; undefined when the dataset's unit is unknown. */
function pxPerMicronOf(dataset: SpatialDataset, pxPerUnit: number): number | undefined {
  return dataset.micronsPerUnit ? pxPerUnit / dataset.micronsPerUnit : undefined;
}
