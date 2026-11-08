import { BehaviorSubject, Subject } from 'rxjs';

import { PlotModeRect, PlotModeViewport } from '../../contracts/plot-type-contribution.contract';
import { SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import { selectByIndices } from '../../spatial/spatial-selection';
import { SpatialSelectionStore } from '../../store/spatial-selection.service';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { FakeWebGl2, installFakeWebGl2 } from '../../testing/fake-webgl2';
import { WebGlSpatialHost, WebGlSpatialLayer } from './webgl-spatial-layer';

/** 2 screen px per image px, image (0, 0) at the canvas's top-left (client 0, 0). */
const SCALE = 2;

function viewport(): PlotModeViewport & { frame$: Subject<PlotModeRect> } {
  return {
    getOverlayContainer: () => null,
    dataToClient: (x, y) => ({ x: x * SCALE, y: y * SCALE }),
    clientToData: (x, y) => ({ x: x / SCALE, y: y / SCALE }),
    dataLengthToScreen: (len) => len * SCALE,
    isReady: () => true,
    frame$: new Subject<PlotModeRect>(),
    settled$: new Subject<PlotModeRect>(),
  };
}

function dataset(overrides: Partial<SpatialDataset> = {}): SpatialDataset {
  return {
    id: 'ds',
    name: 'ds',
    observations: {
      count: 3,
      x: new Float32Array([10, 50, 90]),
      y: new Float32Array([10, 20, 30]),
      radius: 2,
    },
    columns: [{ kind: 'categorical', name: 'cluster', categories: ['a', 'b'] }],
    imageRef: {},
    ...overrides,
  } as SpatialDataset;
}

function port(ds: SpatialDataset | null): SpatialDataPort & { dataset$: BehaviorSubject<SpatialDataset | null> } {
  const dataset$ = new BehaviorSubject(ds);
  return {
    dataset$,
    getDataset$: () => dataset$,
    getColumn: jest.fn().mockResolvedValue({
      meta: { kind: 'categorical', name: 'cluster', categories: ['a', 'b'], colors: ['#ff0000', '#0000ff'] },
      codes: new Uint16Array([0, 1, 0]),
    }),
    getFeatureVector: jest.fn().mockResolvedValue(new Float32Array([0, 1, 2])),
  } as unknown as SpatialDataPort & { dataset$: BehaviorSubject<SpatialDataset | null> };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('WebGlSpatialLayer', () => {
  let gl: ReturnType<typeof installFakeWebGl2>;
  let container: HTMLElement;
  let host: HTMLElement;
  let store: VisualizerStore;
  let selection: SpatialSelectionStore;
  let rect: jest.SpyInstance;
  let raf: jest.SpyInstance;

  beforeEach(() => {
    gl = installFakeWebGl2();
    host = document.createElement('div');
    container = document.createElement('div');
    container.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    host.appendChild(container);
    document.body.appendChild(host);
    store = new VisualizerStore();
    selection = new SpatialSelectionStore();
    rect = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 } as DOMRect);
    raf = jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    gl.restore();
    rect.mockRestore();
    raf.mockRestore();
    host.remove();
  });

  function layerFor(p: SpatialDataPort | null, extra: Partial<WebGlSpatialHost> = {}) {
    const vp = viewport();
    const layer = new WebGlSpatialLayer({
      viewport: vp,
      container: () => container,
      pointerHost: () => host,
      store,
      port: p,
      selection,
      imageSize: () => ({ width: 100, height: 50 }),
      z: () => 0,
      toolActive: () => false,
      outsideZone: (fn) => fn(),
      inZone: (fn) => fn(),
      ...extra,
    });
    return { layer, vp };
  }

  const ctx = (): FakeWebGl2 => gl.contexts[gl.contexts.length - 1];
  /** The last buffer uploaded with `length` floats. */
  const lastUpload = (length: number): Float32Array | undefined =>
    ctx()
      .callsTo('bufferData')
      .map((a) => a[1])
      .filter((d): d is Float32Array => d instanceof Float32Array && d.length === length)
      .pop();

  it('puts its canvas over the tiles and under the region overlay', () => {
    const { layer } = layerFor(port(dataset()));
    expect(layer.attach()).toBe(true);
    expect(container.children[0].tagName).toBe('CANVAS');
    expect(container.children[1].tagName.toLowerCase()).toBe('svg');
    layer.detach();
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('does not attach without a spatial port, or without WebGL2', () => {
    expect(layerFor(null).layer.attach()).toBe(false);
    gl.restore();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(layerFor(port(dataset())).layer.attach()).toBe(false);
    expect(container.querySelector('canvas')).toBeNull();
    warn.mockRestore();
  });

  it('uploads the observations in image px, through the dataset’s affine', async () => {
    const { layer } = layerFor(port(dataset({ imageRef: { scale: [2, 2], translate: [5, 0] } })));
    layer.attach();
    await flush();
    expect(Array.from(lastUpload(6)!)).toEqual([25, 20, 105, 40, 185, 60]);
    layer.detach();
  });

  it('colours by a categorical column, and mutes what a selection leaves out', async () => {
    const { layer } = layerFor(port(dataset()));
    layer.attach();
    store.setSpatialView({ colorBy: { kind: 'column', name: 'cluster' }, opacity: 1 });
    await flush();
    const colours = lastUpload(12)!;
    expect(Array.from(colours.subarray(0, 3))).toEqual([1, 0, 0]);
    expect(Array.from(colours.subarray(4, 7))).toEqual([0, 0, 1]);

    selection.set(selectByIndices([1], 3));
    await flush();
    const muted = lastUpload(12)!;
    expect(muted[7]).toBeGreaterThan(muted[3]); // the selected one is more opaque
    layer.detach();
  });

  it('picks the observation under the cursor for the tooltip and the click', async () => {
    const p = port(dataset());
    const { layer } = layerFor(p);
    layer.attach();
    store.setSpatialView({ colorBy: { kind: 'column', name: 'cluster' } });
    await flush();
    // Observation 1 is at image (50, 20) → client (100, 40). A still click selects its class.
    host.dispatchEvent(new MouseEvent('pointerdown', { clientX: 101, clientY: 40, bubbles: true }));
    host.dispatchEvent(new MouseEvent('pointerup', { clientX: 101, clientY: 40, bubbles: true }));
    await flush();
    expect(selection.current().count).toBe(1);
    expect(selection.current().mask[1]).toBe(1);
    layer.detach();
  });

  it('names and selects by the colour source set before it attached', async () => {
    // The usual order: the host colours the dataset, then the view falls back to WebGL.
    store.setSpatialView({ colorBy: { kind: 'column', name: 'cluster' } });
    const { layer } = layerFor(port(dataset()));
    layer.attach();
    await flush();
    host.dispatchEvent(new MouseEvent('pointerdown', { clientX: 101, clientY: 40, bubbles: true }));
    host.dispatchEvent(new MouseEvent('pointerup', { clientX: 101, clientY: 40, bubbles: true }));
    await flush();
    expect(selection.current().count).toBe(1);
    layer.detach();
  });

  it('leaves a click alone while a region tool owns the pointer', async () => {
    const { layer } = layerFor(port(dataset()), { toolActive: () => true });
    layer.attach();
    store.setSpatialView({ colorBy: { kind: 'column', name: 'cluster' } });
    await flush();
    host.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 40, bubbles: true }));
    host.dispatchEvent(new MouseEvent('pointerup', { clientX: 100, clientY: 40, bubbles: true }));
    await flush();
    expect(selection.current().count).toBe(0);
    layer.detach();
  });

  it('draws nothing for a dataset that registers onto no image', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { layer } = layerFor(port(dataset({ imageRef: undefined })));
    layer.attach();
    await flush();
    expect(lastUpload(6)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('registers onto no image'));
    warn.mockRestore();
    layer.detach();
  });

  it('draws in the viewer’s own redraw when it offers one', async () => {
    let redraw: (() => void) | null = null;
    const off = jest.fn();
    const { layer } = layerFor(port(dataset()), {
      onRedraw: (fn) => {
        redraw = fn;
        return off;
      },
    });
    layer.attach();
    await flush();
    const before = ctx().callsTo('drawArraysInstanced').length;
    redraw!();
    expect(ctx().callsTo('drawArraysInstanced').length).toBe(before + 1);
    layer.detach();
    expect(off).toHaveBeenCalled();
  });

  it('places the gene map over the image when colouring by a gene with the map on', async () => {
    const { layer } = layerFor(port(dataset()));
    layer.attach();
    store.setSpatialView({ colorBy: { kind: 'feature', name: 'GENE' }, geneMap: true });
    await flush();
    await flush();
    expect(ctx().callsTo('texImage2D').length).toBeGreaterThan(0);
    layer.detach();
  });

  it('samples the gene map’s first row at the top of the image', async () => {
    // The field is row-major from the top; WebGL puts an upload's first row at v = 0, and the quad
    // gives v = 0 to the image's top edge (y = rect.y). So no flip, on either side.
    const { layer } = layerFor(port(dataset()));
    layer.attach();
    store.setSpatialView({ colorBy: { kind: 'feature', name: 'GENE' }, geneMap: true });
    await flush();
    await flush();
    const g = ctx();
    const flips = g.callsTo('pixelStorei').filter(([pname, value]) => pname === g.gl.UNPACK_FLIP_Y_WEBGL && value);
    expect(flips).toEqual([]);
    const shaders = g.callsTo('shaderSource').map(([, src]) => src as string);
    const raster = shaders.find((src) => src.includes('u_rect'))!;
    expect(raster).toContain('vec2 img = u_rect.xy + a_corner * u_rect.zw;');
    expect(raster).toContain('v_uv = a_corner;');
    expect(raster).toContain('1.0 - p.y / u_size.y * 2.0');
    layer.detach();
  });

  it('hides the tissue with the Images toggle, and shows it again on detach', async () => {
    const setImageVisible = jest.fn();
    const { layer } = layerFor(port(dataset()), { setImageVisible });
    layer.attach();
    await flush();
    expect(setImageVisible).toHaveBeenLastCalledWith(true);
    store.setSpatialView({ showImage: false });
    await flush();
    expect(setImageVisible).toHaveBeenLastCalledWith(false);
    layer.detach();
    expect(setImageVisible).toHaveBeenLastCalledWith(true);
  });
});
