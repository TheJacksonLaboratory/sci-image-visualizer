import { DEFAULT_SPATIAL_VIEW } from '../contracts/display-types';
import { expressingMask, geneFilterKey, hasGeneFilter, observationGeneMask } from './spatial-gene-filter';

const A = Float32Array.from([0, 2, 0, 1, NaN]);
const B = Float32Array.from([3, 1, 0, 0, 0]);

describe('expressingMask', () => {
  it('keeps the observations expressing any of the genes', () => {
    expect(Array.from(expressingMask([A, B], 5, 'any'))).toEqual([1, 1, 0, 1, 0]);
  });

  it('keeps only the observations expressing all of them', () => {
    expect(Array.from(expressingMask([A, B], 5, 'all'))).toEqual([0, 1, 0, 0, 0]);
  });

  it('treats a missing value as not expressed', () => {
    expect(expressingMask([A], 5, 'any')[4]).toBe(0);
  });
});

describe('the view gene filter', () => {
  const view = { ...DEFAULT_SPATIAL_VIEW, observationGenes: ['A', 'B'], observationGenesMatch: 'all' as const };

  it('is off with no genes', () => {
    expect(hasGeneFilter(DEFAULT_SPATIAL_VIEW)).toBe(false);
    expect(geneFilterKey(DEFAULT_SPATIAL_VIEW)).toBe('');
  });

  it('keys on the genes and the rule', () => {
    expect(geneFilterKey(view)).not.toBe(geneFilterKey({ ...view, observationGenesMatch: 'any' }));
    expect(geneFilterKey(view)).not.toBe(geneFilterKey({ ...view, observationGenes: ['A'] }));
  });

  it('is null without genes, and never reads a vector', async () => {
    const read = jest.fn();
    expect(await observationGeneMask(DEFAULT_SPATIAL_VIEW, 5, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('reads each gene and builds the mask once for the same vectors', async () => {
    const read = jest.fn((g: string) => Promise.resolve(g === 'A' ? A : B));
    const first = await observationGeneMask(view, 5, read);
    const again = await observationGeneMask(view, 5, read);
    expect(Array.from(first!)).toEqual([0, 1, 0, 0, 0]);
    expect(again).toBe(first);
    expect(read).toHaveBeenCalledWith('A');
    expect(read).toHaveBeenCalledWith('B');
  });

  it('builds a new mask when the rule changes', async () => {
    const read = (g: string) => Promise.resolve(g === 'A' ? A : B);
    const all = await observationGeneMask(view, 5, read);
    const any = await observationGeneMask({ ...view, observationGenesMatch: 'any' }, 5, read);
    expect(any).not.toBe(all);
    expect(Array.from(any!)).toEqual([1, 1, 0, 1, 0]);
  });
});
