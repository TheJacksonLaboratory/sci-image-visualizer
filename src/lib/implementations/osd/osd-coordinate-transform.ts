import * as OpenSeadragon from 'openseadragon';
import { ICoordinateTransform } from '../../contracts/coordinate-transform.contract';

/**
 * OpenSeadragon implementation of {@link ICoordinateTransform}. "Data coords"
 * here are image-pixel coordinates (OSD's native shape space), obtained from the
 * viewport API. This is the reason the tools can run over OSD at all: the
 * viewport gives a clean screen<->image mapping that holds across pan/zoom.
 */
export class OsdCoordinateTransform implements ICoordinateTransform {

  private readonly osd: any = OpenSeadragon as any;

  constructor(private viewer: any) {}

  isReady(): boolean {
    return !!this.viewer?.viewport && this.viewer.world?.getItemCount() > 0;
  }

  clientToData(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.viewer.canvas.getBoundingClientRect();
    const pt = new this.osd.Point(clientX - rect.left, clientY - rect.top);
    const img = this.viewer.viewport.viewerElementToImageCoordinates(pt);
    return { x: img.x, y: img.y };
  }

  dataLengthToScreen(dataLength: number): number {
    const vp = this.viewer.viewport;
    const a = vp.imageToViewerElementCoordinates(new this.osd.Point(0, 0));
    const b = vp.imageToViewerElementCoordinates(new this.osd.Point(dataLength, 0));
    return Math.abs(b.x - a.x);
  }
}
