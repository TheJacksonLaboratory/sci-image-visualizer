import { inBand, observationsOnPlane, planeBand } from './spatial-planes';
import { SpatialObservations } from '../contracts/spatial-dataset.contract';

describe('spatial planes', () => {
  const obs = (z?: number[]): SpatialObservations =>
    ({
      count: z ? z.length : 0,
      x: new Float32Array(z?.length ?? 0),
      y: new Float32Array(z?.length ?? 0),
      ...(z ? { z: Float32Array.from(z) } : {}),
    }) as SpatialObservations;

  it('bands each plane halfway to its neighbours, open past the ends', () => {
    const planes = [0, 10, 30];
    expect(planeBand(planes, 0)).toEqual([-Infinity, 5]);
    expect(planeBand(planes, 1)).toEqual([5, 20]);
    expect(planeBand(planes, 2)).toEqual([20, Infinity]);
  });

  it('bands descending planes the right way up', () => {
    expect(planeBand([30, 10, 0], 0)).toEqual([20, Infinity]);
    expect(planeBand([30, 10, 0], 2)).toEqual([-Infinity, 5]);
  });

  it('clamps the plane and gives one plane the whole depth', () => {
    expect(planeBand([0, 10], 5)).toEqual([5, Infinity]);
    expect(planeBand([7], 0)).toEqual([-Infinity, Infinity]);
  });

  it('puts every z on exactly one plane', () => {
    const planes = [0, 13.768, 27.5, 41.3];
    for (const z of [-3, 0, 6.88, 6.9, 13.768, 20, 41.3, 99]) {
      const on = planes.map((_p, k) => inBand(z, planeBand(planes, k)));
      expect([z, on.filter(Boolean).length]).toEqual([z, 1]);
    }
    expect(inBand(NaN, [-Infinity, Infinity])).toBe(false);
  });

  it('selects the observations on a plane, nearest plane wins', () => {
    const o = obs([0, 4, 6, 11, 29, 31]);
    const planes = [0, 10, 30];
    expect(Array.from(observationsOnPlane(o, planes, 0))).toEqual([0, 1]);
    expect(Array.from(observationsOnPlane(o, planes, 1))).toEqual([2, 3]);
    expect(Array.from(observationsOnPlane(o, planes, 2))).toEqual([4, 5]);
  });

  it('keeps every observation of a dataset without z', () => {
    const o = { count: 3, x: new Float32Array(3), y: new Float32Array(3) } as SpatialObservations;
    expect(Array.from(observationsOnPlane(o, [0, 10], 1))).toEqual([0, 1, 2]);
  });
});
