import { ScaleBarElement, createScaleBarElement, scaleBarFor } from '../../overlays/scale-bar-core';

/**
 * Physical scale bar for the napari-js WebGPU image view (jit-ui#102): an adapter over the shared
 * {@link scaleBarFor} / {@link createScaleBarElement}, as the OSD backend's `OsdScaleBar` is.
 * napari keeps layers at pixel scale, so the camera's `zoom` (CSS px per world unit) is exactly
 * screen px per image pixel; combined with the image's µm/pixel (`mppX`, from Bio-Formats
 * `/tiles/info`) that gives a real-world bar length. Recomputes on every camera change and host
 * resize. Hidden when the image has no physical size.
 */

/**
 * The slice of the napari Camera the scale bar reads (zoom = CSS px per world/image pixel).
 *
 * Exported so the 3D spatial view can satisfy it with a shim: an orbit camera has no `zoom`, but
 * px-per-world-unit AT THE PIVOT DEPTH is well defined, and that is what a 3D scale bar means.
 */
export interface ScaleBarCamera {
  readonly zoom: number;
  readonly changed: { connect(listener: () => void): () => void };
}

export class NapariScaleBar {
  private readonly el: ScaleBarElement;
  private readonly disconnectCamera: () => void;
  private readonly resizeObserver?: ResizeObserver;

  constructor(
    private readonly host: HTMLElement,
    private readonly camera: ScaleBarCamera,
    private readonly mppX: number,
  ) {
    // The bar is absolutely positioned within the host, so the host must establish a containing
    // block (the plot host is often statically positioned).
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    this.el = createScaleBarElement(host);

    this.disconnectCamera = this.camera.changed.connect(() => this.update());
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.update());
      this.resizeObserver.observe(this.host);
    }
    this.update();
  }

  private update(): void {
    this.el.render(scaleBarFor(this.camera.zoom, this.mppX)); // zoom = CSS px per image pixel
  }

  destroy(): void {
    this.disconnectCamera();
    this.resizeObserver?.disconnect();
    this.el.destroy();
  }
}
