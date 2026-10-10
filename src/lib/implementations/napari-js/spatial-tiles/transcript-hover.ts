import type { SpatialDataPort } from '../../../contracts/ports/spatial-data.port';
import {
  NO_CATEGORY, NO_OBSERVATION, SpatialImageRef, SpatialTranscriptSummary, SpatialTranscriptTile,
} from '../../../contracts/spatial-dataset.contract';
import type { CategoricalCodes } from './categorical-lookup';

/** What one transcript entry is — decides what hovering it says. */
export type TranscriptKind = 'genes' | 'individual' | 'bins';

/** A bin grid: its size and origin, so a hovered bin's square can be recovered. */
export interface TranscriptBin {
  size: number;
  origin: [number, number];
}

/**
 * Tooltips for the transcript markers of the 2D spatial view.
 *
 * Reads only what the transcript layer last drew — handed over one way through
 * {@link setDrawn} / {@link setTypes} — and asks the server for the slower details (distinct
 * genes in a group, its top genes and cells, the cell's display id) once the pointer has
 * rested on a marker, caching them until the next draw.
 */
export class TranscriptHover {
  /** What the transcript layer currently shows (written by drawing, read by hover). */
  private drawn: DrawnTranscripts | null = null;
  /** The cell-type column, to name the cell a marker is in. */
  private types: CategoricalCodes | null = null;
  /** µm per observation unit of the drawn dataset, for describing a grouped marker's area. */
  private micronsPerUnit: number | null = null;
  /** Details already fetched, by hovered entry. */
  private readonly cache = new Map<string, string[]>();
  private key: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `layerShown` says whether the transcript layer is on screen now (it may have been dropped). */
  constructor(private readonly port: SpatialDataPort, private readonly layerShown: () => boolean) {}

  /** The transcript layer was redrawn: hover names these entries now (cached details are dropped). */
  setDrawn(drawn: DrawnTranscripts, micronsPerUnit: number | null): void {
    this.drawn = drawn;
    this.cache.clear();
    this.micronsPerUnit = micronsPerUnit;
  }

  /** The cell-type column the drawn entries' cells are named by, or null. */
  setTypes(types: CategoricalCodes | null): void {
    this.types = types;
  }

  /** Nothing is drawn any more. */
  clear(): void {
    this.drawn = null;
  }

  /** Stop a pending details request and forget what was drawn. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.drawn = null;
  }

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
    if (!d || !this.layerShown() || !d.merged.count) {
      this.key = null;
      return null;
    }
    const sx = d.ref?.scale?.[0] ?? 1;
    const sy = d.ref?.scale?.[1] ?? 1;
    const x = (wx - (d.ref?.translate?.[0] ?? 0)) / sx;
    const y = (wy - (d.ref?.translate?.[1] ?? 0)) / sy;
    const i = pickNearest(d, x, y, radiusWorld / Math.abs(sx));
    if (i < 0) {
      this.key = null;
      return null;
    }
    const key = `${d.kind}|${d.merged.x[i]}|${d.merged.y[i]}|${d.merged.gene[i]}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (key !== this.key) {
      this.key = key;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.fetchDetails(d, i, key, onDetails), 150);
    }
    return this.describe(d, i, null);
  }

  private async fetchDetails(
    d: DrawnTranscripts, i: number, key: string, onDetails: (lines: string[]) => void,
  ): Promise<void> {
    if (!this.port.getTranscriptSummary || this.key !== key) return;
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
      this.cache.set(key, lines);
      if (this.key === key) onDetails(lines);
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
      const types = this.types;
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
}

/** What the transcript layer currently shows — what hovering needs to name a marker. */
export interface DrawnTranscripts {
  kind: TranscriptKind;
  bin?: TranscriptBin;
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
