import { tintColormap } from 'napari-js';
import type { SurfaceLayer, Viewer } from 'napari-js';

import { VolumeFrame, toWorld } from './napari-volume-region-meshes';

/** The plane's colour: amber, apart from the grayscale volume and the region colours. */
export const SLICE_PLANE_COLOR = '#ffc83c';
/** The plane's opacity: enough to read where the slice is, not to hide the volume behind it. */
export const SLICE_PLANE_OPACITY = 0.22;

/**
 * The slice being edited beside the volume view (the split view's 2D pane), marked in the volume
 * as a translucent plane spanning the image at that slice's depth. Re-placed when the slice
 * changes or the volume's Z is stretched; not pickable (the region surfaces are).
 */
export class VolumeSlicePlane {
  private layer: SurfaceLayer | null = null;
  private frame: VolumeFrame | null = null;
  private z: number | null = null;

  constructor(private readonly viewer: Viewer) {}

  /** Follow the volume's frame (it opened, or its Z was stretched). */
  setFrame(frame: VolumeFrame): void {
    this.frame = frame;
    this.draw();
  }

  /** Mark slice `z` (null: no plane). */
  setZ(z: number | null): void {
    if (z === this.z) return;
    this.z = z;
    this.draw();
  }

  clear(): void {
    this.remove();
    this.z = null;
  }

  private draw(): void {
    this.remove();
    const { frame, z } = this;
    if (!frame || z === null) return;
    const [w, h] = frame.size;
    const corners = Float32Array.of(0, 0, z, w, 0, z, w, h, z, 0, h, z);
    this.layer = this.viewer.addSurface(
      toWorld(corners, frame),
      Uint32Array.of(0, 1, 2, 0, 2, 3),
      new Float32Array(4).fill(1),
      {
        name: 'slice plane',
        colormap: tintColormap(SLICE_PLANE_COLOR),
        contrastLimits: [0, 1],
        opacity: SLICE_PLANE_OPACITY,
        blending: 'translucent',
        fit: 'never',
      },
    );
    this.viewer.requestRender();
  }

  private remove(): void {
    if (!this.layer) return;
    this.viewer.layers.remove(this.layer);
    this.layer = null;
    this.viewer.requestRender();
  }
}
