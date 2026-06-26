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
}

/** A mutable stand-in for napari-js VolumeLayer (the props the adapter sets). */
export interface VolumeLayer {
  colormap: unknown;
  contrastLimits: [number, number];
  gamma: number;
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

/** Minimal Viewer matching the surface NapariVisualizerService touches. */
export class Viewer {
  readonly ready: Promise<void> = Promise.resolve();
  readonly camera: StubCamera = {
    zoom: 1,
    fit: () => undefined,
    changed: { connect: () => () => undefined },
  };
  readonly camera3d: StubCamera3D = { frame: () => undefined };
  readonly dims: StubDims = { z: 0 };
  readonly layers = { clear: (): void => undefined };

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
    return { colormap: 'gray', contrastLimits: [0, 255], gamma: 1, rendering: 'mip', isoThreshold: 0.5 };
  }
  addAxes(): AxesLayer {
    return { visible: true, tickCount: 5, boundingBox: true, voxelSize: [1, 1, 1] };
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
