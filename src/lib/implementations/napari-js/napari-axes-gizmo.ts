import type { AxesLayer, SurfaceLayer, Viewer } from 'napari-js';

import { ISurface3dControls } from '../../contracts/visualizer.contract';
import { NapariAxesLabels, AxisLabelSpec } from './napari-axes-labels';
import type { SceneContext } from './napari-scene';

/** A centred world box. */
export interface Box3 {
  width: number;
  height: number;
  depth: number;
}

/**
 * The 3D coordinate-axes / scale gizmo (review Appendix B): napari-js's `AxesLayer` plus the DOM
 * X/Y/Z labels that track it — what the volume and the surface used to build twice.
 */
export class Axes3dGizmo {
  readonly layer: AxesLayer;
  private readonly labels: NapariAxesLabels;

  constructor(
    private readonly viewer: Viewer,
    host: HTMLElement,
    box: Box3,
    labels: AxisLabelSpec[],
    opts: { visible: boolean; voxelSize?: [number, number, number] },
  ) {
    this.layer = viewer.addAxes(box.width, box.height, box.depth, {
      ...(opts.voxelSize ? { voxelSize: opts.voxelSize } : {}),
      visible: opts.visible,
    });
    this.labels = new NapariAxesLabels(host, viewer.camera3d, labels);
    this.labels.setVisible(opts.visible);
  }

  setVisible(visible: boolean): void {
    this.labels.setVisible(visible);
    this.layer.visible = visible;
    this.viewer.requestRender();
  }

  /** The box's depth changed (the volume's Z-height handle): restretch the axis and its labels. */
  setDepth(depth: number, labels: AxisLabelSpec[]): void {
    this.layer.depth = depth;
    this.labels.updateAnchors(labels);
  }

  destroy(): void {
    this.labels.destroy();
  }
}

/** A Plotly-style 3D drag mode, as napari-js's camera drag mode (orbit/turntable → rotate). */
export function cameraDragMode(mode: string): 'pan' | 'zoom' | 'rotate' {
  return mode === 'pan' ? 'pan' : mode === 'zoom' ? 'zoom' : 'rotate';
}

/**
 * The 3D view controls every 3D image scene offers: camera drag mode and re-framing, the axes
 * gizmo's visibility and the surface's wireframe — both persisted in the viewer settings, so the
 * next mount re-applies them.
 */
export function surface3dControls(
  ctx: SceneContext,
  gizmo: () => Axes3dGizmo | null,
  surface: () => SurfaceLayer | null = () => null,
): ISurface3dControls {
  const { viewer, settings } = ctx;
  return {
    setSurfaceDragMode: (mode: string): void => viewer.setCameraDragMode(cameraDragMode(mode)),
    // napari-js frames the union of every 3D layer's bounds, with its adders' framing.
    resetSurfaceCamera: (): void => {
      viewer.fitToLayers();
      viewer.requestRender();
    },
    setAxesVisible: (visible: boolean): void => {
      settings.axesVisible = visible;
      gizmo()?.setVisible(visible);
    },
    axesVisible: (): boolean => settings.axesVisible,
    // Surface wireframe (napari-js surface only) — a live layer property, no rebuild needed.
    setWireframe: (on: boolean): void => {
      settings.surfaceWireframe = on;
      const layer = surface();
      if (layer) {
        layer.wireframe = on;
        viewer.requestRender();
      }
    },
    wireframe: (): boolean => settings.surfaceWireframe,
  };
}
