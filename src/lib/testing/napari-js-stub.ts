/**
 * Jest stub for the `napari-js` ESM package. Unit tests run in jsdom/node where WebGPU is
 * unavailable, so the real engine can't initialise — and Jest can't parse its ESM build
 * anyway. The lib's `jest.config.ts` maps `napari-js` to this file. Production builds
 * (ng-packagr / nx build) use the real package and its real types.
 */

interface StubCamera {
  zoom: number;
  fit(width: number, height: number, vw: number, vh: number): void;
  changed: { connect(listener: () => void): () => void };
}

interface StubDims {
  z: number;
}

interface StubCamera3D {
  frame(width: number, height: number, depth: number): void;
  viewProjection(vw: number, vh: number): number[];
  target: [number, number, number];
  distance: number;
  changed: { connect(listener: () => void): () => void };
}

/** A mutable stand-in for napari-js VolumeLayer (the props the adapter sets). */
export interface VolumeLayer {
  colormap: unknown;
  contrastLimits: [number, number];
  gamma: number;
  visible: boolean;
  blending: string;
  rendering: 'mip' | 'translucent' | 'iso';
  isoThreshold: number;
}

/** A mutable stand-in for napari-js AxesLayer (the 3D coordinate-axes gizmo). */
export interface AxesLayer {
  visible: boolean;
  tickCount: number;
  boundingBox: boolean;
  voxelSize: [number, number, number];
}

/** Stand-in for napari-js PointsLayer (2D scatter markers — the adapter only creates/removes it). */
export interface PointsLayer {
  size: number;
  opacity: number;
  blending: string;
}

/** Stand-in for napari-js Points3DLayer (the props/bounds the 3D-scatter adapter reads/sets). */
export interface Points3DLayer {
  colormap: unknown;
  contrastLimits: [number, number];
  size: number;
  bounds(): {
    min: [number, number, number];
    max: [number, number, number];
    center: [number, number, number];
    radius: number;
  };
}

/** A mutable stand-in for napari-js SurfaceLayer (the props/bounds the adapter reads/sets). */
export interface SurfaceLayer {
  colormap: unknown;
  contrastLimits: [number, number];
  gamma: number;
  visible: boolean;
  blending: string;
  wireframe: boolean;
  bounds(): {
    min: [number, number, number];
    max: [number, number, number];
    center: [number, number, number];
    radius: number;
  };
}

/** Stand-in for napari-js heightField: returns a grid-sized mesh (values/vertices/faces) so the
 *  adapter's `addSurface` call shape is exercised without the real triangulation. */
export function heightField(
  _data: ArrayLike<number>,
  cols: number,
  rows: number,
  _opts?: unknown,
): { vertices: Float32Array; faces: Uint32Array; values: Float32Array } {
  const n = Math.max(0, cols * rows);
  const cells = Math.max(0, (cols - 1) * (rows - 1));
  return {
    vertices: new Float32Array(n * 3),
    faces: new Uint32Array(cells * 6),
    values: new Float32Array(n),
  };
}

/** A mutable stand-in for napari-js ImageLayer (the per-channel display props the adapter sets). */
export interface ImageLayer {
  colormap: unknown;
  contrastLimits: [number, number];
  gamma: number;
  visible: boolean;
  invert: boolean;
  blending: string;
}

/** Stand-in for napari-js histogramScalar (per-channel / volume intensity histogram). */
export function histogramScalar(
  _data: ArrayLike<number>,
  bins: number,
  min: number,
  max: number,
): { counts: Uint32Array; bins: number; min: number; max: number } {
  return { counts: new Uint32Array(bins), bins, min, max };
}

/** Stand-in for napari-js Colormap (constructed for per-channel tints / grayscale LUTs). */
export class Colormap {
  constructor(
    readonly name: string,
    readonly stops: unknown[] = [],
  ) {}
  sample(): [number, number, number] {
    return [0, 0, 0];
  }
}

/** Stand-in for napari-js colormapFromLut (grayscale LUT → Colormap). */
export function colormapFromLut(name: string, _lut: unknown, _maxValue = 255): Colormap {
  return new Colormap(name);
}

/** Stand-in for napari-js tintColormap (black→hex ramp). */
export function tintColormap(hex: string): Colormap {
  return new Colormap(`tint-${hex}`);
}

/** Stand-in for napari-js resolveColormap (name | instance → Colormap). */
export function resolveColormap(cmap: Colormap | string): Colormap {
  return cmap instanceof Colormap ? cmap : new Colormap(String(cmap));
}

/** Stand-in for napari-js reverseColormap (flipped ramp). */
export function reverseColormap(cmap: Colormap | string): Colormap {
  const name = cmap instanceof Colormap ? cmap.name : String(cmap);
  return new Colormap(`${name}-reversed`);
}

export type ChannelMode = 'multichannel' | 'grayscale' | 'rgb';

/** Stand-in for the napari-js ChannelView descriptor. */
export interface ChannelView {
  source: unknown;
  tint?: string;
  colormap?: unknown;
  contrastLimits?: [number, number];
  gamma?: number;
  visible?: boolean;
  invert?: boolean;
  name?: string;
  scale?: [number, number];
}

/** The Viewer slice MultiChannelImageView drives (satisfied by the stub Viewer). */
export interface ImageLayerHost {
  addImage(input?: unknown, opts?: unknown): ImageLayer;
  readonly layers: { clear(): void };
  requestRender(): void;
}

/**
 * Stand-in for napari-js MultiChannelImageView: builds + tracks stub ImageLayers through the host
 * so the adapter's `.layers[i]` lookups and live updates resolve in unit tests (no GPU).
 */
export class MultiChannelImageView {
  private _mode: ChannelMode | null = null;
  private _layers: ImageLayer[] = [];

  constructor(private readonly host: ImageLayerHost) {}

  get mode(): ChannelMode | null {
    return this._mode;
  }
  get layers(): readonly ImageLayer[] {
    return this._layers;
  }
  render(mode: ChannelMode, channels: ChannelView[]): ImageLayer[] {
    this.host.layers.clear();
    this._mode = mode;
    const count = mode === 'multichannel' ? channels.length : 1;
    this._layers = Array.from({ length: count }, () => this.host.addImage());
    this.host.requestRender();
    return [...this._layers];
  }
  updateChannel(): void {
    this.host.requestRender();
  }
  setInterpolation(): void {
    this.host.requestRender();
  }
  clear(): void {
    this.host.layers.clear();
    this._layers = [];
    this._mode = null;
    this.host.requestRender();
  }
}

export type VolumeMode = 'multichannel' | 'grayscale';

/** Stand-in for the napari-js VolumeChannel descriptor. */
export interface VolumeChannel {
  data: Uint8Array;
  width: number;
  height: number;
  depth: number;
  tint?: string;
  colormap?: unknown;
  contrastLimits?: [number, number];
  gamma?: number;
  visible?: boolean;
}

export interface VolumeHost {
  addVolume(
    data: Uint8Array,
    width: number,
    height: number,
    depth: number,
    opts?: unknown,
  ): VolumeLayer;
  readonly layers: { clear(): void };
  requestRender(): void;
}

/** Stand-in for napari-js MultiChannelVolumeView: builds + tracks stub VolumeLayers through the
 *  host and live-applies per-channel display patches so the adapter's tests resolve (no GPU). */
export class MultiChannelVolumeView {
  private _mode: VolumeMode | null = null;
  private _layers: VolumeLayer[] = [];

  constructor(private readonly host: VolumeHost) {}

  get mode(): VolumeMode | null {
    return this._mode;
  }
  get layers(): readonly VolumeLayer[] {
    return this._layers;
  }
  render(mode: VolumeMode, channels: VolumeChannel[]): VolumeLayer[] {
    this.host.layers.clear();
    this._mode = mode;
    const list = mode === 'grayscale' ? channels.slice(0, 1) : channels;
    this._layers = list.map((ch) => {
      const layer = this.host.addVolume(ch.data, ch.width, ch.height, ch.depth);
      if (ch.colormap !== undefined) layer.colormap = ch.colormap;
      if (ch.contrastLimits !== undefined) layer.contrastLimits = ch.contrastLimits;
      if (ch.gamma !== undefined) layer.gamma = ch.gamma;
      if (ch.visible !== undefined) layer.visible = ch.visible;
      return layer;
    });
    this.host.requestRender();
    return [...this._layers];
  }
  updateChannel(index: number, patch: Partial<VolumeChannel>): void {
    const layer = this._layers[index];
    if (layer) {
      if (patch.colormap !== undefined) layer.colormap = patch.colormap;
      if (patch.contrastLimits !== undefined) layer.contrastLimits = patch.contrastLimits;
      if (patch.gamma !== undefined) layer.gamma = patch.gamma;
      if (patch.visible !== undefined) layer.visible = patch.visible;
    }
    this.host.requestRender();
  }
  setRendering(): void {
    this.host.requestRender();
  }
  clear(): void {
    this.host.layers.clear();
    this._layers = [];
    this._mode = null;
    this.host.requestRender();
  }
}

/** Minimal Viewer matching the surface NapariVisualizerService touches. */
export class Viewer {
  readonly ready: Promise<void> = Promise.resolve();
  readonly camera: StubCamera = {
    zoom: 1,
    fit: () => undefined,
    changed: { connect: () => () => undefined },
  };
  readonly camera3d: StubCamera3D = {
    frame: () => undefined,
    viewProjection: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    target: [0, 0, 0],
    distance: 1,
    changed: { connect: () => () => undefined },
  };
  readonly dims: StubDims = { z: 0 };
  readonly layers = { clear: (): void => undefined, remove: (): boolean => true };

  constructor(_options: { canvas: HTMLCanvasElement }) {}

  addImage(): ImageLayer {
    return {
      colormap: 'gray',
      contrastLimits: [0, 255],
      gamma: 1,
      visible: true,
      invert: false,
      blending: 'translucent',
    };
  }
  addVolume(): VolumeLayer {
    return {
      colormap: 'gray',
      contrastLimits: [0, 255],
      gamma: 1,
      visible: true,
      blending: 'additive',
      rendering: 'mip',
      isoThreshold: 0.5,
    };
  }
  addAxes(): AxesLayer {
    return { visible: true, tickCount: 5, boundingBox: true, voxelSize: [1, 1, 1] };
  }
  addSurface(
    _vertices?: Float32Array,
    _faces?: Uint32Array,
    _values?: Float32Array,
    opts?: {
      colormap?: unknown;
      contrastLimits?: [number, number];
      gamma?: number;
      wireframe?: boolean;
    },
  ): SurfaceLayer {
    const o = opts ?? {};
    return {
      colormap: o.colormap ?? 'viridis',
      contrastLimits: o.contrastLimits ?? [0, 255],
      gamma: o.gamma ?? 1,
      visible: true,
      blending: 'opaque',
      wireframe: o.wireframe ?? false,
      bounds: () => ({
        min: [0, 0, 0],
        max: [1, 1, 1],
        center: [0.5, 0.5, 0.5],
        radius: 1,
      }),
    };
  }
  addPoints(): PointsLayer {
    return { size: 10, opacity: 1, blending: 'translucent' };
  }
  addPoints3D(
    _positions?: Float32Array,
    _values?: Float32Array,
    opts?: { colormap?: unknown; contrastLimits?: [number, number]; size?: number },
  ): Points3DLayer {
    const o = opts ?? {};
    return {
      colormap: o.colormap ?? 'viridis',
      contrastLimits: o.contrastLimits ?? [0, 255],
      size: o.size ?? 6,
      bounds: () => ({
        min: [0, 0, 0],
        max: [1, 1, 1],
        center: [0.5, 0.5, 0.5],
        radius: 1,
      }),
    };
  }
  layerHistogram(): { counts: Uint32Array; bins: number; min: number; max: number } | null {
    return { counts: new Uint32Array(256), bins: 256, min: 0, max: 255 };
  }
  requestRender(): void {}
  setCameraDragMode(): void {}
  setControlsEnabled(): void {}
  get controlsActive(): boolean {
    return true;
  }
  visibleWorldRect(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  canvasToWorld(clientX: number, clientY: number): [number, number] {
    return [clientX, clientY];
  }
  worldToCanvas(worldX: number, worldY: number): [number, number] {
    return [worldX, worldY];
  }
  async readDisplayedPixels(): Promise<{
    width: number;
    height: number;
    channels: number;
    data: Uint8ClampedArray;
  }> {
    return { width: 1, height: 1, channels: 4, data: new Uint8ClampedArray(4) };
  }
  async screenshot(): Promise<Blob> {
    return new Blob();
  }
  dispose(): void {}
}
