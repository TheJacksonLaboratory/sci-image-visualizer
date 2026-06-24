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

/** Minimal Viewer matching the surface NapariVisualizerService touches. */
export class Viewer {
  readonly ready: Promise<void> = Promise.resolve();
  readonly camera: StubCamera = { zoom: 1, fit: () => undefined };
  readonly camera3d: StubCamera3D = { frame: () => undefined };
  readonly dims: StubDims = { z: 0 };

  constructor(_options: { canvas: HTMLCanvasElement }) {}

  addImage(): unknown {
    return {};
  }
  addVolume(): VolumeLayer {
    return { contrastLimits: [0, 255], rendering: 'mip', isoThreshold: 0.5 };
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
