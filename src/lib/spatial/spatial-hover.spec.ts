import { CellInfo, HoverSource, cellText, cellTypeText, hoverText } from './spatial-hover';
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

describe('3D cell tooltips', () => {
  const info: CellInfo = {
    typeName: 'cell_type',
    categories: ['Macrophage + DC', 'Goblet'],
    codes: Uint16Array.of(1, 0, 0),
    counts: Uint32Array.of(2, 1),
    ids: ['c1', 'c2', 'c3'],
    measures: [{ name: 'n_transcripts', values: Float32Array.of(12, 30, 7) }],
  };

  it("names a cell's type and id, the colouring's value and its measurements", () => {
    const area: HoverSource = { kind: 'continuous', name: 'area', values: Float32Array.of(1, 2, 3) };
    expect(cellText(info, 1, area)).toEqual(['Macrophage + DC', 'Cell c2', 'area: 2', 'n_transcripts: 30']);
    // Coloured by the type itself: not said twice.
    const byType: HoverSource = {
      kind: 'categorical',
      name: 'cell_type',
      categories: info.categories,
      codes: info.codes!,
    };
    expect(cellText(info, 0, byType)).toEqual(['Goblet', 'Cell c1', 'n_transcripts: 12']);
    expect(cellText(null, 0, area)).toBeNull();
  });

  it("names a cell type's surface and how many cells it has", () => {
    expect(cellTypeText(info, 'Macrophage + DC')).toEqual(['Macrophage + DC', '2 cells · cell_type']);
    expect(cellTypeText(null, 'X', 'X · a region')[0]).toBe('X · a region');
  });
});
