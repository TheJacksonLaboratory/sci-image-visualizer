import { ISpatialControls } from '../../contracts/visualizer.contract';
import { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import { SpatialKeyModel } from './spatial-key.model';

const dataset = {
  columns: [
    { kind: 'categorical', name: 'region', categories: ['Cortex', 'Thalamus'] },
    { kind: 'categorical', name: 'zone', categories: ['Z'] },
    { kind: 'continuous', name: 'total_counts' },
  ],
} as unknown as SpatialDataset;

describe('SpatialKeyModel', () => {
  let categoryColors: jest.Mock;
  let controls: ISpatialControls;
  let key: SpatialKeyModel;
  const view = (colorBy: unknown, continuousColormap: unknown = null) =>
    ({ colorBy, continuousColormap }) as never;

  beforeEach(() => {
    categoryColors = jest.fn(async () => ['#f00', '#00f']);
    controls = { categoryColors } as unknown as ISpatialControls;
    key = new SpatialKeyModel();
  });

  it("builds a legend from the renderer's category colours", async () => {
    await key.refresh(controls, dataset, view({ kind: 'column', name: 'region' }), null, false);
    expect(categoryColors).toHaveBeenCalledWith('region');
    expect(key.legend).toEqual([
      { label: 'Cortex', color: '#f00' },
      { label: 'Thalamus', color: '#00f' },
    ]);
    expect(key.colorBarCss).toBeNull();
    expect(key.isCategorical).toBe(true);
  });

  it('builds a colour bar for a continuous column or a gene, following the override', async () => {
    await key.refresh(controls, dataset, view({ kind: 'feature', name: 'Ttr' }), null, false);
    expect(key.legend).toBeNull();
    const viridis = key.colorBarCss!;
    expect(viridis).toContain('linear-gradient');
    await key.refresh(controls, dataset, view({ kind: 'column', name: 'total_counts' }, 'Reds'), null, false);
    expect(key.colorBarCss).not.toBe(viridis);
  });

  it('is empty without a colouring, without a port, and when the colours cannot be read', async () => {
    await key.refresh(controls, dataset, view(null), null, false);
    expect(key.legend).toBeNull();
    expect(key.colorBarCss).toBeNull();
    await key.refresh(null, dataset, view({ kind: 'column', name: 'region' }), null, false);
    expect(key.legend).toBeNull();
    categoryColors.mockRejectedValueOnce(new Error('not loaded'));
    await key.refresh(controls, dataset, view({ kind: 'column', name: 'region' }), null, false);
    expect(key.legend).toBeNull();
  });

  it('keeps the legend of the column selected last when an earlier one answers late', async () => {
    let resolveSlow: (v: string[]) => void = () => undefined;
    categoryColors
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSlow = r;
          }),
      )
      .mockResolvedValueOnce(['#0f0']);
    const slow = key.refresh(controls, dataset, view({ kind: 'column', name: 'region' }), null, false);
    await key.refresh(controls, dataset, view({ kind: 'column', name: 'zone' }), null, false);
    resolveSlow(['#f00', '#00f']);
    await slow;
    expect(key.legend).toEqual([{ label: 'Z', color: '#0f0' }]);
  });

  it('drops a legend that lands after the colouring was cleared', async () => {
    let resolveSlow: (v: string[]) => void = () => undefined;
    categoryColors.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveSlow = r;
        }),
    );
    const slow = key.refresh(controls, dataset, view({ kind: 'column', name: 'region' }), null, false);
    await key.refresh(controls, dataset, view(null), null, false);
    resolveSlow(['#f00', '#00f']);
    await slow;
    expect(key.legend).toBeNull();
  });
});
