import { Polygon } from '../models/region';
import { labelsToPolygons, maskToPolygons } from './contour';
import { rasterizePolygon } from './raster';

/**
 * Golden output for the contour tracer (mask → polygons with holes, and
 * label map → polygons). Pins the exact vertices, ordering and hole rings over
 * a set of seeded random masks so the tracer can be restructured without
 * changing a single output coordinate. Re-baselined when the tracer moved to
 * napari-js's pixel-edge `traceContours` (outlines one pixel larger on the
 * right and bottom, straight runs merged); the round-trip specs below pin that
 * the new outlines rasterize back to exactly the traced pixels.
 */

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
    const cx = r() * w,
      cy = r() * h;
    const ro = 2 + (r() * Math.min(w, h)) / 4;
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
    const cx = r() * w,
      cy = r() * h;
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
    const w = 8,
      h = 7;
    const mask = new Uint8Array(w * h);
    for (let y = 1; y < 6; y++) for (let x = 1; x < 7; x++) mask[y * w + x] = 1;
    for (let y = 3; y < 5; y++) for (let x = 3; x < 5; x++) mask[y * w + x] = 0;
    const polys = maskToPolygons(mask, w, h, 10, 20, 1, 1);
    expect(polys.length).toBe(1);
    // Pixels x 1–6, y 1–5 (offset by the origin) outlined along their edges: [11, 17) × [21, 26).
    expect(polys[0].xpoints).toEqual([11, 17, 17, 11]);
    expect(polys[0].ypoints).toEqual([21, 21, 26, 26]);
    // The hole (pixels 3–4 × 3–4) runs the other way round.
    expect(polys[0].holes).toEqual([
      [
        [13, 23],
        [13, 25],
        [15, 25],
        [15, 23],
      ],
    ]);
  });

  it.each([
    [1, 40, 30, 6, '4154c9c1'],
    [2, 64, 48, 10, 'c3ff9169'],
    [3, 33, 71, 8, '808eda6b'],
    [4, 90, 60, 18, 'c43c288f'],
    [5, 17, 17, 3, 'c1db706d'],
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
    [11, 50, 40, 25, 'a6bbab40'],
    [12, 80, 64, 60, 'da88488f'],
    [13, 31, 29, 9, 'fd460b34'],
  ])('labelsToPolygons output is unchanged (seed %i, %ix%i)', (seed, w, h, cells, expected) => {
    const labels = labelMap(seed, w, h, cells);
    const out = [labelsToPolygons(labels, w, h, 0, 0), labelsToPolygons(labels, w, h, 100, -5, 1)];
    expect(out[1].length).toBeGreaterThan(3);
    expect(digest(out)).toBe(expected);
  });
});

/** OR every polygon (minus its holes) into a w×h mask, through the tools' rasterizer. */
function rasterizeAll(polys: Polygon[], w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (const p of polys) {
    const m = rasterizePolygon(p.xpoints, p.ypoints, w, h, p.holes);
    if (!m) continue;
    for (let y = 0; y < m.bh; y++) {
      for (let x = 0; x < m.bw; x++) {
        const fx = m.bx + x,
          fy = m.by + y;
        if (m.mask[y * m.bw + x] && fx >= 0 && fy >= 0 && fx < w && fy < h) out[fy * w + fx] = 1;
      }
    }
  }
  return out;
}

describe('trace → rasterize round trip', () => {
  it.each([
    [1, 40, 30, 6],
    [2, 64, 48, 10],
    [3, 33, 71, 8],
    [4, 90, 60, 18],
    [5, 17, 17, 3],
  ])('rasterizing the traced polygons gives back the mask exactly (seed %i, %ix%i)', (seed, w, h, shapes) => {
    const mask = blobMask(seed, w, h, shapes);
    let current = mask;
    // A region re-adopted by the wand or brush goes round this loop on every zoom, pan or undo.
    for (let pass = 0; pass < 3; pass++) {
      current = rasterizeAll(maskToPolygons(current, w, h, 0, 0, 1, 1), w, h);
      expect(current).toEqual(mask);
    }
  });

  it.each([
    [11, 50, 40, 25],
    [12, 80, 64, 60],
    [13, 31, 29, 9],
  ])('rasterizing a label map’s traced cells gives back every label (seed %i, %ix%i)', (seed, w, h, cells) => {
    const labels = labelMap(seed, w, h, cells);
    const polys = labelsToPolygons(labels, w, h, 0, 0, 1);
    const all = new Uint8Array(w * h).map((_v, i) => (labels[i] ? 1 : 0));
    expect(rasterizeAll(polys, w, h)).toEqual(all);
  });

  it('keeps a rectangle the size it is: no row lost per round trip', () => {
    const w = 60,
      h = 60;
    const mask = new Uint8Array(w * h);
    for (let y = 10; y < 50; y++) for (let x = 10; x < 50; x++) mask[y * w + x] = 1;
    const [box] = maskToPolygons(mask, w, h, 0, 0);
    expect([Math.min(...box.xpoints), Math.max(...box.xpoints)]).toEqual([10, 50]);
    expect([Math.min(...box.ypoints), Math.max(...box.ypoints)]).toEqual([10, 50]);
    expect(rasterizeAll([box], w, h)).toEqual(mask);
  });

  it('gives a hole only to the blob that encloses it', () => {
    // A U (A) whose open top is closed by a bar (B) touching its arms only at corners: the
    // background inside is enclosed by the pair, by neither alone, so it is no one's hole.
    //   . B B B .
    //   A . . . A
    //   A . . . A
    //   A A A A A
    const rows = ['.BBB.', 'A...A', 'A...A', 'AAAAA'];
    const w = 5,
      h = rows.length;
    const mask = Uint8Array.from(rows.join(''), (c) => (c === '.' ? 0 : 1));
    const polys = maskToPolygons(mask, w, h, 0, 0, 1, 1);
    expect(polys.length).toBe(2);
    expect(polys.every((p) => !p.holes?.length)).toBe(true);
    expect(rasterizeAll(polys, w, h)).toEqual(mask);
  });

  it('gives a ring its hole and leaves the island inside it a separate shape', () => {
    // A ring around a gap around an island: the ring's hole encloses the gap and the island.
    const rows = ['#######', '#.....#', '#.###.#', '#.###.#', '#.###.#', '#.....#', '#######'];
    const w = 7,
      h = rows.length;
    const mask = Uint8Array.from(rows.join(''), (c) => (c === '#' ? 1 : 0));
    const polys = maskToPolygons(mask, w, h, 0, 0, 1, 1);
    expect(polys.length).toBe(2);
    const [ring, island] = polys; // largest first: the ring has 24 pixels, the island 9
    expect(ring.holes?.length).toBe(1);
    expect(island.holes).toBeUndefined();
    expect(rasterizeAll(polys, w, h)).toEqual(mask);
  });
});
