/**
 * Jest stub for the `napari-js` ESM package. Unit tests run in jsdom/node where WebGPU is
 * unavailable, so the real engine can't initialise — and Jest can't parse its ESM build
 * anyway. The lib's `jest.config.ts` maps `napari-js` to this file. Production builds
 * (ng-packagr / nx build) use the real package and its real types.
 */

interface StubCamera {
  zoom: number;
  fit(width: number, height: number, vw: number, vh: number): void;
}

interface StubDims {
  z: number;
}

interface StubCamera3D {
  frame(width: number, height: number, depth: number): void;
}

/** A mutable stand-in for napari-js VolumeLayer (the props the adapter sets). */
export interface VolumeLayer {
  contrastLimits: [number, number];
  rendering: 'mip' | 'translucent' | 'iso';
  isoThreshold: number;
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

/** Minimal Viewer matching the surface NapariVisualizerService touches. */
export class Viewer {
  readonly ready: Promise<void> = Promise.resolve();
  readonly camera: StubCamera = { zoom: 1, fit: () => undefined };
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
    return { contrastLimits: [0, 255], rendering: 'mip', isoThreshold: 0.5 };
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
