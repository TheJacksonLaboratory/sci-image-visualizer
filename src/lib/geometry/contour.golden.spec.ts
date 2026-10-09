import { WandService } from '../toolbar/wand/wand.service';

/**
 * Golden output for the contour tracer (mask → polygons with holes, and
 * label map → polygons). Pins the exact vertices, ordering and hole rings over
 * a set of seeded random masks so the tracer can be restructured (bbox-local
 * tracing, RT-16) without changing a single output coordinate.
 */
const wand = new WandService();
const maskToPolygons = wand.maskToPolygons.bind(wand);
const labelsToPolygons = wand.labelsToPolygons.bind(wand);

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string — a compact fingerprint of a large output. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Random discs and rings (donuts) painted into a w×h binary mask. */
function blobMask(seed: number, w: number, h: number, shapes: number): Uint8Array {
  const r = rng(seed);
  const mask = new Uint8Array(w * h);
  for (let s = 0; s < shapes; s++) {
    const cx = r() * w, cy = r() * h;
    const ro = 2 + r() * Math.min(w, h) / 4;
    const ri = r() < 0.5 ? ro * (0.2 + r() * 0.5) : 0;
    const erase = r() < 0.15;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d <= ro && d >= ri) mask[y * w + x] = erase ? 0 : 1;
      }
    }
  }
  // Salt and pepper: single-pixel blobs and pinholes.
  for (let i = 0; i < (w * h) / 60; i++) {
    const idx = Math.floor(r() * w * h);
    mask[idx] = mask[idx] ? 0 : 1;
  }
  return mask;
}

/** A label map of random (possibly overlapping, possibly ring-shaped) cells. */
function labelMap(seed: number, w: number, h: number, cells: number): Uint32Array {
  const r = rng(seed);
  const labels = new Uint32Array(w * h);
  for (let c = 1; c <= cells; c++) {
    const cx = r() * w, cy = r() * h;
    const ro = 1 + r() * 7;
    const ri = r() < 0.3 ? ro * 0.4 : 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d <= ro && d >= ri) labels[y * w + x] = c;
      }
    }
  }
  return labels;
}

const digest = (polys: unknown[]) => fnv(JSON.stringify(polys));

describe('contour tracing golden output', () => {
  it('traces a small donut exactly', () => {
    const w = 8, h = 7;
    const mask = new Uint8Array(w * h);
    for (let y = 1; y < 6; y++) for (let x = 1; x < 7; x++) mask[y * w + x] = 1;
    for (let y = 3; y < 5; y++) for (let x = 3; x < 5; x++) mask[y * w + x] = 0;
    const polys = maskToPolygons(mask, w, h, 10, 20, 1, 1);
    expect(polys.length).toBe(1);
    expect(polys[0].xpoints).toEqual([11, 12, 13, 14, 15, 16, 16, 16, 16, 16, 15, 14, 13, 12, 11, 11, 11, 11]);
    expect(polys[0].ypoints).toEqual([21, 21, 21, 21, 21, 21, 22, 23, 24, 25, 25, 25, 25, 25, 25, 24, 23, 22]);
    expect(polys[0].holes).toEqual([[[13, 23], [14, 23], [14, 24], [13, 24]]]);
  });

  it.each([
    [1, 40, 30, 6, '839bfc59'],
    [2, 64, 48, 10, '38d85020'],
    [3, 33, 71, 8, '27ede51b'],
    [4, 90, 60, 18, '7b3c66e1'],
    [5, 17, 17, 3, 'b1fcc5ab'],
  ])('maskToPolygons output is unchanged (seed %i, %ix%i)', (seed, w, h, shapes, expected) => {
    const mask = blobMask(seed, w, h, shapes);
    const defaults = maskToPolygons(mask, w, h, -7, 13);
    const all = maskToPolygons(mask, w, h, 0, 0, 1, 1);
    // The fixtures must exercise multi-part output and holes, or the digest pins little.
    expect(all.length).toBeGreaterThan(1);
    expect(all.some((p) => p.holes?.length)).toBe(true);
    expect(digest([defaults, all])).toBe(expected);
  });

  it.each([
    [11, 50, 40, 25, '0995eabf'],
    [12, 80, 64, 60, '61ef3cee'],
    [13, 31, 29, 9, 'cb1d50f9'],
  ])('labelsToPolygons output is unchanged (seed %i, %ix%i)', (seed, w, h, cells, expected) => {
    const labels = labelMap(seed, w, h, cells);
    const out = [labelsToPolygons(labels, w, h, 0, 0), labelsToPolygons(labels, w, h, 100, -5, 1)];
    expect(out[1].length).toBeGreaterThan(3);
    expect(digest(out)).toBe(expected);
  });
});
