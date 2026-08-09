import { RetinalLayerToolService } from './retinal-layer-tool.service';

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
  } as any;
}

const region = (
  pts: Array<[number, number]>,
  className = 'ONL',
  classId = 1,
  holes: Array<Array<[number, number]>> = [],
) => ({
  exterior: pts,
  holes,
  classId,
  className,
  area: 100,
});

function segmenterReturning(regions: any[], unassignedFraction = 0) {
  return {
    segmentSemantic: jest.fn().mockResolvedValue({
      regions,
      classAreas: [0, 100, 0, 0],
      classNames: ['bg', 'ONL', 'INL', 'GCL'],
      width: 100,
      height: 100,
      unassignedFraction,
    }),
  };
}

describe('RetinalLayerToolService', () => {
  let tool: RetinalLayerToolService;

  beforeEach(() => {
    tool = new RetinalLayerToolService(null);
  });

  it('reports plainly when there is nothing on screen', async () => {
    const viz = { getDisplayedPixelData: () => null } as any;
    const statuses: string[] = [];
    tool.status$.subscribe((s) => statuses.push(s));

    await expect(tool.segmentInView(viz, segmenterReturning([]) as any)).resolves.toBe(0);
    expect(statuses).toContain('No image on screen to segment.');
  });

  it('maps layers from view pixels onto full-image coordinates', async () => {
    // A 100px view covering a 1000px region starting at (500, 600): every
    // coordinate scales by 10 and shifts by the origin. Without this the regions
    // would land at view-local coordinates — the wrong place on the slide.
    const viz = makeViz({ rect: { x: 500, y: 600, width: 1000, height: 1000 } });
    const seg = segmenterReturning([
      region([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ]),
    ]);

    const added = await tool.segmentInView(viz, seg as any);

    expect(added).toBe(1);
    const committed = viz.setRegions.mock.calls[0][0][0];
    expect(committed.bounds.xpoints).toEqual([500, 600, 600, 500]);
    expect(committed.bounds.ypoints).toEqual([600, 600, 700, 700]);
    expect(committed.label).toBe('ONL');
  });

  it('keeps interior voids as holes instead of filling them in', async () => {
    // A layer with a void through it is a donut. Committing only the exterior
    // silently fills it, which reads as a segmentation that over-covers rather
    // than as lost geometry.
    const viz = makeViz({ rect: { x: 0, y: 0, width: 100, height: 100 } });
    const seg = segmenterReturning([
      region(
        [
          [0, 0],
          [30, 0],
          [30, 30],
          [0, 30],
        ],
        'ONL',
        1,
        [
          [
            [10, 10],
            [20, 10],
            [20, 20],
            [10, 20],
          ],
        ],
      ),
    ]);

    await tool.segmentInView(viz, seg as any);

    const committed = viz.setRegions.mock.calls[0][0][0];
    expect(committed.bounds.holes).toEqual([
      [
        [10, 10],
        [20, 10],
        [20, 20],
        [10, 20],
      ],
    ]);
  });

  it('maps hole coordinates through the same transform as the exterior', async () => {
    // A hole left in view-local pixels would land somewhere else entirely on
    // the slide — often outside its own exterior.
    const viz = makeViz({ rect: { x: 500, y: 600, width: 1000, height: 1000 } });
    const seg = segmenterReturning([
      region(
        [
          [0, 0],
          [30, 0],
          [30, 30],
        ],
        'ONL',
        1,
        [
          [
            [10, 10],
            [20, 10],
            [20, 20],
          ],
        ],
      ),
    ]);

    await tool.segmentInView(viz, seg as any);

    expect(viz.setRegions.mock.calls[0][0][0].bounds.holes).toEqual([
      [
        [600, 700],
        [700, 700],
        [700, 800],
      ],
    ]);
  });

  it('leaves holes unset for a solid region', async () => {
    // An empty array would travel through export and round-tripping as if the
    // region were a donut with no rings.
    const viz = makeViz();
    const seg = segmenterReturning([
      region([
        [0, 0],
        [5, 0],
        [5, 5],
      ]),
    ]);

    await tool.segmentInView(viz, seg as any);

    expect(viz.setRegions.mock.calls[0][0][0].bounds.holes).toBeUndefined();
  });

  it('drops a degenerate hole rather than emitting unbounded geometry', async () => {
    const viz = makeViz();
    const seg = segmenterReturning([
      region(
        [
          [0, 0],
          [30, 0],
          [30, 30],
        ],
        'ONL',
        1,
        [
          [
            [10, 10],
            [20, 10],
          ],
        ],
      ),
    ]);

    await tool.segmentInView(viz, seg as any);

    expect(viz.setRegions.mock.calls[0][0][0].bounds.holes).toBeUndefined();
  });

  it('marks what it produces so the next run can find it', async () => {
    const viz = makeViz();
    const seg = segmenterReturning([
      region([
        [0, 0],
        [5, 0],
        [5, 5],
      ]),
    ]);

    await tool.segmentInView(viz, seg as any);

    expect(viz.setRegions.mock.calls[0][0][0].source).toBe('retinal-layer');
  });

  it('replaces its own previous output but keeps everything else', async () => {
    const stale = { label: 'ONL', source: 'retinal-layer' };
    const mine = { label: 'hand-drawn' };
    const otherTool = { label: 'cell', source: 'yolo' };
    const viz = makeViz({ existing: [stale, mine, otherTool] });
    const seg = segmenterReturning([
      region([
        [0, 0],
        [5, 0],
        [5, 5],
      ]),
    ]);

    await tool.segmentInView(viz, seg as any);

    const committed = viz.setRegions.mock.calls[0][0];
    expect(committed).not.toContain(stale);
    expect(committed).toContain(mine);
    expect(committed).toContain(otherTool);
    expect(committed).toHaveLength(3);
  });

  it('drops a degenerate ring rather than committing a two-point region', async () => {
    const viz = makeViz();
    const seg = segmenterReturning([
      region([
        [0, 0],
        [1, 1],
      ]),
    ]);

    await expect(tool.segmentInView(viz, seg as any)).resolves.toBe(0);
    expect(viz.setRegions).not.toHaveBeenCalled();
  });

  it('says when the model was unsure everywhere, not just that it found nothing', async () => {
    // The signature of wrong preprocessing or the wrong magnification. Reporting
    // it as a plain "no layers found" makes a misconfiguration look like a
    // legitimately empty field.
    const viz = makeViz();
    const statuses: string[] = [];
    tool.status$.subscribe((s) => statuses.push(s));

    await tool.segmentInView(viz, segmenterReturning([], 0.97) as any);

    expect(statuses.some((s) => s.includes('unsure across the whole view'))).toBe(true);
  });

  it('reports a plain empty result when the model was confident', async () => {
    const viz = makeViz();
    const statuses: string[] = [];
    tool.status$.subscribe((s) => statuses.push(s));

    await tool.segmentInView(viz, segmenterReturning([], 0.05) as any);

    expect(statuses).toContain('No layers found.');
  });

  it('surfaces a failure instead of throwing, and clears busy', async () => {
    const viz = makeViz();
    const seg = { segmentSemantic: jest.fn().mockRejectedValue(new Error('WebGPU required')) };
    const statuses: string[] = [];
    tool.status$.subscribe((s) => statuses.push(s));

    await expect(tool.segmentInView(viz, seg as any)).resolves.toBe(0);
    expect(statuses).toContain('WebGPU required');
    expect(tool.busy$.value).toBe(false);
  });

  it('runs on the displayed pixels when no tile access is available', async () => {
    // downsamplingFactor asks for a finer crop, but without a TileAccessPort
    // there is nothing to fetch it with — the run proceeds rather than failing.
    const viz = makeViz({ rect: { x: 0, y: 0, width: 1000, height: 1000 } });
    const seg = segmenterReturning([]);

    await tool.segmentInView(viz, seg as any, { downsamplingFactor: 1 });

    expect(seg.segmentSemantic).toHaveBeenCalled();
    expect(seg.segmentSemantic.mock.calls[0][0].width).toBe(100);
  });

  it('keeps the crop dimensions after closing the bitmap', async () => {
    // Closing an ImageBitmap zeroes its width/height. Reading them after close
    // returned a 0x0 image carrying a full pixel buffer, so inference ran on
    // nothing and reported no layers — with no error anywhere.
    const bitmap = { width: 1187, height: 916, close: jest.fn() };
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

    const withTiles = new RetinalLayerToolService(tileAccess);
    const viz = makeViz({ rect: { x: 0, y: 0, width: 1000, height: 1000 } });
    const seg = segmenterReturning([]);

    await withTiles.segmentInView(viz, seg as any, { downsamplingFactor: 2 });

    expect(captured[0]).toEqual({ w: 1187, h: 916 });
    expect(seg.segmentSemantic.mock.calls[0][0].width).toBe(1187);
    expect(seg.segmentSemantic.mock.calls[0][0].height).toBe(916);

    (document.createElement as any).mockRestore();
  });
});
