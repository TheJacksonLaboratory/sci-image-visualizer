import { DEFAULT_SPATIAL_VIEW } from '../../../contracts/display-types';
import type { SpatialDataPort } from '../../../contracts/ports/spatial-data.port';
import type { SpatialDataset } from '../../../contracts/spatial-dataset.contract';
import { CategoricalLookup } from './categorical-lookup';

describe('CategoricalLookup', () => {
  const meta = { kind: 'categorical', name: 'cluster', categories: ['T cell', 'B cell', 'NK'] };
  const codes = Uint16Array.of(0, 2, 1);
  const port = {
    getColumn: jest.fn(async (name: string) =>
      name === 'cluster' ? { meta, codes } : { meta: { kind: 'continuous', name }, values: new Float32Array(3) },
    ),
  } as unknown as SpatialDataPort;
  const dataset = { columns: [meta] } as unknown as SpatialDataset;

  it("reads a categorical column's codes, and nothing for a continuous one", async () => {
    const lookup = new CategoricalLookup(port);
    expect(await lookup.codes('cluster')).toEqual({ codes, meta });
    expect(await lookup.codes('area')).toBeNull();
  });

  it('flags the switched-off groups of the cell-type column', async () => {
    const lookup = new CategoricalLookup(port);
    const view = { ...DEFAULT_SPATIAL_VIEW, hiddenGroups: ['B cell'] };
    expect(await lookup.hiddenCodes(dataset, view)).toEqual({ codes, hidden: Uint8Array.of(0, 1, 0) });
  });

  it('asks for nothing while no group is switched off', async () => {
    const getColumn = jest.fn();
    const lookup = new CategoricalLookup({ getColumn } as unknown as SpatialDataPort);
    expect(await lookup.hiddenCodes(dataset, DEFAULT_SPATIAL_VIEW)).toBeNull();
    expect(getColumn).not.toHaveBeenCalled();
  });
});
