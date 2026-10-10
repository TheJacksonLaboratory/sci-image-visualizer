/**
 * Transcript "icon" mode: the marker shapes and their expansion into rings for a shapes
 * layer. A napari-js candidate (a points symbol set) — see the review's SPATIAL-21 list.
 */

import type { TranscriptGlyphName } from '../contracts/display-types';

/** Marker shapes for the transcript "icon" mode. All star-convex, so a fan fills them. */
export const TRANSCRIPT_GLYPHS = [
  'circle',
  'star',
  'triangle',
  'square',
  'diamond',
  'cross',
  'hexagon',
  'triangle-down',
  'pentagon',
  'x',
] as const;
/** One of the marker shapes in {@link TRANSCRIPT_GLYPHS}. */
export type TranscriptGlyph = (typeof TRANSCRIPT_GLYPHS)[number];
// The view state names glyphs without importing this module; keep the two in step.
const _glyphNamesMatch: TranscriptGlyph extends TranscriptGlyphName
  ? TranscriptGlyphName extends TranscriptGlyph
    ? true
    : never
  : never = true;
void _glyphNamesMatch;

/** Unit outline of a glyph, radius ≈ 1, centred on the origin, as `[x0, y0, x1, y1, …]`. */
export function glyphOutline(glyph: TranscriptGlyph): Float32Array {
  const poly = (n: number, rot = -Math.PI / 2, r = 1) => {
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const a = rot + (i * 2 * Math.PI) / n;
      out[2 * i] = Math.cos(a) * r;
      out[2 * i + 1] = Math.sin(a) * r;
    }
    return out;
  };
  const star = (points: number, inner: number, rot = -Math.PI / 2) => {
    const out = new Float32Array(points * 4);
    for (let i = 0; i < points * 2; i++) {
      const a = rot + (i * Math.PI) / points;
      const r = i % 2 === 0 ? 1 : inner;
      out[2 * i] = Math.cos(a) * r;
      out[2 * i + 1] = Math.sin(a) * r;
    }
    return out;
  };
  // A plus built as a 12-gon: arms of half-width w.
  const plus = (w: number, rotate: boolean) => {
    const pts = [
      [w, -1],
      [w, -w],
      [1, -w],
      [1, w],
      [w, w],
      [w, 1],
      [-w, 1],
      [-w, w],
      [-1, w],
      [-1, -w],
      [-w, -w],
      [-w, -1],
    ];
    const out = new Float32Array(pts.length * 2);
    const c = Math.SQRT1_2;
    pts.forEach(([x, y], i) => {
      out[2 * i] = rotate ? (x - y) * c : x;
      out[2 * i + 1] = rotate ? (x + y) * c : y;
    });
    return out;
  };
  switch (glyph) {
    case 'circle':
      return poly(12);
    case 'star':
      return star(5, 0.45);
    case 'triangle':
      return poly(3);
    case 'triangle-down':
      return poly(3, Math.PI / 2);
    case 'square':
      return poly(4, Math.PI / 4, Math.SQRT2 * 0.8);
    case 'diamond':
      return poly(4, -Math.PI / 2);
    case 'hexagon':
      return poly(6, 0);
    case 'pentagon':
      return poly(5);
    case 'cross':
      return plus(0.32, false);
    case 'x':
      return plus(0.28, true);
  }
}

/** The glyph a gene gets by default: by its position in the selected list. */
export function defaultGlyphFor(slot: number): TranscriptGlyph {
  return TRANSCRIPT_GLYPHS[slot % TRANSCRIPT_GLYPHS.length];
}

/**
 * Expand point markers into glyph rings for a shapes layer: entry `i` becomes a copy of
 * `glyphs[gene[i]]` scaled to `radius[i]` and centred on `(x[i], y[i])`.
 */
export function glyphRings(
  x: Float32Array,
  y: Float32Array,
  radius: Float32Array,
  glyphOf: (i: number) => Float32Array,
): { coords: Float32Array; offsets: Uint32Array } {
  const n = x.length;
  const offsets = new Uint32Array(n + 1);
  let total = 0;
  for (let i = 0; i < n; i++) {
    offsets[i] = total;
    total += glyphOf(i).length / 2;
  }
  offsets[n] = total;
  const coords = new Float32Array(total * 2);
  for (let i = 0; i < n; i++) {
    const g = glyphOf(i);
    const r = radius[i];
    let o = offsets[i] * 2;
    for (let k = 0; k < g.length; k += 2) {
      coords[o++] = x[i] + g[k] * r;
      coords[o++] = y[i] + g[k + 1] * r;
    }
  }
  return { coords, offsets };
}
