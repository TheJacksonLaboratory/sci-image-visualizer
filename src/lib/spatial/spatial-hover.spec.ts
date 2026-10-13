import { HoverSource, hoverText } from './spatial-hover';
import { NO_CATEGORY } from '../contracts/spatial-dataset.contract';

describe('hoverText', () => {
  const categorical: HoverSource = {
    kind: 'categorical',
    name: 'class',
    categories: ['06 CTX-CGE GABA', '18 TH Glut'],
    codes: Uint16Array.from([1, 0, NO_CATEGORY]),
  };

  it('names the class, then the column it came from', () => {
    expect(hoverText(categorical, 0)).toEqual(['18 TH Glut', 'class']);
    expect(hoverText(categorical, 1)).toEqual(['06 CTX-CGE GABA', 'class']);
  });

  it('says nothing for an observation with no category', () => {
    // NO_CATEGORY is outside the list: a cell the annotation does not cover. A
    // tooltip reading "undefined" would be worse than no tooltip.
    expect(hoverText(categorical, 2)).toBeNull();
    // …and so is an index past the end.
    expect(hoverText(categorical, 99)).toBeNull();
  });

  it('reports a continuous value with its unit', () => {
    const source: HoverSource = {
      kind: 'continuous',
      name: 'Slc32a1',
      values: Float32Array.from([4.25, 0, NaN]),
      unit: 'log2(CPM+1)',
    };
    expect(hoverText(source, 0)).toEqual(['4.25 log2(CPM+1)', 'Slc32a1']);
    expect(hoverText(source, 1)).toEqual(['0 log2(CPM+1)', 'Slc32a1']);
    // Not measured for this cell — distinct from a measured zero.
    expect(hoverText(source, 2)).toBeNull();
  });

  it('keeps a value readable at either extreme, and needs no unit', () => {
    const big: HoverSource = {
      kind: 'continuous',
      name: 'counts',
      values: Float32Array.from([12345, 0.0001, 3.14159]),
    };
    expect(hoverText(big, 0)).toEqual(['1.23e+4', 'counts']);
    expect(hoverText(big, 1)).toEqual(['1.00e-4', 'counts']);
    expect(hoverText(big, 2)).toEqual(['3.14', 'counts']);
  });

  it('says nothing without a colour source, or without a hit', () => {
    // Nothing is being shown about the cells, so there is no cluster to name.
    expect(hoverText(null, 0)).toBeNull();
    expect(hoverText(categorical, -1)).toBeNull();
  });
});
