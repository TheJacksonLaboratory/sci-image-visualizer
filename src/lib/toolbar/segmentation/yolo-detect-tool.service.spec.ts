import { YoloDetectToolService } from './yolo-detect-tool.service';

/** Minimal IVisualizer stand-in: displayed pixels, a source rect, region store. */
function makeViz(
  opts: {
    width?: number;
    height?: number;
    rect?: { x: number; y: number; width: number; height: number } | null;
    existing?: any[];
  } = {},
) {
  const width = opts.width ?? 100;
  const height = opts.height ?? 100;
  let regions = opts.existing ?? [];
  return {
    getDisplayedPixelData: () => ({
      width,
      height,
      channels: 4,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    getDisplayedSourceRect: () => (opts.rect === undefined ? { x: 0, y: 0, width, height } : opts.rect),
    getRegions: () => regions,
    setRegions: jest.fn((r: any[]) => {
      regions = r;
    }),
    current: () => regions,
  } as any;
}

function segmenterReturning(detections: any[]) {
  const result = { detections, width: 100, height: 100, classNames: [] };
  return { segmentInstances: jest.fn().mockResolvedValue(result) };
}

const outline = (pts: Array<[number, number]>) => ({
  polygons: [{ exterior: pts, holes: [] }],
  box: [0, 0, 1, 1],
  score: 0.9,
  classId: 0,
  className: 'Optic-disc-region',
});

const boxOnly = (x0: number, y0: number, x1: number, y1: number) => ({
  polygons: [],
  box: [x0, y0, x1, y1],
  score: 0.9,
  classId: 0,
  className: 'Optic-disc-region',
});

describe('YoloDetectToolService', () => {
  let tool: YoloDetectToolService;

  beforeEach(() => {
    tool = new YoloDetectToolService(null);
  });

  it('reports plainly when there is nothing on screen', async () => {
    const viz = { getDisplayedPixelData: () => null } as any;
    const statuses: string[] = [];
    tool.status$.subscribe((s) => statuses.push(s));

    await expect(tool.detectInView(viz, segmenterReturning([]) as any)).resolves.toBe(0);
    expect(statuses).toContain('No image on screen to detect in.');
  });

  it('maps detections from view pixels onto full-image coordinates', async () => {
    // A 100px view covering a 1000px region starting at (500, 600): every
    // coordinate scales by 10 and shifts by the origin. Without this the regions
    // would land at view-local coordinates — the wrong place on the slide.
    const viz = makeViz({ width: 100, height: 100, rect: { x: 500, y: 600, width: 1000, height: 1000 } });
    const seg = segmenterReturning([
      outline([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ]),
    ]);

    const added = await tool.detectInView(viz, seg as any);

    expect(added).toBe(1);
    const region = viz.setRegions.mock.calls[0][0][0];
    expect(region.bounds.xpoints).toEqual([500, 600, 600, 500]);
    expect(region.bounds.ypoints).toEqual([600, 600, 700, 700]);
    expect(region.label).toBe('Optic-disc-region');
  });

  it('commits the bounding box when a detection has no outline', async () => {
    const viz = makeViz({ rect: { x: 0, y: 0, width: 100, height: 100 } });
    const seg = segmenterReturning([boxOnly(10, 20, 30, 40)]);

    await tool.detectInView(viz, seg as any);

    const region = viz.setRegions.mock.calls[0][0][0];
    expect(region.bounds.xpoints).toEqual([10, 30, 30, 10]);
    expect(region.bounds.ypoints).toEqual([20, 20, 40, 40]);
  });

  it('appends rather than replacing, so hand-drawn work survives a run', async () => {
    const mine = { label: 'hand-drawn' };
    const viz = makeViz({ existing: [mine] });
    const seg = segmenterReturning([boxOnly(1, 1, 5, 5)]);

    await tool.detectInView(viz, seg as any);

    const committed = viz.setRegions.mock.calls[0][0];
    expect(committed).toHaveLength(2);
    expect(committed[0]).toBe(mine);
  });

  it('does not touch the region store when nothing is detected', async () => {
    const viz = makeViz();
    const statuses: string[] = [];
    tool.status$.subscribe((s) => statuses.push(s));

    await expect(tool.detectInView(viz, segmenterReturning([]) as any)).resolves.toBe(0);
    expect(viz.setRegions).not.toHaveBeenCalled();
    expect(statuses).toContain('No objects detected.');
  });

  it('surfaces a failure instead of throwing, and clears busy', async () => {
    const viz = makeViz();
    const seg = { segmentInstances: jest.fn().mockRejectedValue(new Error('model gone')) };
    const statuses: string[] = [];
    tool.status$.subscribe((s) => statuses.push(s));

    await expect(tool.detectInView(viz, seg as any)).resolves.toBe(0);
    expect(statuses).toContain('model gone');
    expect(tool.busy$.value).toBe(false);
  });

  it('runs on the displayed pixels when no tile access is available', async () => {
    // downsamplingFactor asks for a finer crop, but without a TileAccessPort
    // there is nothing to fetch it with — the run proceeds rather than failing.
    const viz = makeViz({ width: 100, height: 100, rect: { x: 0, y: 0, width: 1000, height: 1000 } });
    const seg = segmenterReturning([]);

    await tool.detectInView(viz, seg as any, { downsamplingFactor: 2 });

    expect(seg.segmentInstances).toHaveBeenCalled();
    expect(seg.segmentInstances.mock.calls[0][0].width).toBe(100);
  });
});
