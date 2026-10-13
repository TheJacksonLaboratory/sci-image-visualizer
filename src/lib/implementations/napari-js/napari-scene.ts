import type { Viewer } from 'napari-js';

import { IImageInfo } from '../../contracts/image.contract';
import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import { IIsosurfaceControls, ISurface3dControls } from '../../contracts/visualizer.contract';
import { SpatialObservations } from '../../contracts/spatial-dataset.contract';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { RegionStore } from '../../store/region-store.service';
import { NapariTileClient } from './napari-tile-client';
import { NapariDisplayState } from './napari-display-state';
import { LoadingBadgeState } from './napari-loading-state';
import { NapariToolBridge } from './napari-tool-bridge';

/**
 * What one `plot()` mounts into the viewer (review Appendix B): the 2D image (alone, under the
 * region-centroid scatter, or under the spatial markers), a volume, a surface, a 3D scatter or the
 * spatial 3D cloud. The service picks one per plot type and talks to it through this interface
 * instead of asking which layer handle happens to be non-null; a scene owns every layer, key,
 * subscription and listener it creates, and {@link dispose} drops them all — so a re-plot can no
 * longer inherit a stale "already built" key from the previous one (NAPARI-SVC-1, -8).
 */
export interface NapariScene {
  /** Build the scene into the viewer. Resolves once the first frame's data is in. */
  mount(): Promise<void>;
  /** The stack slider moved to `z` (already recorded as the image's slice). */
  setZ(z: number): void;
  /** The histogram pane's distribution for `channel`, or null when there is none (yet). */
  histogram(channel: number, bins: number): IHistogram | null;
  /** The isosurface threshold controls (volume scenes only). */
  isoControls?(): IIsosurfaceControls | null;
  /** The 3D camera/axes/wireframe controls (3D scenes only). */
  surface3dControls?(): ISurface3dControls | null;
  /** Bilinear vs nearest-neighbour image sampling changed (2D image scenes). */
  setImageSmoothing?(enabled: boolean): void;
  /** The overview navigator was shown or hidden (2D image scenes). */
  setNavigatorVisible?(visible: boolean): void;
  /** Observations projected to canvas pixels (the spatial 3D cloud), or null. */
  screenProjection?(obs: SpatialObservations): Float32Array | null;
  /** Remove everything the scene added; called before the viewer is disposed. */
  dispose(): void;
}

/** Viewer settings that outlive a scene: a re-plot keeps them. */
export interface NapariSettings {
  /** Decimate factor for the 3D types (1 = Full, 2 = ½, 4 = ¼ default, 8 = ⅛). */
  resolutionScale: number;
  /** Whether the 2D overview navigator is shown (the same host setting OSD's navigator honours). */
  navigatorVisible: boolean;
  /** Image smoothing (bilinear) vs nearest-neighbour (crisp pixels, the default). */
  imageSmoothing: boolean;
  /** The 3D axes gizmo's on/off choice. */
  axesVisible: boolean;
  /** The surface's wireframe choice. */
  surfaceWireframe: boolean;
  /** The volume's user Z-height factor (1 = the volume's natural proportions). */
  volumeZScale: number;
}

/** The stack-loading flag and progress the host shows while frames load. */
export interface StackProgress {
  loading(on: boolean): void;
  progress(percent: number): void;
}

/** Everything a scene is built from: the viewer and its DOM, the service's collaborators, and the
 *  service state a scene reads live. */
export interface SceneContext {
  readonly viewer: Viewer;
  readonly host: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** The scene's lifetime: aborted when the service resets into the next scene. */
  readonly signal: AbortSignal;
  /** Frame loading (volume assembly, surface preload): aborted by a reset AND by
   *  `cancelLoading()`, which renews it — so read it when a load starts. */
  loading(): AbortSignal;
  /** The image on screen and its current slice, as `load()`/`setZIndex()` recorded them. */
  info(): IImageInfo | undefined;
  z(): number;
  readonly tiles: NapariTileClient;
  readonly display: NapariDisplayState;
  readonly badge: LoadingBadgeState;
  readonly tools: NapariToolBridge;
  readonly store: VisualizerStore;
  readonly regionStore: RegionStore;
  readonly settings: NapariSettings;
  readonly stack: StackProgress;
  /** The image's full-resolution size as the scene drew it — read by the readback, the camera
   *  fit and `getTrueImageSize()`; it outlives the scene. */
  imageSize(): { width: number; height: number };
  setImageSize(width: number, height: number): void;
  /** Fit the 2D camera to the image on the next frame. */
  fitCameraSoon(): void;
  outsideZone<T>(fn: () => T): T;
  inZone<T>(fn: () => T): T;
}
