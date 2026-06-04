import { ICoordinateTransform } from '../../contracts/coordinate-transform.contract';

/**
 * Plotly implementation of {@link ICoordinateTransform}. Wraps the axis objects
 * on the plot's `_fullLayout`. This is the exact math the wand / vertex-eraser
 * used inline before they were decoupled — lifted here verbatim so Plotly
 * behaviour is unchanged.
 */
export class PlotlyCoordinateTransform implements ICoordinateTransform {

  constructor(
    private getGraphDiv: () => any,
    private getContainer: () => HTMLElement | null,
  ) {}

  private axes(): { xaxis: any; yaxis: any } {
    const layout = this.getGraphDiv()?._fullLayout;
    return { xaxis: layout?.xaxis, yaxis: layout?.yaxis };
  }

  isReady(): boolean {
    const { xaxis, yaxis } = this.axes();
    return !!(xaxis && yaxis);
  }

  clientToData(clientX: number, clientY: number): { x: number; y: number } {
    const { xaxis, yaxis } = this.axes();
    const rect = this.getContainer()?.getBoundingClientRect();
    if (!xaxis || !yaxis || !rect) return { x: NaN, y: NaN };
    return {
      x: xaxis.p2d(clientX - rect.left - xaxis._offset),
      y: yaxis.p2d(clientY - rect.top - yaxis._offset),
    };
  }

  dataLengthToScreen(dataLength: number): number {
    const { xaxis } = this.axes();
    if (!xaxis) return 0;
    return Math.abs(xaxis.l2p(dataLength) - xaxis.l2p(0));
  }
}
