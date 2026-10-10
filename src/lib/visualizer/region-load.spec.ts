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
});
