/**
 * Merging and filtering of the spatial-tile wire format (observation ids, NO_CATEGORY): the
 * pieces of the 2D view's tile loop that are pure — concatenating tiles, dropping hidden
 * groups and genes, and the density-grid markers of a zoomed-out gene selection.
 *
 * These work on SIV's own tile contract, so they stay in SIV rather than moving to napari-js.
 */

import type { SpatialViewState } from '../contracts/display-types';
import {
  NO_CATEGORY,
  NO_OBSERVATION,
  SpatialDensityRaster,
  SpatialPolygonTile,
  SpatialTranscriptTile,
} from '../contracts/spatial-dataset.contract';
import type { DataRect } from './lod';

/** Rings whose owning cell is in a switched-off group removed. */
export function filterRings(
  rings: SpatialPolygonTile,
  hidden: { codes: Uint16Array; hidden: Uint8Array } | null,
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
export function hiddenGeneSlots(view: SpatialViewState): Uint8Array | null {
  if (!view.transcriptHiddenGenes.length) return null;
  const off = new Set(view.transcriptHiddenGenes);
  return Uint8Array.from(view.transcriptGenes, (g) => (off.has(g) ? 1 : 0));
}

/** Entries in a hidden group's cell, or of a hidden gene, removed (with their sizes). */
export function filterTranscripts(
  t: SpatialTranscriptTile,
  px: Float32Array,
  hidden: { codes: Uint16Array; hidden: Uint8Array } | null,
  hiddenGenes: Uint8Array | null,
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
    keep.forEach((i, k) => {
      out[k] = a[i];
    });
    return out;
  };
  return {
    merged: {
      count: keep.length,
      aggregated: t.aggregated,
      x: pick(t.x),
      y: pick(t.y),
      z: pick(t.z),
      weight: pick(t.weight),
      observation: pick(t.observation),
      gene: pick(t.gene),
    },
    px: pick(px),
  };
}

/** The median of `v`, from a sample of about 1024 values. */
export function median(v: Float32Array): number {
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
    x: new Float32Array(n),
    y: new Float32Array(n),
    z: new Float32Array(n),
    weight: new Uint32Array(n),
    observation: new Uint32Array(n),
    gene: new Uint16Array(n),
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
  rasters: SpatialDensityRaster[],
  slots: number[],
  bin: number,
  area: DataRect,
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
      count: n,
      aggregated: true,
      x: Float32Array.from(x),
      y: Float32Array.from(y),
      z: new Float32Array(n),
      weight: Uint32Array.from(w),
      observation: new Uint32Array(n).fill(NO_OBSERVATION),
      gene: Uint16Array.from(gene),
    },
    group: Int32Array.from(group),
  };
}
