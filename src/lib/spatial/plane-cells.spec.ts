import { cellIdOf, observationIndex, planeCellRings } from './plane-cells';
import { SpatialObservations } from '../contracts/spatial-dataset.contract';

const feature = (id: string, rings: number[][], open = false): any => ({
  id,
  label: null,
  color: null,
  bbox: [0, 0, 1, 1],
  open,
  rings: rings.map((r) => Float32Array.from(r)),
});
const SQUARE = [0, 0, 4, 0, 4, 4, 0, 4];

describe('plane cells', () => {
  it('indexes the observations by id, once per observations object', () => {
    const obs = {
      count: 2,
      x: new Float32Array(2),
      y: new Float32Array(2),
      ids: ['a', 'b'],
    } as SpatialObservations;
    const index = observationIndex(obs)!;
    expect(index.get('b')).toBe(1);
    expect(observationIndex(obs)).toBe(index);
    expect(observationIndex({ count: 0, x: new Float32Array(0), y: new Float32Array(0) })).toBeNull();
  });

  it("takes a feature's cell id from behind its slice", () => {
    expect(cellIdOf('3:112')).toBe('112');
    expect(cellIdOf('112')).toBe('112');
  });

  it('makes each feature once, every ring of it owned by its cell, in observation units', () => {
    const index = new Map([
      ['1', 0],
      ['2', 1],
    ]);
    const tiles = [
      { features: [feature('0:1', [SQUARE]), feature('0:2', [SQUARE, [10, 10, 12, 10, 11, 12]])] },
      // In two tiles: drawn once. A cell the dataset has not, and a polyline, are left out.
      {
        features: [
          feature('0:2', [SQUARE, [10, 10, 12, 10, 11, 12]]),
          feature('0:9', [SQUARE]),
          feature('0:1', [SQUARE], true),
        ],
      },
    ];
    const rings = planeCellRings(tiles, index, { scale: [2, 2], translate: [10, 0] });
    expect(rings.count).toBe(3);
    expect(Array.from(rings.observation)).toEqual([0, 1, 1]);
    expect(Array.from(rings.offsets)).toEqual([0, 4, 8, 11]);
    // Image px back to observation units: (x - 10) / 2, y / 2.
    expect(Array.from(rings.coords.subarray(0, 4))).toEqual([-5, 0, -3, 0]);
  });
});
