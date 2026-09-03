import {
  DensityGrid, defaultSigma, densityGrid, rasterizeDensity,
} from './spatial-density';
import { SpatialDataset, SpatialObservations } from '../../contracts/spatial-dataset.contract';

/**
 * The density estimator. What is under test is the part that makes it an honest
 * estimate rather than a smear: anisotropy along z, and the coverage correction
 * that keeps an unsampled plane from reading as empty tissue.
 */
describe('spatial density', () => {
  const obs = (
    pts: [number, number, number][], over: Partial<SpatialObservations> = {},
  ): SpatialObservations => ({
    count: pts.length,
    x: Float32Array.from(pts, (p) => p[0]),
    y: Float32Array.from(pts, (p) => p[1]),
    z: Float32Array.from(pts, (p) => p[2]),
    ...over,
  } as SpatialObservations);

  const grid = (over: Partial<DensityGrid> = {}): DensityGrid => ({
    width: 8, height: 8, depth: 8, voxelSize: [10, 10, 10], ...over,
  });

  /** Value at a voxel, for readability in assertions. */
  const at = (f: Uint8Array, g: DensityGrid, x: number, y: number, z: number) =>
    f[(z * g.height + y) * g.width + x];

  describe('densityGrid', () => {
    const dataset = (over: Partial<SpatialDataset> = {}): SpatialDataset => ({
      id: 'd', name: 'D', columns: [],
      observations: obs([[0, 0, 0], [100, 100, 100]]),
      volume: { width: 275, height: 275, depth: 76, voxelSize: [40, 40, 200] },
      ...over,
    } as SpatialDataset);

    it('coarsens the volume grid while keeping its physical extent exactly', () => {
      const g = densityGrid(dataset(), 2)!;

      expect([g.width, g.height, g.depth]).toEqual([138, 138, 38]);
      // Same box: `ceil` added half a voxel on x/y, so the voxel size has to come
      // from the span rather than from stride x the original, or the field would
      // overhang the reference volume it is drawn inside.
      expect(g.width * g.voxelSize[0]).toBeCloseTo(275 * 40, 6);
      expect(g.height * g.voxelSize[1]).toBeCloseTo(275 * 40, 6);
      expect(g.depth * g.voxelSize[2]).toBeCloseTo(76 * 200, 6);
    });

    it('derives a box from the observations, anchored at the coordinate origin', () => {
      const g = densityGrid(dataset({ volume: undefined }), 2, 64)!;

      expect(Math.max(g.width, g.height, g.depth)).toBe(64);
      // Covers the cloud, with its near corner at the origin — the same anchoring a
      // volume has, so a renderer can centre either with one half-box offset.
      expect(g.width * g.voxelSize[0]).toBeGreaterThanOrEqual(100);
      expect(
        rasterizeDensity(
          dataset({ volume: undefined }).observations, g, { sigma: [1, 1, 1] },
        ),
      ).not.toBeNull();
    });

    it('has no grid for a flat dataset with no volume', () => {
      const flat = dataset({ volume: undefined, observations: { count: 2,
        x: new Float32Array([0, 1]), y: new Float32Array([0, 1]) } as SpatialObservations });
      expect(densityGrid(flat)).toBeNull();
    });
  });

  describe('rasterizeDensity', () => {
    it('puts the peak where the cells are and falls off from there', () => {
      const g = grid();
      const f = rasterizeDensity(obs([[45, 45, 45]]), g, { sigma: [10, 10, 10] })!;

      expect(at(f, g, 4, 4, 4)).toBe(255);
      expect(at(f, g, 5, 4, 4)).toBeLessThan(255);
      expect(at(f, g, 5, 4, 4)).toBeGreaterThan(0);
      expect(at(f, g, 0, 0, 0)).toBeLessThan(at(f, g, 3, 4, 4));
    });

    it('spreads along z by the z bandwidth alone, not the in-plane one', () => {
      const g = grid();
      // A wide z kernel and a narrow in-plane one: the field must reach the
      // neighbouring PLANE while staying tight in x. An isotropic kernel would
      // leave one disc per section, which is a sampling artefact, not biology.
      const f = rasterizeDensity(obs([[45, 45, 45]]), g, { sigma: [3, 3, 30] })!;

      expect(at(f, g, 4, 4, 6)).toBeGreaterThan(at(f, g, 6, 4, 4));
    });

    it('lifts an unsampled plane to its neighbours level instead of leaving a hole', () => {
      // Two sections, 2 planes apart, with nothing measured between them: the
      // uncorrected estimate dips in the middle purely because no tissue was
      // imaged there. The coverage correction is what removes that dip.
      const g = grid();
      const cells = obs([[45, 45, 25], [45, 45, 45]]);
      const f = rasterizeDensity(cells, g, { sigma: [10, 10, 12] })!;

      const mid = at(f, g, 4, 4, 3); // the unsampled plane between them
      expect(mid).toBeGreaterThanOrEqual(Math.min(at(f, g, 4, 4, 2), at(f, g, 4, 4, 4)));
    });

    it('does not correct a rare subset for its own rarity', () => {
      // Coverage comes from the WHOLE dataset: a cluster present on only one of
      // several imaged planes is genuinely absent from the others, and must not be
      // scaled up to look present everywhere.
      const g = grid();
      const all = obs([[45, 45, 15], [45, 45, 25], [45, 45, 35], [45, 45, 45]]);
      const f = rasterizeDensity(all, g, { sigma: [10, 10, 6], indices: new Uint32Array([3]) })!;

      expect(at(f, g, 4, 4, 4)).toBe(255);       // its own plane
      expect(at(f, g, 4, 4, 1)).toBeLessThan(60); // a plane it is absent from
    });

    it('rasterises only the given indices', () => {
      const g = grid();
      const two = obs([[5, 5, 5], [65, 65, 65]]);
      const f = rasterizeDensity(two, g, { sigma: [5, 5, 5], indices: new Uint32Array([0]) })!;

      expect(at(f, g, 0, 0, 0)).toBe(255);
      expect(at(f, g, 6, 6, 6)).toBe(0);
    });

    it('returns null when nothing lands on the grid', () => {
      // Off-grid coordinates draw no layer at all, rather than an empty box the
      // user has to work out the meaning of.
      expect(rasterizeDensity(obs([[1e6, 1e6, 1e6]]), grid(), { sigma: [5, 5, 5] })).toBeNull();
      expect(rasterizeDensity(obs([]), grid(), { sigma: [5, 5, 5] })).toBeNull();
    });
  });

  describe('defaultSigma', () => {
    it('scales with the grid and with the smoothing control', () => {
      const g = grid({ voxelSize: [80, 80, 400] });
      expect(defaultSigma(g)).toEqual([120, 120, 600]);
      expect(defaultSigma(g, 2)).toEqual([240, 240, 1200]);
      // σ along z is above one section gap (the grid's own z voxel), which is the
      // smallest bandwidth that can bridge a missing section.
      expect(defaultSigma(g)[2]).toBeGreaterThan(g.voxelSize[2]);
    });
  });
});
