import { DEFAULT_SPATIAL_VIEW } from '../contracts/display-types';
import { NO_CATEGORY } from '../contracts/spatial-dataset.contract';
import { DEFAULT_CATEGORICAL_PALETTE } from './spatial-encoding';
import {
  dominantGenes,
  expressingMask,
  geneFilterKey,
  hasGeneFilter,
  observationGeneColor,
  observationGeneGlyph,
  observationGeneMask,
  observationGeneStyle,
  observationGeneStyleKey,
} from './spatial-gene-filter';

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

describe('drawing the filtered observations by gene', () => {
  const view = {
    ...DEFAULT_SPATIAL_VIEW,
    observationGenes: ['A1CF', 'A2ML1'],
    observationGeneColors: { A2ML1: '#123456' },
    observationGeneGlyphs: { A1CF: 'star' as const },
  };

  it("takes a gene's own colour, else the palette's for its place in the list", () => {
    expect(observationGeneColor(view, 'A2ML1')).toBe('#123456');
    expect(observationGeneColor(view, 'A1CF')).toBe(DEFAULT_CATEGORICAL_PALETTE[0]);
    expect(observationGeneColor({ ...view, observationGeneColors: {} }, 'A2ML1')).toBe(
      DEFAULT_CATEGORICAL_PALETTE[1],
    );
  });

  it("takes a gene's own icon, else a circle", () => {
    expect(observationGeneGlyph(view, 'A1CF')).toBe('star');
    expect(observationGeneGlyph(view, 'A2ML1')).toBe('circle');
  });

  it("gives each observation the gene it expresses most relative to that gene's highest value", () => {
    // A tops out at 100, B at 2: observation 1 has A at 10% and B at 100%, so it is B's.
    const A = Float32Array.of(100, 10, 0, 0);
    const B = Float32Array.of(1, 2, 0, 1);
    expect(Array.from(dominantGenes([A, B], 4))).toEqual([0, 1, NO_CATEGORY, 1]);
  });

  it('is drawn by gene only while that is on and genes are picked', async () => {
    const read = (g: string) => Promise.resolve(g === 'A1CF' ? Float32Array.of(3, 0) : Float32Array.of(0, 5));
    const style = await observationGeneStyle(view, 2, read);
    expect(Array.from(style!.codes)).toEqual([0, 1]);
    expect(style!.colors).toEqual([DEFAULT_CATEGORICAL_PALETTE[0], '#123456']);
    expect(style!.glyphs).toEqual(['star', 'circle']);
    expect(await observationGeneStyle({ ...view, observationGenesColorBy: false }, 2, read)).toBeNull();
    expect(await observationGeneStyle(DEFAULT_SPATIAL_VIEW, 2, read)).toBeNull();
  });

  it("keys on each gene's colour and icon, and on nothing while not colouring by gene", () => {
    const key = observationGeneStyleKey(view);
    expect(observationGeneStyleKey({ ...view, observationGeneColors: { A2ML1: '#654321' } })).not.toBe(key);
    expect(observationGeneStyleKey({ ...view, observationGeneGlyphs: {} })).not.toBe(key);
    expect(observationGeneStyleKey({ ...view, observationGenesColorBy: false })).toBe('');
  });
});
