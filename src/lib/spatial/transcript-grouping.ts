/**
 * Transcript grouping and marker sizing: how many transcripts one marker stands for at the
 * current zoom, how big it is drawn, and which colour each gene-tree cluster takes. Pure, so
 * the budget policy is testable without a viewer.
 */

import type { SpatialBounds, SpatialTranscriptTile } from '../contracts/spatial-dataset.contract';
import { DataRect, visibleArea } from './lod';
import { quantile } from './stats';

/** Smallest on-screen spacing between groups, in px — below it groups read as noise. */
export const GROUP_MIN_SPACING_PX = 14;

/**
 * The bin a selection of genes is grouped into at this zoom, in observation units, or null
 * to draw every transcript. Bins follow the all-gene pyramid's ladder (`baseBin` × 2^m) so a
 * gene selection and "all genes" group alike: the finest bin whose markers land at least
 * `spacingPx` apart on screen. Once the finest bin is that wide, transcripts are drawn as
 * themselves.
 */
export function geneBinSize(
  pxPerUnit: number, baseBin: number, levels = 7, spacingPx = GROUP_MIN_SPACING_PX,
): number | null {
  if (!(pxPerUnit > 0) || !(baseBin > 0)) return null;
  if (baseBin * pxPerUnit >= spacingPx) return null;
  for (let m = 1; m < levels; m++) {
    const bin = baseBin * 2 ** m;
    if (bin * pxPerUnit >= spacingPx) return bin;
  }
  return baseBin * 2 ** (levels - 1);
}

/** The entries of `t` inside `rect` (observation units). */
export function clipTranscripts(t: SpatialTranscriptTile, rect: DataRect): SpatialTranscriptTile {
  const keep: number[] = [];
  for (let i = 0; i < t.count; i++) {
    if (t.x[i] >= rect.x0 && t.x[i] <= rect.x1 && t.y[i] >= rect.y0 && t.y[i] <= rect.y1) keep.push(i);
  }
  if (keep.length === t.count) return t;
  const pick = <A extends Float32Array | Uint32Array | Uint16Array>(a: A): A => {
    const out = new (a.constructor as new (n: number) => A)(keep.length);
    keep.forEach((src, i) => { out[i] = a[src]; });
    return out;
  };
  return {
    count: keep.length, aggregated: t.aggregated,
    x: pick(t.x), y: pick(t.y), z: pick(t.z), weight: pick(t.weight), observation: pick(t.observation),
    gene: pick(t.gene),
  };
}

// ── Grouping ──────────────────────────────────────────────────────────────────────────

/**
 * Group transcripts into `bin`-wide squares of a grid anchored at the origin (so a pan does
 * not move them), one entry per (group, square): `groupOf(gene slot)` says which group a gene
 * is in — its cluster in the gene tree, or itself. Each entry sits at its transcripts'
 * centroid, weighted by how many each stands for; it takes the gene and the cell holding most
 * of them, each summed over all its transcripts in the entry. `group[i]` is entry i's group.
 */
export function groupTranscripts(
  t: SpatialTranscriptTile, bin: number, groupOf: (geneSlot: number) => number = (g) => g,
): { tile: SpatialTranscriptTile; group: Int32Array } {
  // Hot on every pan and zoom, so nothing is allocated per transcript: the (group, square)
  // key is a number over the tile's own bounded extent rather than a template string, and
  // the per-entry gene and cell tallies share two flat maps instead of two Maps per entry.
  const count = t.count;
  const gks = new Int32Array(count);
  let minBx = Infinity;
  let maxBx = -Infinity;
  let minBy = Infinity;
  let maxBy = -Infinity;
  for (let i = 0; i < count; i++) {
    gks[i] = groupOf(t.gene[i]);
    const bx = Math.floor(t.x[i] / bin);
    const by = Math.floor(t.y[i] / bin);
    if (bx < minBx) minBx = bx;
    if (bx > maxBx) maxBx = bx;
    if (by < minBy) minBy = by;
    if (by > maxBy) maxBy = by;
  }
  // One spare column and row for a square that is not finite (a NaN coordinate), so such
  // transcripts still group together rather than colliding with a real square.
  const cols = Number.isFinite(maxBx - minBx) ? maxBx - minBx + 2 : 1;
  const rows = Number.isFinite(maxBy - minBy) ? maxBy - minBy + 2 : 1;
  const col = (v: number): number => {
    const b = Math.floor(v / bin);
    return Number.isFinite(b) ? b - minBx : cols - 1;
  };
  const row = (v: number): number => {
    const b = Math.floor(v / bin);
    return Number.isFinite(b) ? b - minBy : rows - 1;
  };

  const index = new Map<number, number>();
  const sx: number[] = [];
  const sy: number[] = [];
  const sz: number[] = [];
  const w: number[] = [];
  const grp: number[] = [];
  // Per entry, how many transcripts of each gene (the dominant one gives the icon and colour)
  // and in each cell (the dominant one is the entry's cell).
  const genes = new DominantTally();
  const cells = new DominantTally();
  for (let i = 0; i < count; i++) {
    const gk = gks[i];
    const key = (gk * rows + row(t.y[i])) * cols + col(t.x[i]);
    let k = index.get(key);
    const wi = t.weight[i] || 1;
    if (k === undefined) {
      k = w.length;
      index.set(key, k);
      sx.push(0); sy.push(0); sz.push(0); w.push(0);
      grp.push(gk);
    }
    sx[k] += t.x[i] * wi;
    sy[k] += t.y[i] * wi;
    sz[k] += t.z[i] * wi;
    w[k] += wi;
    genes.add(k, t.gene[i], wi);
    cells.add(k, t.observation[i], wi);
  }
  const n = w.length;
  const tile: SpatialTranscriptTile = {
    count: n, aggregated: true,
    x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
    weight: new Uint32Array(n), observation: new Uint32Array(n), gene: new Uint16Array(n),
  };
  const group = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    tile.x[k] = sx[k] / w[k];
    tile.y[k] = sy[k] / w[k];
    tile.z[k] = sz[k] / w[k];
    tile.weight[k] = w[k];
    tile.observation[k] = cells.dominant(k);
    tile.gene[k] = genes.dominant(k);
    group[k] = grp[k];
  }
  return { tile, group };
}

/**
 * Weighted tallies of u32 keys per entry, tracking each entry's dominant key as it goes:
 * the key with the largest total, the first seen on a tie.
 *
 * One map for every entry, keyed `entry · 2^32 + key` — exact while entries stay below
 * 2^21, far above any marker budget.
 */
class DominantTally {
  private static readonly KEY_SPAN = 2 ** 32;
  private readonly total = new Map<number, number>();
  private readonly firstSeen = new Map<number, number>();
  private seq = 0;
  private readonly bestKey: number[] = [];
  private readonly bestTotal: number[] = [];
  private readonly bestSeen: number[] = [];

  add(entry: number, key: number, weight: number): void {
    const id = entry * DominantTally.KEY_SPAN + key;
    const v = (this.total.get(id) ?? 0) + weight;
    this.total.set(id, v);
    let first = this.firstSeen.get(id);
    if (first === undefined) {
      first = this.seq++;
      this.firstSeen.set(id, first);
    }
    const top = this.bestTotal[entry];
    if (top === undefined || v > top || (v === top && first < this.bestSeen[entry])) {
      this.bestKey[entry] = key;
      this.bestTotal[entry] = v;
      this.bestSeen[entry] = first;
    }
  }

  dominant(entry: number): number {
    return this.bestKey[entry] ?? 0;
  }
}

// ── Cluster colours ───────────────────────────────────────────────────────────────────

/**
 * The colour of each gene-tree cluster of a selection, for colouring transcripts by cluster: a
 * cluster named like a group of the cells' grouping takes that group's colour (its cells and its
 * transcripts agree); the others take palette colours in tree order. Clusters are the tree's
 * groups holding a selected gene, then each ungrouped selected gene on its own. Every gene of a
 * cluster gets the same colour — the tree's swatches and the markers use this one map.
 */
export function clusterColorMap(
  genes: readonly string[], groups: readonly { name: string; genes: readonly string[] }[],
  cellColors: ReadonlyMap<string, string>, palette: readonly string[],
): Map<string, string> {
  const chosen = new Set(genes);
  const names: string[] = [];
  const grouped = new Set<string>();
  for (const g of groups) {
    const mine = g.genes.filter((x) => chosen.has(x) && !grouped.has(x));
    if (!mine.length) continue;
    mine.forEach((x) => grouped.add(x));
    names.push(g.name);
  }
  for (const gene of genes) if (!grouped.has(gene)) names.push(gene);
  const out = new Map<string, string>();
  let k = 0;
  for (const name of names) {
    if (out.has(name)) continue;
    out.set(name, cellColors.get(name) ?? palette[k++ % palette.length]);
  }
  return out;
}

/** The cluster a selected gene is in: its first gene-tree group holding it, else itself. */
export function clusterOfGene(
  gene: string, groups: readonly { name: string; genes: readonly string[] }[],
): string {
  return groups.find((g) => g.genes.includes(gene))?.name ?? gene;
}

// ── Marker sizing ─────────────────────────────────────────────────────────────────────

/** Smallest transcript marker, in canvas pixels. */
export const TRANSCRIPT_MIN_PX = 4;
/** Largest transcript marker, in canvas pixels. */
export const TRANSCRIPT_MAX_PX = 32;
/**
 * Physical diameter a single transcript is drawn at, in µm — clearly larger than the
 * imaged spot (~0.3 µm) so it stays legible, and small enough that neighbouring
 * molecules inside one cell stay apart.
 */
export const TRANSCRIPT_PHYSICAL_UM = 1.2;

/**
 * Marker diameter in canvas pixels for an entry standing for `weight` transcripts.
 *
 * The convention spatial viewers share (deck.gl's `radiusMinPixels`/`radiusMaxPixels`,
 * Xenium Explorer's transcript size): a PHYSICAL size, clamped to a screen-pixel range.
 * Zoomed out, markers sit at the minimum and never vanish; zoomed in, they grow with the
 * tissue instead of shrinking to specks next to cells hundreds of pixels wide. A fixed
 * screen size does the opposite at high zoom, which is what made transcripts disappear
 * at pixel-level zoom.
 *
 * Aggregates grow with the cube root of their count: area ∝ count would let one dense
 * aggregate swallow its neighbours, the cube root keeps a 1000-transcript cluster clearly
 * larger than a 10-transcript one without covering the tile.
 *
 * `pxPerMicron` is omitted for data with no known physical unit; the marker is then
 * screen-sized only.
 */
export function transcriptMarkerPx(weight: number, scale = 1, pxPerMicron?: number): number {
  const counted = TRANSCRIPT_MIN_PX * Math.cbrt(Math.max(1, weight));
  const physical = pxPerMicron ? TRANSCRIPT_PHYSICAL_UM * pxPerMicron : 0;
  const px = Math.max(counted, physical) * scale;
  return Math.min(TRANSCRIPT_MAX_PX * Math.max(scale, 1), Math.max(TRANSCRIPT_MIN_PX * scale, px));
}

// ── All-gene transcripts: grouping under a marker budget ─────────────────────────────

/**
 * How "all genes" is drawn at the current zoom: individual transcripts, a bin level, or nothing.
 */
export type AllGenesPlan = { kind: 'individual' } | { kind: 'bins'; level: number } | { kind: 'none' };

/**
 * How to draw every transcript in view without exceeding `budget` markers.
 *
 * - The transcripts themselves, once the estimated count in view fits the budget.
 * - Otherwise the finest pyramid level whose bins are at least `minSpacingPx` apart on
 *   screen and number no more than the budget — groups big enough to read, few enough
 *   to draw.
 *
 * The count in view is estimated from the average density, which over- or under-shoots
 * locally; the renderer still caps what it draws, so an estimate is enough to choose.
 */
export function allGenesPlan(o: {
  rect: DataRect; bounds: SpatialBounds; total: number; pxPerUnit: number;
  levels: readonly { binSize: number }[]; budget: number; canIndividual: boolean;
  minSpacingPx?: number;
}): AllGenesPlan {
  const area = visibleArea(o.rect, o.bounds);
  if (!(area > 0)) return { kind: 'none' };
  const b = o.bounds;
  const density = o.total / Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
  if (o.canIndividual && density * area <= o.budget) return { kind: 'individual' };
  if (!o.levels.length) return { kind: 'none' };
  const spacing = o.minSpacingPx ?? GROUP_MIN_SPACING_PX;
  for (let l = 0; l < o.levels.length; l++) {
    const bin = o.levels[l].binSize;
    // Tissue rarely fills the view; 0.7 of the bins occupied is a fair guess.
    if (bin * o.pxPerUnit >= spacing && (area / (bin * bin)) * 0.7 <= o.budget) {
      return { kind: 'bins', level: l };
    }
  }
  return { kind: 'bins', level: o.levels.length - 1 };
}

/**
 * Diameter in px of a group of `count` transcripts in a bin `binPx` wide, where
 * `refCount` is a typical busy bin in view (its 95th percentile).
 *
 * Area grows with the count — a bin with a quarter of the transcripts gets half the
 * diameter — between a third of the bin (so a sparse bin is still visible) and a little
 * over the full bin (so dense neighbours just touch rather than pile up).
 */
export function groupedMarkerPx(count: number, refCount: number, binPx: number, scale = 1): number {
  const f = Math.sqrt(Math.min(1, count / Math.max(1, refCount)));
  const d = binPx * (0.35 + 0.75 * f) * scale;
  return Math.max(TRANSCRIPT_MIN_PX * scale, Math.min(d, binPx * 1.2 * Math.max(scale, 1)));
}

/** The `p` quantile (0..1) of a count vector — a sample of it for large vectors. */
export function quantileOf(values: ArrayLike<number>, p: number): number {
  return quantile(values, p, { sampleSize: 4096 }) ?? 0;
}
