import { BehaviorSubject, Subject } from 'rxjs';

import { SpatialRegionSetLink, datasetRegionSet, isDatasetImage } from './spatial-region-set';

const tiles = (sets: any[], defaultSet?: string): any => ({ bounds: [0, 0, 1, 1], levels: [], sets, defaultSet });
const ILEUM: any = {
  id: 'ileum',
  imageRef: { imageId: 'demo/ileum.omics/image/plate.ome.tif' },
  polygonTiles: tiles(
    [
      { name: 'cell', label: 'Cells' },
      { name: '3d', label: '3D', regionSource: 'rs-3d' },
    ],
    'cell',
  ),
};
const PLATE: any = { fileName: 'plate.ome.tif' };

describe('datasetRegionSet', () => {
  it("names the default set's region set, else the first set that has one", () => {
    expect(datasetRegionSet(ILEUM)).toBe('rs-3d');
    const both = tiles(
      [
        { name: 'a', label: 'A', regionSource: 'rs-a' },
        { name: 'b', label: 'B', regionSource: 'rs-b' },
      ],
      'b',
    );
    expect(datasetRegionSet({ ...ILEUM, polygonTiles: both })).toBe('rs-b');
    expect(datasetRegionSet({ ...ILEUM, polygonTiles: tiles([{ name: 'cell', label: 'Cells' }]) })).toBeNull();
    expect(datasetRegionSet({ ...ILEUM, polygonTiles: undefined })).toBeNull();
    expect(datasetRegionSet(null)).toBeNull();
  });
});

describe('isDatasetImage', () => {
  it("is the image the dataset's imageRef names, by its file name", () => {
    expect(isDatasetImage(PLATE, ILEUM)).toBe(true);
    expect(isDatasetImage({ fileName: 'demo/ileum.omics/image/plate.ome.tif' } as any, ILEUM)).toBe(true);
    expect(isDatasetImage({ fileName: 'other.tif' } as any, ILEUM)).toBe(false);
    // The reference volume's stack, which a dataset without an imageRef is drawn over.
    expect(isDatasetImage(PLATE, { ...ILEUM, imageRef: undefined })).toBe(false);
    expect(isDatasetImage(null, ILEUM)).toBe(false);
  });
});

describe('SpatialRegionSetLink', () => {
  function link(openRegionSet?: jest.Mock) {
    const dataset$ = new BehaviorSubject<any>(null);
    const port: any = { getDataset$: () => dataset$.asObservable(), openRegionSet };
    const target = { attachDatasetRegionSet: jest.fn().mockResolvedValue(true) };
    const l = new SpatialRegionSetLink(port, target);
    const until$ = new Subject<void>();
    l.bind(until$);
    return { l, dataset$, target, until$ };
  }

  it("attaches the dataset's region set once its image has landed, whichever comes first", async () => {
    const source = {};
    const open = jest.fn().mockResolvedValue(source);
    const { l, dataset$, target } = link(open);
    dataset$.next(ILEUM);
    expect(target.attachDatasetRegionSet).not.toHaveBeenCalled();
    l.imageLanded(PLATE);
    expect(target.attachDatasetRegionSet).toHaveBeenCalledWith(expect.any(Function), 'rs-3d');
    await expect(target.attachDatasetRegionSet.mock.calls[0][0]()).resolves.toBe(source);
    expect(open).toHaveBeenCalledWith('rs-3d');
    // The image first, then the dataset.
    const other = link(jest.fn());
    other.l.imageLanded(PLATE);
    other.dataset$.next(ILEUM);
    expect(other.target.attachDatasetRegionSet).toHaveBeenCalledTimes(1);
  });

  it('attaches nothing over another image, without a set, without a port that opens sets, or once unbound', () => {
    const { l, dataset$, target, until$ } = link(jest.fn());
    dataset$.next(ILEUM);
    l.imageLanded({ fileName: 'other.tif' } as any);
    dataset$.next({ ...ILEUM, polygonTiles: tiles([{ name: 'cell', label: 'Cells' }]) });
    l.imageLanded(PLATE);
    expect(target.attachDatasetRegionSet).not.toHaveBeenCalled();
    until$.next();
    dataset$.next(ILEUM);
    expect(target.attachDatasetRegionSet).not.toHaveBeenCalled();

    const none = link(undefined);
    none.dataset$.next(ILEUM);
    none.l.imageLanded(PLATE);
    expect(none.target.attachDatasetRegionSet).not.toHaveBeenCalled();
  });
});
