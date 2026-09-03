import {
  MAX_SAMPLED_SECTIONS, observationsInSection, sampledSections, sectionsOf,
} from './spatial-sections';
import { SpatialObservations } from '../../contracts/spatial-dataset.contract';

/**
 * Sections of a serially sectioned dataset. The two things that matter: the
 * sections are the slides that were imaged (not bins over a continuous axis), and
 * a z that ISN'T sectioned is reported as having none rather than being carved up.
 */
describe('sampledSections', () => {
  const obs = (z?: number[]): SpatialObservations =>
    ({
      count: z ? z.length : 0,
      x: new Float32Array(z?.length ?? 0),
      y: new Float32Array(z?.length ?? 0),
      ...(z ? { z: Float32Array.from(z) } : {}),
    }) as SpatialObservations;

  it('reports each imaged plane once, ascending', () => {
    // Three slides, several cells each, arriving out of order.
    const s = sampledSections(obs([6.6, 1.1, 3.3, 1.1, 6.6, 3.3, 1.1]))!;
    expect(Array.from(s)).toEqual([1.1, 3.3, 6.6].map((v) => Math.fround(v)));
  });

  it('sorts numerically, not as text', () => {
    // The trap in sorting a typed array's values by the default comparator.
    const s = sampledSections(obs([2, 10, 1]))!;
    expect(Array.from(s)).toEqual([1, 2, 10]);
  });

  it('treats a finely divided z as continuous, not as thousands of sections', () => {
    // A "pick one section" control over a measurement axis would be a lie, and
    // the set that proved it must not grow to one entry per observation.
    const many = Array.from({ length: MAX_SAMPLED_SECTIONS + 1 }, (_, i) => i * 0.5);
    expect(sampledSections(obs(many))).toBeNull();
    // The cap is honoured exactly at the boundary.
    expect(sampledSections(obs(many.slice(0, MAX_SAMPLED_SECTIONS)))).toHaveLength(
      MAX_SAMPLED_SECTIONS,
    );
    // …and a caller can lower it.
    expect(sampledSections(obs([1, 2, 3]), 2)).toBeNull();
  });

  it('has no sections without a z, without observations, or with only a non-finite z', () => {
    expect(sampledSections(obs())).toBeNull();
    expect(sampledSections(obs([]))).toBeNull();
    // NaN places a cell on no section; it must not become one.
    expect(sampledSections(obs([NaN, NaN]))).toBeNull();
    expect(Array.from(sampledSections(obs([NaN, 4]))!)).toEqual([4]);
  });
});

describe('observationsInSection', () => {
  const obs = (z: number[]): SpatialObservations =>
    ({
      count: z.length,
      x: new Float32Array(z.length),
      y: new Float32Array(z.length),
      z: Float32Array.from(z),
    }) as SpatialObservations;

  it('picks out one slide’s cells, in order', () => {
    const o = obs([1, 5, 1, 9, 5, 1]);
    expect(Array.from(observationsInSection(o, 1))).toEqual([0, 2, 5]);
    expect(Array.from(observationsInSection(o, 5))).toEqual([1, 4]);
  });

  it('round-trips against the sections it was told about', () => {
    // The contract between the two functions: every observation with a finite z
    // belongs to exactly one reported section, so the parts sum to the whole.
    const o = obs([6.6, 1.1, 3.3, 1.1, 6.6, 3.3, 1.1]);
    const total = Array.from(sampledSections(o)!).reduce(
      (n, z) => n + observationsInSection(o, z).length,
      0,
    );
    expect(total).toBe(o.count);
  });

  it('yields nothing for a plane that was never imaged', () => {
    expect(observationsInSection(obs([1, 2]), 7)).toHaveLength(0);
  });

  it('yields nothing when the dataset has no z at all', () => {
    const flat = { count: 2, x: new Float32Array(2), y: new Float32Array(2) } as SpatialObservations;
    expect(observationsInSection(flat, 0)).toHaveLength(0);
  });
});

describe('sectionsOf', () => {
  it('scans an observations object once and hands both callers the same list', () => {
    // The renderer and the panel both need the sections; the scan reads the z of
    // up to 3.7M observations, so it must not happen twice.
    const obs = {
      count: 4,
      x: new Float32Array(4),
      y: new Float32Array(4),
      z: Float32Array.from([2, 1, 2, 1]),
    } as SpatialObservations;

    const first = sectionsOf(obs);
    expect(Array.from(first!)).toEqual([1, 2]);
    expect(sectionsOf(obs)).toBe(first); // the same array, not an equal one

    // A different dataset is scanned on its own.
    const other = { ...obs, z: Float32Array.from([9]), count: 1 } as SpatialObservations;
    expect(Array.from(sectionsOf(other)!)).toEqual([9]);
  });

  it('remembers "not sectioned" too, rather than rescanning to find out again', () => {
    const obs = {
      count: 2,
      x: new Float32Array(2),
      y: new Float32Array(2),
    } as SpatialObservations;
    expect(sectionsOf(obs)).toBeNull();
    expect(sectionsOf(obs)).toBeNull();
  });
});
