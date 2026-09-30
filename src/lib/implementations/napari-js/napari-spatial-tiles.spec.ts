import { SpatialTranscriptTile } from '../../contracts/spatial-dataset.contract';
import { mergePolygonTiles, mergeTranscriptTiles, pickNearest } from './napari-spatial-tiles';

const tile = (xs: number[], ys: number[], weight = 1): SpatialTranscriptTile => ({
  count: xs.length,
  aggregated: weight > 1,
  x: Float32Array.from(xs),
  y: Float32Array.from(ys),
  z: new Float32Array(xs.length),
  weight: new Uint32Array(xs.length).fill(weight),
  observation: Uint32Array.from(xs.map((_v, i) => i)),
  gene: new Uint16Array(xs.length),
});

describe('pickNearest (transcript hover)', () => {
  const drawn = (t: SpatialTranscriptTile, r: number) => ({
    merged: t, radius: new Float32Array(t.count).fill(r), grid: null,
  });

  it('finds the marker under the cursor, within its radius', () => {
    const d = drawn(tile([0, 10, 20], [0, 0, 0]), 2);
    expect(pickNearest(d, 10.5, 0.5, 0.1)).toBe(1);
    expect(pickNearest(d, 15, 0, 0.1)).toBe(-1); // between markers
  });

  it('uses the pointer tolerance for markers smaller than it', () => {
    const d = drawn(tile([0, 10], [0, 0]), 0.1);
    expect(pickNearest(d, 1, 0, 1.5)).toBe(0);
  });

  it('prefers the closest of overlapping markers', () => {
    const d = drawn(tile([0, 1.5], [0, 0]), 2);
    expect(pickNearest(d, 1.2, 0, 0.1)).toBe(1);
  });

  it('builds its grid once and reuses it', () => {
    const d = drawn(tile([0, 100, -100], [0, 50, -50]), 1);
    expect(pickNearest(d, 100, 50, 0.1)).toBe(1);
    const grid = d.grid;
    expect(grid).not.toBeNull();
    expect(pickNearest(d, -100, -50, 0.1)).toBe(2);
    expect(d.grid).toBe(grid);
  });
});

describe('tile merging', () => {
  it('concatenates transcript tiles and stops at the limit', () => {
    const m = mergeTranscriptTiles([tile([1, 2], [3, 4]), tile([5], [6])], 2);
    expect(m.count).toBe(2);
    expect(Array.from(m.x)).toEqual([1, 2]);
  });

  it('drops a ring listed by two tiles', () => {
    const t = (obs: number[]) => ({
      count: obs.length, observation: Uint32Array.from(obs),
      offsets: Uint32Array.from(obs.map((_o, i) => i * 3).concat(obs.length * 3)),
      coords: new Float32Array(obs.length * 6).map((_v, i) => i),
    });
    const m = mergePolygonTiles([t([7, 8]), t([8, 9])]);
    expect(Array.from(m.observation)).toEqual([7, 8, 9]);
    expect(m.offsets[m.count]).toBe(9);
  });
});
