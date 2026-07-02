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
