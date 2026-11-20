import { BehaviorSubject } from 'rxjs';

import { Rectangle, Region } from '../../models/region';
import { cellposeDiameter } from './cellpose-segmenter.service';
import { CellposeToolContribution, cellDiameterPx } from './cellpose-tool.contribution';

function vizWith(regions: Region[], mppX?: number) {
  return {
    getRegions: () => regions,
    getImageMeta: () => new BehaviorSubject([{ mppX }]),
    segmentRectanglesCellpose: jest.fn().mockResolvedValue(3),
  } as any;
}

describe('CellposeToolContribution', () => {
  const tool = { segmentView: jest.fn().mockResolvedValue(5) } as any;
  const segmenter = {} as any;
  const tiles = {} as any;
  const contribution = new CellposeToolContribution(tool, segmenter, tiles);

  beforeEach(() => tool.segmentView.mockClear());

  it('segments the whole view when no rectangle is drawn, at the µm diameter', async () => {
    const viz = vizWith([], 0.25);
    expect(await contribution.run(viz, { cellDiameterUm: 10, cellDiameterPx: 30 })).toBe(5);
    expect(tool.segmentView).toHaveBeenCalledWith(viz, segmenter, { diameterPx: 40, tileAccess: tiles });
    expect(viz.segmentRectanglesCellpose).not.toHaveBeenCalled();
  });

  it('segments the drawn rectangles when there are any, at the pixel diameter without an mpp', async () => {
    const box = new Region();
    box.bounds = Object.assign(new Rectangle(), { x: 0, y: 0, width: 10, height: 10 });
    const viz = vizWith([box]);
    expect(await contribution.run(viz, { cellDiameterUm: 10, cellDiameterPx: 25 })).toBe(3);
    expect(viz.segmentRectanglesCellpose).toHaveBeenCalledWith({ diameterPx: 25 });
    expect(tool.segmentView).not.toHaveBeenCalled();
  });

  it('shows with its one model and the diameter parameters', () => {
    expect(contribution.models().map((m) => m.id)).toEqual([contribution.defaultModelId()]);
    expect(contribution.params.map((p) => p.id)).toEqual(['cellDiameterUm', 'cellDiameterPx']);
    expect(Object.keys(contribution.defaultParams())).toEqual(['cellDiameterUm', 'cellDiameterPx']);
  });
});

describe('cellDiameterPx', () => {
  it('converts µm with an mpp, else uses px; 0 means as displayed', () => {
    expect(cellDiameterPx({ cellDiameterUm: 12, cellDiameterPx: 30 }, 0.5)).toBe(24);
    expect(cellDiameterPx({ cellDiameterUm: 12, cellDiameterPx: 30 }, null)).toBe(30);
    expect(cellDiameterPx({ cellDiameterUm: 0, cellDiameterPx: 30 }, 0.5)).toBeNull();
  });
});

describe('cellposeDiameter', () => {
  it('omits a missing or ~30-px diameter', () => {
    expect(cellposeDiameter(undefined, 100, 100)).toBeUndefined();
    expect(cellposeDiameter(30.5, 100, 100)).toBeUndefined();
    expect(cellposeDiameter(15, 100, 100)).toBe(15);
  });

  it('raises a diameter that would upscale past 4096²', () => {
    // 2048² at a 10-px diameter would be 6144²: raised to 15 px (4096²).
    expect(cellposeDiameter(10, 2048, 2048)).toBeCloseTo(15);
  });
});
