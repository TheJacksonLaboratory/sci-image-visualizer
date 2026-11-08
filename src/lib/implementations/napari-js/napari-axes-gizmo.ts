import type { AxesLayer, SurfaceLayer, Viewer } from 'napari-js';
import { AxesLabelsOverlay } from 'napari-js/overlays';
import type { AxisLabelSpec } from 'napari-js/overlays';

import { ISurface3dControls } from '../../contracts/visualizer.contract';
import type { SceneContext } from './napari-scene';

/** A centred world box. */
export interface Box3 {
  width: number;
  height: number;
  depth: number;
}

/**
 * The 3D coordinate-axes / scale gizmo (review Appendix B): napari-js's `AxesLayer` plus the DOM
 * X/Y/Z labels that track it (its `AxesLabelsOverlay`) — what the volume and the surface used to
 * build twice.
 */
export class Axes3dGizmo {
  readonly layer: AxesLayer;
  private readonly labels: AxesLabelsOverlay;

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
    this.labels = new AxesLabelsOverlay(host, viewer, { labels, visible: opts.visible });
  }

  setVisible(visible: boolean): void {
    this.labels.setVisible(visible);
    this.layer.visible = visible;
    this.viewer.requestRender();
  }

  /** The box's depth changed (the volume's Z-height handle): restretch the axis and its labels. */
  setDepth(depth: number, labels: AxisLabelSpec[]): void {
    this.layer.depth = depth;
    this.labels.setLabels(labels);
  }

  destroy(): void {
    this.labels.dispose();
  }
}

/** A Plotly-style 3D drag mode, as napari-js's camera drag mode (orbit/turntable → rotate). */
export function cameraDragMode(mode: string): 'pan' | 'zoom' | 'rotate' {
  return mode === 'pan' ? 'pan' : mode === 'zoom' ? 'zoom' : 'rotate';
}

/** Every surface the viewer draws (a volume's region classes, spatial 3D's cells and classes). */
export function surfaceLayers(viewer: Viewer): SurfaceLayer[] {
  return viewer.layers.items.filter((l): l is SurfaceLayer => (l as { kind?: string }).kind === 'surface');
}

/**
 * The 3D view controls every 3D image scene offers: camera drag mode and re-framing, the axes
 * gizmo's visibility and the wireframe of its `surfaces` — both persisted in the viewer settings,
 * so the next mount re-applies them, and a surface added later takes the wireframe as it is (see
 * `settings.surfaceWireframe`).
 */
export function surface3dControls(
  ctx: SceneContext,
  gizmo: () => Axes3dGizmo | null,
  surfaces: () => readonly SurfaceLayer[] = () => [],
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
    // Surface wireframe — a live layer property, no rebuild needed.
    setWireframe: (on: boolean): void => {
      settings.surfaceWireframe = on;
      const layers = surfaces();
      for (const layer of layers) layer.wireframe = on;
      if (layers.length) viewer.requestRender();
    },
    wireframe: (): boolean => settings.surfaceWireframe,
  };
}
