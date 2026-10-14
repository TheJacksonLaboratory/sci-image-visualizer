import { applyImageRois, RegionLoadTarget } from './region-load';
import { IImageInfo } from '../contracts/image.contract';
import { Region } from '../models/region';

/** The layout table is pinned end-to-end in visualizer.component.spec.ts; these cover the pure function. */
describe('applyImageRois', () => {
  const region = (z?: number): Region => Object.assign(new Region(), z === undefined ? {} : { z });
  const fixtures: Record<string, Region[]> = { A: [region()], Z: [region(1), region(0)] };
  let target: jest.Mocked<RegionLoadTarget>;

  beforeEach(() => {
    target = {
      importRegions: jest.fn((json: string) => fixtures[json] ?? []),
      enterStackMode: jest.fn(),
      setRegions: jest.fn(),
      resetUndoHistory: jest.fn(),
    };
  });

  const info = (over: Partial<IImageInfo>): IImageInfo => ({
    fileName: 'f',
    urls: ['/0', '/1'],
    isStack: true,
    showStack: false,
    isGrayscale: true,
    trueImageSize: [1, 1],
    imageMeta: [],
    scaleRatio: true,
    ...over,
  });

  it('a folder stack sizes its slices from the urls, else from roiJsonStrs', () => {
    applyImageRois(
      info({ tiled: false, urls: undefined as unknown as string[], roiJsonStrs: ['A', 'A', 'A'] }),
      target,
      2,
    );
    const [slices, z, layout] = target.enterStackMode.mock.calls[0];
    expect([...slices.keys()]).toEqual([0, 1, 2]);
    expect(z).toBe(2);
    expect(layout).toBe('per-slice-file');
  });

  it('a z-indexed single-file stack is bucketed by slice', () => {
    applyImageRois(info({ roiJsonStr: 'Z' }), target, 0);
    const [slices] = target.enterStackMode.mock.calls[0];
    expect(slices.get(0)).toEqual([fixtures['Z'][1]]);
    expect(slices.get(1)).toEqual([fixtures['Z'][0]]);
    expect(target.resetUndoHistory).not.toHaveBeenCalled();
  });

  it('a single plane sets its regions and starts the undo history fresh', () => {
    applyImageRois(info({ isStack: false, roiJsonStr: 'A' }), target, 0);
    expect(target.setRegions).toHaveBeenCalledWith(fixtures['A']);
    expect(target.resetUndoHistory).toHaveBeenCalled();
    expect(target.enterStackMode).not.toHaveBeenCalled();
  });

  describe('region sources', () => {
    const BIG = JSON.stringify({ type: 'FeatureCollection', features: [] });
    let attach: jest.Mock;
    beforeEach(() => {
      attach = jest.fn();
      target.attachRegionSource = attach;
    });

    it('loads a large single-plane file as a source, starting the image afresh', async () => {
      applyImageRois(info({ isStack: false, roiJsonStr: BIG }), target, 0, 10);
      expect(target.importRegions).not.toHaveBeenCalled();
      expect(target.setRegions).toHaveBeenCalledWith([]);
      const [open, slices] = attach.mock.calls[0];
      expect(slices).toEqual({ slice: 0 });
      expect((await open()).info.featureCount).toBe(0);
      expect(target.resetUndoHistory).toHaveBeenCalled();
    });

    it('serves a large z-indexed stack file slice by slice from its planes', () => {
      applyImageRois(info({ roiJsonStr: BIG }), target, 1, 10);
      expect(target.enterStackMode).toHaveBeenCalledWith(new Map(), 1, 'combined');
      expect(attach.mock.calls[0][1]).toBe('planes');
    });

    it('gives each large slice file of a folder stack its own lazy source', () => {
      applyImageRois(info({ tiled: false, roiJsonStrs: ['A', BIG] }), target, 0, 10);
      const [slices] = target.enterStackMode.mock.calls[0];
      expect(slices.get(0)).toEqual(fixtures['A']);
      expect(slices.get(1)).toEqual([]);
      expect(attach).toHaveBeenCalledTimes(1);
      expect(attach.mock.calls[0][1]).toEqual({ slice: 1 });
    });

    it('keeps small files as regions, and everything as regions without source support', () => {
      applyImageRois(info({ isStack: false, roiJsonStr: 'A' }), target, 0, 10);
      expect(attach).not.toHaveBeenCalled();
      delete target.attachRegionSource;
      applyImageRois(info({ isStack: false, roiJsonStr: BIG }), target, 0, 10);
      expect(target.importRegions).toHaveBeenCalledWith(BIG);
    });

    it("uses the image's server-side source over its file", () => {
      applyImageRois(info({ isStack: false, roiJsonStr: 'A', regionSourceUrl: 'http://x/regions' }), target, 0);
      expect(target.importRegions).not.toHaveBeenCalled();
      expect(attach).toHaveBeenCalledTimes(1);
    });
  });
});
