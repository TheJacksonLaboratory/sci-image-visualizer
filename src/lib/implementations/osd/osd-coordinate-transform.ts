import { ICoordinateTransform } from '../../contracts/coordinate-transform.contract';
import { elementToImage, imageToElement } from './osd-coords';

/**
 * OpenSeadragon implementation of {@link ICoordinateTransform}. "Data coords"
 * here are image-pixel coordinates (OSD's native shape space), obtained from the
 * viewport API. This is the reason the tools can run over OSD at all: the
 * viewport gives a clean screen<->image mapping that holds across pan/zoom.
 */
export class OsdCoordinateTransform implements ICoordinateTransform {

  constructor(private viewer: any) {}

  isReady(): boolean {
    return !!this.viewer?.viewport && this.viewer.world?.getItemCount() > 0;
  }

  clientToData(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.viewer.canvas.getBoundingClientRect();
    return elementToImage(this.viewer, clientX - rect.left, clientY - rect.top);
  }

  dataLengthToScreen(dataLength: number): number {
    const a = imageToElement(this.viewer, 0, 0);
    const b = imageToElement(this.viewer, dataLength, 0);
    return Math.abs(b.x - a.x);
  }
}
