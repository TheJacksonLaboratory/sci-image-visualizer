import { ISpatialControls } from '../contracts/visualizer.contract';
import { SpatialDataset } from '../contracts/spatial-dataset.contract';
import { GENE_OPTIONS_MAX } from '../spatial/gene-search';
import { GenePickerModel } from './spatial-gene-picker';

const withNames = (names: string[]): SpatialDataset => ({
  id: 'inline', name: 'inline',
  observations: { count: 0, x: new Float32Array(0), y: new Float32Array(0) },
  columns: [],
  features: { count: names.length, names },
});
const remote = (id: string): SpatialDataset => ({
  id, name: id,
  observations: { count: 0, x: new Float32Array(0), y: new Float32Array(0) },
  columns: [],
  features: { count: 31_000 },
});

describe('GenePickerModel', () => {
  let searchFeatures: jest.Mock;
  let chosen: string[];
  let picker: GenePickerModel;
  const values = () => picker.options.map((o) => o.value);

  beforeEach(() => {
    searchFeatures = jest.fn(async () => ['Ttr']);
    chosen = [];
    const controls = { searchFeatures } as unknown as ISpatialControls;
    picker = new GenePickerModel(() => controls, () => chosen);
  });

  it('starts empty and local', () => {
    expect(picker.options).toEqual([]);
    expect(picker.remote).toBe(false);
    expect(picker.failed).toBe(false);
  });

  describe('with the names inlined', () => {
    it('lists them, and narrows them itself without the port', async () => {
      picker.setDataset(withNames(['Ttr', 'Mbp']));
      expect(values()).toEqual(['Ttr', 'Mbp']);
      await picker.onFilter('tt');
      expect(values()).toEqual(['Ttr']);
      expect(searchFeatures).not.toHaveBeenCalled();
    });

    it('materialises only the head of a long list, but searches all of it', async () => {
      const names = Array.from({ length: 18078 }, (_, i) => `Gene${i}`);
      picker.setDataset(withNames(names));
      expect(picker.options.length).toBe(GENE_OPTIONS_MAX);
      expect(picker.residentCount).toBe(18078);
      await picker.onFilter('Gene17999');
      expect(values()).toEqual(['Gene17999']);
    });

    it('keeps the chosen genes among the options', async () => {
      picker.setDataset(withNames(['Ttr', 'Mbp']));
      chosen = ['Snap25'];
      await picker.onFilter('tt');
      expect(values()).toEqual(['Snap25', 'Ttr']);
    });

    it('emits each change on state$, for an OnPush dropdown', async () => {
      const seen: string[][] = [];
      picker.state$.subscribe((s) => seen.push(s.options.map((o) => o.value)));
      picker.setDataset(withNames(['Ttr', 'Mbp']));
      await picker.onFilter('mb');
      expect(seen).toEqual([[], ['Ttr', 'Mbp'], ['Mbp']]);
    });
  });

  describe('with the names served per query', () => {
    beforeEach(() => picker.setDataset(remote('A')));

    it('asks the port per keystroke, and empties on a cleared filter', async () => {
      expect(picker.remote).toBe(true);
      await picker.onFilter('tt');
      expect(searchFeatures).toHaveBeenCalledWith('tt', 50);
      expect(values()).toEqual(['Ttr']);
      await picker.onFilter('');
      expect(values()).toEqual([]);
    });

    it('surfaces a failure, and clears it on the next keystroke', async () => {
      searchFeatures.mockRejectedValueOnce(new Error('offline'));
      await picker.onFilter('tt');
      expect(picker.failed).toBe(true);
      expect(values()).toEqual([]);
      await picker.onFilter('ttr');
      expect(picker.failed).toBe(false);
    });

    it('keeps the answer for the query in the box, not an earlier slower one', async () => {
      let resolveSlow: (v: string[]) => void = () => undefined;
      searchFeatures
        .mockImplementationOnce(() => new Promise((r) => { resolveSlow = r; }))
        .mockResolvedValueOnce(['Ttr']);
      const slow = picker.onFilter('Tt');
      await picker.onFilter('Ttr');
      resolveSlow(['Tt-one']);
      await slow;
      expect(values()).toEqual(['Ttr']);
    });

    it('loads the whole list once on first open, then filters locally', async () => {
      searchFeatures.mockResolvedValue(['A1BG', 'EPCAM', 'EPHA2']);
      await picker.ensureList();
      expect(searchFeatures).toHaveBeenCalledWith('', 100_000);
      expect(picker.remote).toBe(false);
      expect(values()).toEqual(['A1BG', 'EPCAM', 'EPHA2']);
      searchFeatures.mockClear();
      await picker.onFilter('EP');
      await picker.ensureList();
      expect(searchFeatures).not.toHaveBeenCalled();
    });

    it("drops a list fetched for the previous dataset, and loads the new one's", async () => {
      let resolveA: (v: string[]) => void = () => undefined;
      searchFeatures
        .mockImplementationOnce(() => new Promise((r) => { resolveA = r; }))
        .mockResolvedValueOnce(['B-gene']);
      const loadingA = picker.ensureList();
      picker.setDataset(remote('B'));
      resolveA(['A-gene']);
      await loadingA;
      expect(picker.remote).toBe(true);
      expect(values()).not.toContain('A-gene');
      await picker.ensureList();
      expect(values()).toEqual(['B-gene']);
    });

    it('applies async results through the owner\'s `run`', async () => {
      const run = jest.fn((fn: () => void) => fn());
      const controls = { searchFeatures } as unknown as ISpatialControls;
      const zoned = new GenePickerModel(() => controls, () => [], run);
      zoned.setDataset(remote('A'));
      await zoned.onFilter('tt');
      expect(run).toHaveBeenCalled();
    });
  });

  it('does nothing remote without a port', async () => {
    const orphan = new GenePickerModel(() => null, () => []);
    orphan.setDataset(remote('A'));
    await orphan.onFilter('tt');
    await orphan.ensureList();
    expect(orphan.options).toEqual([]);
  });
});
