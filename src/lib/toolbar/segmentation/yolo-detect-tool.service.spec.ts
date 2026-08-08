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

  it('keeps hand-drawn work, which carries no source marker', async () => {
    const mine = { label: 'hand-drawn' };
    const viz = makeViz({ existing: [mine] });
    const seg = segmenterReturning([boxOnly(1, 1, 5, 5)]);

    await tool.detectInView(viz, seg as any);

    const committed = viz.setRegions.mock.calls[0][0];
    expect(committed).toHaveLength(2);
    expect(committed[0]).toBe(mine);
  });

  it('replaces its own previous output instead of stacking on it', async () => {
    // Every tuning run used to pile onto the last, so the viewer accumulated
    // overlapping results from parameters no longer in effect.
    const stale = { label: 'retina', source: 'yolo' };
    const mine = { label: 'hand-drawn' };
    const otherTool = { label: 'cell', source: 'cellpose' };
    const viz = makeViz({ existing: [stale, mine, otherTool] });
    const seg = segmenterReturning([boxOnly(1, 1, 5, 5)]);

    await tool.detectInView(viz, seg as any);

    const committed = viz.setRegions.mock.calls[0][0];
    expect(committed).not.toContain(stale);
    expect(committed).toContain(mine);
    expect(committed).toContain(otherTool);
    expect(committed).toHaveLength(3); // hand-drawn + other tool + the new one
  });

  it('marks what it produces so the next run can find it', async () => {
    const viz = makeViz();
    const seg = segmenterReturning([boxOnly(1, 1, 5, 5)]);

    await tool.detectInView(viz, seg as any);

    expect(viz.setRegions.mock.calls[0][0][0].source).toBe('yolo');
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

  it('keeps the crop dimensions after closing the bitmap', async () => {
    // Closing an ImageBitmap zeroes its width/height. Reading them after close
    // returned a 0x0 image carrying a full pixel buffer, so inference ran on
    // nothing and reported no detections — with no error anywhere.
    const bitmap = { width: 1187, height: 916, close: jest.fn() };
    // close() zeroes the dimensions, as the real thing does.
    bitmap.close.mockImplementation(() => {
      bitmap.width = 0;
      bitmap.height = 0;
    });
    (globalThis as any).createImageBitmap = jest.fn().mockResolvedValue(bitmap);
    (globalThis as any).Blob = class {};

    const captured: any[] = [];
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: jest.fn(),
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          captured.push({ w, h });
          return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4) };
        },
      }),
    };
    jest.spyOn(document, 'createElement').mockReturnValue(canvas as any);

    const tileAccess = {
      zoomOnRegion: () => ({
        subscribe: (o: any) => {
          o.next(new ArrayBuffer(1024));
          o.complete?.();
          return { unsubscribe() {} };
        },
      }),
    } as any;

    const withTiles = new YoloDetectToolService(tileAccess);
    const viz = makeViz({ width: 100, height: 100, rect: { x: 0, y: 0, width: 1000, height: 1000 } });
    const seg = segmenterReturning([]);

    await withTiles.detectInView(viz, seg as any, { downsamplingFactor: 2 });

    // The crop was used, at its real size rather than 0x0.
    expect(captured[0]).toEqual({ w: 1187, h: 916 });
    expect(seg.segmentInstances.mock.calls[0][0].width).toBe(1187);
    expect(seg.segmentInstances.mock.calls[0][0].height).toBe(916);

    (document.createElement as any).mockRestore();
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
