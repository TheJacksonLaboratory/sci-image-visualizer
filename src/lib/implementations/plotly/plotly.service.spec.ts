import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';

import { PlotlyService, PlotType } from './plotly.service';
import { VIZ_PORT_STUBS } from '../../testing/viz-port-stubs';
import { InjectionToken } from '@angular/core';
import { MessageService } from 'primeng/api';
import { IImageInfo } from '../../contracts/image.contract';
import { Region, Rectangle } from '../../models/region';
import { Image } from 'image-js';
import * as Plotly from 'plotly.js-dist-min';
import * as path from 'path';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { RegionStore } from '../../store/region-store.service';
import { IChannelState } from '../../contracts/channel-histogram-api.contract';
import { TILE_ACCESS_PORT } from '../../contracts/ports/tile-access.port';
import { Subject } from 'rxjs';

describe('PlotlyService', () => {
  let service: PlotlyService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PlotlyService, ...VIZ_PORT_STUBS,
        MessageService
      ]
    });
    service = TestBed.inject(PlotlyService);
  });


  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('a re-plot before anything was plotted stops the spinner instead of throwing', () => {
    // A host's first view can be an image-less spatial dataset: no image size was ever set.
    type State = { setImageLoading(v: boolean): void; setImageInfo(i: unknown): void };
    const state = (service as unknown as { state: State }).state;
    const loading = jest.spyOn(state, 'setImageLoading');
    const info = jest.spyOn(state, 'setImageInfo');
    expect(() => service.reloadAndPlot()).not.toThrow();
    expect(loading).toHaveBeenCalledWith(false);
    expect(info).not.toHaveBeenCalled();
  });

});

describe('PlotlyService load and plot image', () => {
  let service: PlotlyService;
  let urls: string[];
  let imageInfo: IImageInfo;
  let screenHeight: number;

  beforeAll(async() => {
    urls = [path.join(__dirname, 'test_grayscale.png')];
    imageInfo = ({} as IImageInfo);
    imageInfo.urls = urls;
    imageInfo.trueImageSize = [ 1344, 1024 ];
    imageInfo.scaleRatio = true;
    imageInfo.isGrayscale = true;
    imageInfo.showStack = false;

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PlotlyService, ...VIZ_PORT_STUBS,
        MessageService
      ]
    });
    service = TestBed.inject(PlotlyService);
    // Bypass HttpClient for local file paths in tests — auth headers not needed here
    jest.spyOn(service as any, 'loadImage').mockImplementation((url: unknown) => Image.load(url as string));
    // canvas size
    screenHeight = 811;
    // create DOM element
    document.body.innerHTML = '<div id="plot"></div>';
  });

  it('Should load and plot grayscale image',  async() => {
    let imgLoaded!: {data: any[], ratios: number[], sizes: any[]};

    // load
    await service.load(imageInfo, 0).then(imageLoaded => {
      console.log('image loaded:');
      imgLoaded = imageLoaded;
      const imgData = JSON.stringify(imgLoaded.data);
      expect(imgData).toContain('[[[99,105,102,104,102,104,105,102,101,106,104,102,97,105,103,103,106,103,104,106,101,100,109,107,106,106,103,103,105,100,103,104,107,105,108,105,104,105,104,107,103,103,103,105,100,106,106,102,104,105,104,104,107,105,108,103,104,102,102,105,102,102,100,103,102,103,100,101,104,102,105,106,101,100,104,105,109,103,104,100,108,105,103,102,104,109,106,108,107,106,109,107,105,102,104,99,105,106,103,103,105,108,107,109,107,105,106,107,109,103,102,101,105,105,105,105,109,104,100,103,100,99,104,110,107,103,103,101,103,105,102,102,101,103,104,106,106,108,104,105,101,109,106,105,107,106,107,111,109,108,108,107,107,102,102,100,101,104,103,105,106,106,107,110,103,105,104,104');
      expect(imgLoaded.ratios).toStrictEqual([1.3125,1.3128205128205128]);
      expect(imgLoaded.sizes).toStrictEqual([1024,780]);
    });
    // plot
    await service.plot('plot', imgLoaded, imageInfo, screenHeight, PlotType.HEATMAP).then(result => {
      console.log(result);
      expect(result).toBe(true);
    });
  });
});

describe('PlotlyService relayout handler', () => {
  let service: PlotlyService;
  let relayoutSpy: jest.SpyInstance;
  let triggerZoomSpy: jest.SpyInstance;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PlotlyService, ...VIZ_PORT_STUBS,
        MessageService
      ]
    });
    service = TestBed.inject(PlotlyService);

    // Set up internal state needed by the relayout handler
    (service as any).plotDiv = 'plot';
    (service as any).shapes = [];
    (service as any).imageInfo = { showStack: false, isGrayscale: true } as IImageInfo;
    (service as any).trueImgSize = [0, 1344, 0, 1024];
    (service as any).isRealZoom = true;

    document.body.innerHTML = '<div id="plot"></div>';

    relayoutSpy = jest.spyOn(Plotly, 'relayout').mockResolvedValue({} as any);
    triggerZoomSpy = jest.spyOn(service as any, 'triggerZoom').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('re-binding the relayout handler on an in-place render does not stack it (OSD-PLOTLY-7)', () => {
    // Plotly's gd.on() registers on its own EventEmitter (removeListener), not
    // the DOM — removeEventListener never unbound the previous handler.
    const listeners: Record<string, Array<(e: unknown) => void>> = {};
    const plot = document.getElementById('plot') as any;
    plot.on = (name: string, fn: (e: unknown) => void) => { (listeners[name] ??= []).push(fn); };
    plot.removeListener = (name: string, fn: (e: unknown) => void) => {
      listeners[name] = (listeners[name] ?? []).filter((f) => f !== fn);
    };
    const handler = jest.spyOn(service as any, 'relayoutEventHandler').mockImplementation(() => undefined);
    (service as any).setEvents('plot', true, 600);
    (service as any).setEvents('plot', true, 600); // the in-place (large) pass
    listeners['plotly_relayout'].forEach((fn) => fn({ 'xaxis.range[0]': 1 }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should not process zoom-to-box shapes in relayout handler', () => {
    service.setZoomToBoxMode(true);
    relayoutSpy.mockClear();

    // Simulate a shape event while in zoom-to-box mode — should be treated
    // as a regular shape, not a zoom action (zoom is handled by the canvas overlay)
    const event = { shapes: [{ x0: 100, x1: 500, y0: 200, y1: 800, type: 'rect' }] };
    (service as any).relayoutEventHandler(
      event, {} as any, service, {} as any
    );

    // Should NOT call triggerZoom — zoom-to-box is handled by the overlay, not relayout
    expect(triggerZoomSpy).not.toHaveBeenCalled();

    // Clean up
    service.setZoomToBoxMode(false);
  });

  it('should NOT trigger zoom-to-box logic when zoomToBoxMode is off', () => {
    service.setZoomToBoxMode(false);
    relayoutSpy.mockClear();

    // Existing shape plus a new one — simulates drawing a region
    (service as any).shapes = [{ x0: 0, x1: 50, y0: 0, y1: 50, name: 'shape0', type: 'rect' }];
    const event = {
      shapes: [
        { x0: 0, x1: 50, y0: 0, y1: 50, name: 'shape0', type: 'rect' },
        { x0: 100, x1: 500, y0: 200, y1: 800, type: 'rect' }
      ]
    };
    (service as any).relayoutEventHandler(
      event, {} as any, service, {} as any
    );

    // Should NOT call triggerZoom — shape is treated as a region, not a zoom box
    expect(triggerZoomSpy).not.toHaveBeenCalled();
    // Shapes should be updated with the new shape
    expect((service as any).shapes.length).toBe(2);
  });

  it('should update zoomCoordinates on drag zoom in stack mode without triggering real zoom', () => {
    (service as any).imageInfo.showStack = true;

    const event = {
      'xaxis.range[0]': 100, 'xaxis.range[1]': 500,
      'yaxis.range[0]': 800, 'yaxis.range[1]': 200
    };
    (service as any).relayoutEventHandler(
      event, {} as any, service, {} as any
    );

    expect((service as any).zoomCoordinates).toEqual([100, 500, 800, 200]);
    expect(triggerZoomSpy).not.toHaveBeenCalled();
  });

  it('should update zoomCoordinates and trigger real zoom on drag zoom when not in stack mode', () => {
    (service as any).imageInfo.showStack = false;

    const event = {
      'xaxis.range[0]': 100, 'xaxis.range[1]': 500,
      'yaxis.range[0]': 800, 'yaxis.range[1]': 200
    };
    (service as any).relayoutEventHandler(
      event, {} as any, service, {} as any
    );

    expect((service as any).zoomCoordinates).toEqual([100, 500, 800, 200]);
    expect(triggerZoomSpy).toHaveBeenCalledWith([100, 500, 800, 200]);
  });

  it('should update zoomCoordinates on zoomIn', () => {
    const gd = document.getElementById('plot') as any;
    gd._fullLayout = {
      xaxis: { range: [0, 1000] },
      yaxis: { range: [0, 800] }
    };
    relayoutSpy.mockClear();

    service.zoomIn();

    const coords = (service as any).zoomCoordinates;
    expect(coords.length).toBe(4);
    // Zoomed range should be smaller than original
    expect(coords[1] - coords[0]).toBeLessThan(1000);
    expect(coords[3] - coords[2]).toBeLessThan(800);
  });

  it('should update zoomCoordinates on zoomOut', () => {
    const gd = document.getElementById('plot') as any;
    gd._fullLayout = {
      xaxis: { range: [200, 800] },
      yaxis: { range: [200, 600] }
    };
    relayoutSpy.mockClear();

    service.zoomOut();

    const coords = (service as any).zoomCoordinates;
    expect(coords.length).toBe(4);
    // Zoomed-out range should be larger than original
    expect(coords[1] - coords[0]).toBeGreaterThan(600);
    expect(coords[3] - coords[2]).toBeGreaterThan(400);
  });

  // Regression: switching between napari-js plot types (e.g. volume ↔ isosurface) routed the
  // region-overlay's setMode('none') → PlotlyService.setDragMode while Plotly wasn't the active
  // renderer. The div id was still set but had no Plotly graph, so Plotly.relayout threw
  // ("_guiEditing of undefined"), aborting the plot-type switch and wedging the view.
  it('setDragMode does NOT relayout when the div is not a live Plotly graph', () => {
    relayoutSpy.mockClear();
    // `#plot` exists but was never plotted → no `_fullLayout`.
    service.setDragMode(false);
    expect(relayoutSpy).not.toHaveBeenCalled();
  });

  it('setDragMode relayouts a live Plotly graph', () => {
    const gd = document.getElementById('plot') as any;
    gd._fullLayout = { xaxis: { range: [0, 1] }, yaxis: { range: [0, 1] } };
    relayoutSpy.mockClear();
    service.setDragMode('drawrect');
    expect(relayoutSpy).toHaveBeenCalledWith('plot', { dragmode: 'drawrect' });
  });
});


/**
 * Plotly-specific region glue. The region *state* (per-image cache, selection,
 * CRUD, vertex edits, key derivation) is the shared RegionStore's job and is
 * unit-tested in region-store.service.spec.ts. Here we only cover behaviour that
 * is specific to the Plotly backend: adopting shapes the user drew natively on
 * the Plotly canvas, and deleting the shape Plotly tracks as "active".
 */
describe('PlotlyService region glue (Plotly-specific)', () => {
  let service: PlotlyService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PlotlyService, ...VIZ_PORT_STUBS,
        MessageService
      ]
    });
    service = TestBed.inject(PlotlyService);

    (service as any).plotDiv = 'plot';
    (service as any).shapes = [];
    (service as any).imageInfo = { showStack: false, isGrayscale: true } as IImageInfo;
    (service as any).fileName = '';

    document.body.innerHTML = '<div id="plot"></div>';
    jest.spyOn(Plotly, 'relayout').mockResolvedValue({} as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeImageInfo(url: string, basename: string): IImageInfo {
    const info = ({} as IImageInfo);
    info.urls = [url];
    info.fileName = basename;
    info.trueImageSize = [100, 100];
    info.isGrayscale = true;
    info.isStack = false;
    info.showStack = false;
    info.scaleRatio = true;
    return info;
  }

  function makeRect(name: string): Region {
    const r = new Region();
    r.name = name;
    const rect = new Rectangle();
    rect.x = 0; rect.y = 0; rect.width = 10; rect.height = 10;
    r.bounds = rect;
    return r;
  }

  it('adopts a shape drawn natively on the Plotly canvas into the region store', () => {
    const a = makeImageInfo('s3://bkt/img.tif', 'img.tif');
    service.setActiveImage(a);
    (service as any).imageInfo = a;

    // Plotly emits the new shape via plotly_relayout (single `shapes` key).
    const newShape = { x0: 0, x1: 50, y0: 0, y1: 50, type: 'rect' };
    (service as any).relayoutEventHandler(
      { shapes: [newShape] }, {} as any, service, {} as any
    );

    // The drawn shape is now a region in the shared store (and projected to
    // Plotly's working-set), with a minted id.
    expect(service.getRegions().length).toBe(1);
    expect(service.getShapes().length).toBe(1);
    expect(service.getShapes()[0].id).toBeDefined();
  });

  it('deleteActiveShape falls back to Plotly\'s _activeShapeIndex when nothing is selected', () => {
    const a = makeImageInfo('s3://bkt/img.tif', 'img.tif');
    service.setActiveImage(a);
    service.setRegions([makeRect('s0'), makeRect('s1')]);

    // Clear the selection first (this also resets Plotly's active index), then
    // simulate Plotly tracking a clicked shape — deleteActiveShape should fall
    // back to it.
    service.setSelectedShapeIndices([]);
    const gd: any = document.getElementById('plot');
    gd._fullLayout = { _activeShapeIndex: 1 };
    service.deleteActiveShape();

    expect(service.getShapes().map((s: any) => s.name)).toEqual(['s0']);
  });
});

describe('PlotlyService viewport + stack-state methods', () => {
  let service: PlotlyService;
  let relayout: jest.SpyInstance;
  let restyle: jest.SpyInstance;
  let purge: jest.SpyInstance;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PlotlyService, ...VIZ_PORT_STUBS, MessageService],
    });
    service = TestBed.inject(PlotlyService);
    (service as any).plotDiv = 'plot';
    (service as any).imageInfo = { showStack: true, isGrayscale: true } as IImageInfo;
    document.body.innerHTML = '<div id="plot"></div>';
    relayout = jest.spyOn(Plotly, 'relayout').mockResolvedValue({} as any);
    restyle = jest.spyOn(Plotly as any, 'restyle').mockResolvedValue({} as any);
    purge = jest.spyOn(Plotly, 'purge').mockImplementation(() => undefined as any);
  });

  afterEach(() => jest.restoreAllMocks());

  it('setDragMode relayouts the drag mode', () => {
    // setDragMode only relayouts a LIVE Plotly graph (guards on `_fullLayout` so it no-ops when
    // another backend owns the div — see the relayout-handler suite's regression test).
    (document.getElementById('plot') as any)._fullLayout = {};
    service.setDragMode('pan');
    expect(relayout).toHaveBeenCalledWith('plot', { dragmode: 'pan' });
  });

  it('autoscale relayouts to autorange and clears the zoom box', () => {
    (service as any).zoomCoordinates = [1, 2, 3, 4];
    service.autoscale();
    expect((service as any).zoomCoordinates).toEqual([]);
    expect(relayout).toHaveBeenCalledWith('plot', expect.objectContaining({ 'xaxis.autorange': true }));
  });

  it('purgePlot purges the plot div', () => {
    service.purgePlot();
    expect(purge).toHaveBeenCalledWith('plot');
  });

  it('setColormap restyles the colorscale and writes the store', () => {
    service.setColormap({ data: { value: 'Viridis' } } as any);
    expect(restyle).toHaveBeenCalledWith('plot', { colorscale: ['Viridis'] });
  });

  it('setReverseScale restyles reversescale', () => {
    service.setReverseScale(true);
    expect(restyle).toHaveBeenCalledWith('plot', { reversescale: true });
  });

  it('setShowStack(false) resets the slice index and relayouts', () => {
    service.setShowStack(false);
    expect((service as any).imageInfo.showStack).toBe(false);
    expect(relayout).toHaveBeenCalledWith('plot', { showstack: false });
  });

  it('stack-loading flags round-trip through their subjects', () => {
    const vals: boolean[] = [];
    service.isStackLoading$().subscribe((v) => vals.push(v));
    service.setStackLoading(true);
    expect(vals[vals.length - 1]).toBe(true);
  });

  it('exposes the stack-progress and autoscale event streams', () => {
    expect(service.getStackLoadingProgress$()).toBeDefined();
    expect(service.getAutoscaleEvent()).toBeDefined();
  });

  it('navigator + smoothing toggles are safe no-ops on the Plotly backend', () => {
    expect(() => {
      service.setNavigatorVisible(false);
      service.setImageSmoothingEnabled(false);
    }).not.toThrow();
  });

  it('getViewportChange$ is an empty stream (OSD-only signal)', () => {
    let completed = false;
    let emitted = false;
    service.getViewportChange$().subscribe({ next: () => (emitted = true), complete: () => (completed = true) });
    expect(emitted).toBe(false);
    expect(completed).toBe(true);
  });
});

describe('PlotlyService service-lifetime subscriptions (review CORE-1)', () => {
  let service: PlotlyService;
  let imageInfo: IImageInfo;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PlotlyService, ...VIZ_PORT_STUBS, MessageService],
    });
    service = TestBed.inject(PlotlyService);
    jest.spyOn(service as unknown as { loadImage(u: string): Promise<Image> }, 'loadImage')
      .mockImplementation((url: string) => Image.load(url));
    imageInfo = {
      urls: [path.join(__dirname, 'test_grayscale.png')],
      trueImageSize: [1344, 1024],
      scaleRatio: true,
      isGrayscale: true,
      showStack: false,
    } as IImageInfo;
    document.body.innerHTML = '<div id="plot"></div>';
  });

  afterEach(() => jest.restoreAllMocks());

  const channel = (min: number, max: number): IChannelState =>
    ({ index: 0, name: 'Intensity', color: '#ffffff', min, max, gamma: 1, visible: true });

  it('re-arms the channel and region subscriptions on the next plot after unsubscribe()', async () => {
    const store = TestBed.inject(VisualizerStore);
    const regionStore = TestBed.inject(RegionStore);
    // A destroyed VisualizerComponent tears the root singleton's subscriptions down...
    service.unsubscribe();
    // ...and a recreated one loads and plots the next image.
    const loaded = await service.load(imageInfo, 0);
    await service.plot('plot', loaded, imageInfo, 811, PlotType.HEATMAP);

    const restyle = jest.spyOn(Plotly, 'restyle').mockResolvedValue(document.createElement('div') as never);
    const emitProfiles = jest.spyOn(service as unknown as { emitProfiles(): void }, 'emitProfiles');
    store.setChannelStates([channel(10, 20)]);
    expect(restyle).toHaveBeenCalledWith('plot', expect.objectContaining({ zmin: 10, zmax: 20 }));

    const r = new Region();
    r.bounds = Object.assign(new Rectangle(), { x: 1, y: 1, width: 5, height: 5 });
    regionStore.setRegions([r]);
    expect(emitProfiles).toHaveBeenCalled();
  });

  it('re-arms the profile subscriptions when a recreated component subscribes, with no Plotly plot', () => {
    const regionStore = TestBed.inject(RegionStore);
    // OSD/napari owns the view: after the teardown, the next component only
    // subscribes to the profiles — Plotly never loads or plots.
    service.unsubscribe();
    service.getIntensityProfile$().subscribe();

    const emitProfiles = jest.spyOn(service as unknown as { emitProfiles(): void }, 'emitProfiles');
    const r = new Region();
    r.bounds = Object.assign(new Rectangle(), { x: 1, y: 1, width: 5, height: 5 });
    regionStore.setRegions([r]);
    expect(emitProfiles).toHaveBeenCalled();
  });

  it('does not double-subscribe when plot runs without a prior unsubscribe()', async () => {
    const store = TestBed.inject(VisualizerStore);
    const loaded = await service.load(imageInfo, 0);
    await service.plot('plot', loaded, imageInfo, 811, PlotType.HEATMAP);
    await service.plot('plot', loaded, imageInfo, 811, PlotType.HEATMAP);

    const apply = jest.spyOn(service as unknown as { applyChannelDisplay(): void }, 'applyChannelDisplay')
      .mockImplementation(() => undefined);
    store.setChannelStates([channel(1, 2)]);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

/**
 * Async results must not land after the user moved on (review OSD-PLOTLY-8):
 * an intensity-sampling fetch for the previous image, or a high-def zoom crop
 * that arrives after the div was handed to another backend.
 */
describe('PlotlyService async supersession (review OSD-PLOTLY-8)', () => {
  let service: PlotlyService;
  let zoom$: Subject<ArrayBuffer>;

  beforeEach(() => {
    zoom$ = new Subject<ArrayBuffer>();
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PlotlyService, ...VIZ_PORT_STUBS, MessageService],
    });
    TestBed.overrideProvider(TILE_ACCESS_PORT, {
      useValue: {
        getSelectedInfoB64: () => null,
        getAuthHeaders: () => Promise.resolve({}),
        zoomOnRegion: () => zoom$,
        selectDiagramDisplay: () => undefined,
      },
    });
    service = TestBed.inject(PlotlyService);
    document.body.innerHTML = '<div id="plot"></div>';
  });

  afterEach(() => jest.restoreAllMocks());

  it('drops an intensity-sampling load that a newer one superseded', async () => {
    const frames = (name: string) => ({ data: [[[name]]], ratios: [1, 1], sizes: [1, 1] });
    const releases: Array<() => void> = [];
    jest.spyOn(service, 'load').mockImplementation((info: IImageInfo) =>
      new Promise((resolve) => releases.push(() => resolve(frames(info.fileName!) as never))));
    const a = service.ensureIntensitySampling({ fileName: 'A', urls: ['a'] } as IImageInfo, 0);
    const b = service.ensureIntensitySampling({ fileName: 'B', urls: ['b'] } as IImageInfo, 0);
    releases[1](); // B first
    await b;
    releases[0](); // then the slow A
    await a;
    expect((service as any).cachedImageFrames).toEqual([[['B']]]);
  });

  it('drops a high-def zoom crop that arrives after the plot was purged for another backend', async () => {
    const s = service as any;
    s.plotDiv = 'plot';
    s.trueImgSize = [0, 1000, 0, 800];
    s.imageInfo = { isGrayscale: true, fileName: 'f.tif' } as IImageInfo;
    s.fileName = 'f.tif';
    jest.spyOn(Plotly, 'purge').mockImplementation(() => undefined as never);
    const image = { width: 2, height: 2, grey: () => ({ data: [1, 2, 3, 4] }) };
    jest.spyOn(Image, 'load').mockResolvedValue(image as never);
    const heatmap = jest.spyOn(s, 'plotHeatmap').mockResolvedValue(undefined);
    const registry = jest.spyOn(s, 'plotViaRegistry').mockResolvedValue(undefined);
    s.triggerZoom([100, 200, 300, 400]);
    service.purgePlot(); // same file, user switched to the OSD image view
    zoom$.next(new ArrayBuffer(4));
    await new Promise((r) => setTimeout(r, 0));
    expect(heatmap).not.toHaveBeenCalled();
    expect(registry).not.toHaveBeenCalled();
  });

  it('sizes the zoom crop request from its own plot div, not a host element id (CORE-24)', () => {
    const s = service as any;
    s.plotDiv = 'plot';
    s.trueImgSize = [0, 1000, 0, 800];
    s.imageInfo = { isGrayscale: true, fileName: 'f.tif' } as IImageInfo;
    const measure = jest.spyOn(s.plotUtilities, 'getDomRectangle');
    s.triggerZoom([100, 200, 300, 400]);
    service.refreshIntensitySamplingForRoi(0, 0, 10, 10, 0);
    expect(measure.mock.calls).toEqual([['plot'], ['plot']]);
  });
});
