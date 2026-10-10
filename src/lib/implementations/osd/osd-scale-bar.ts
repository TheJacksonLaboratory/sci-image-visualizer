import { ScaleBarElement, createScaleBarElement, scaleBarFor } from '../../overlays/scale-bar-core';
import { imageToElement } from './osd-coords';
import { OsdViewerLike } from './osd-viewer-like';

/**
 * A physical scale bar drawn over an OpenSeadragon viewer: an adapter over the shared
 * {@link scaleBarFor} / {@link createScaleBarElement}. Recomputes on every pan/zoom from the
 * image→screen scale and the image's µm/pixel (`mppX`, from Bio-Formats). Hidden when the image
 * has no physical pixel size.
 */
export class OsdScaleBar {
  private readonly el: ScaleBarElement;
  private readonly redrawHandler = () => this.update();

  constructor(
    private viewer: OsdViewerLike,
    private mppX: number,
  ) {
    this.el = createScaleBarElement(this.viewer.canvas);
    this.viewer.addHandler('update-viewport', this.redrawHandler);
    this.viewer.addHandler('animation', this.redrawHandler);
    this.viewer.addHandler('resize', this.redrawHandler);
    this.update();
  }

  private update(): void {
    if (!(this.mppX > 0) || !this.viewer.viewport || this.viewer.world?.getItemCount() === 0) {
      this.el.render(null);
      return;
    }
    // Through osd-coords (world item 0), which stays accurate while the world
    // holds several slices — the viewport's own image conversion does not.
    const a = imageToElement(this.viewer, 0, 0);
    const b = imageToElement(this.viewer, 1, 0);
    this.el.render(scaleBarFor(Math.abs(b.x - a.x), this.mppX));
  }

  destroy(): void {
    this.viewer.removeHandler('update-viewport', this.redrawHandler);
    this.viewer.removeHandler('animation', this.redrawHandler);
    this.viewer.removeHandler('resize', this.redrawHandler);
    this.el.destroy();
  }
}
