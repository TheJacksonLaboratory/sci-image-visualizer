import { ZoomToBoxTool } from './zoom-to-box-tool.service';
import { CanvasToolHost } from '../tool-kit/canvas-tool';

describe('ZoomToBoxTool overlay lifecycle', () => {
  let service: ZoomToBoxTool;
  let applyZoomToBox: jest.Mock;
  let host: CanvasToolHost;

  beforeEach(() => {
    service = new ZoomToBoxTool();

    applyZoomToBox = jest.fn();
    host = {
      getOverlayContainer: () => document.getElementById('plot'),
      pixelToData: (px: number, py: number) => ({ x: px, y: py }),
      applyZoomToBox,
    } as unknown as CanvasToolHost;

    document.body.innerHTML = '<div id="plot"></div>';
  });

  it('creates a canvas overlay when the tool is activated', () => {
    service.activate(host);

    const plotEl = document.getElementById('plot');
    const canvas = plotEl?.querySelector('canvas');
    expect(canvas).toBeTruthy();
    expect(canvas?.style.cursor).toBe('crosshair');

    // Clean up.
    service.deactivate();
    expect(plotEl?.querySelector('canvas')).toBeNull();
  });

  it('removes the canvas overlay when the tool is deactivated', () => {
    service.activate(host);
    service.deactivate();

    const plotEl = document.getElementById('plot');
    expect(plotEl?.querySelector('canvas')).toBeNull();
  });

  function canvas(): HTMLCanvasElement {
    return document.getElementById('plot')!.querySelector('canvas') as HTMLCanvasElement;
  }

  it('a drag selection applies the ordered [xMin, xMax, yMax, yMin] data coords', () => {
    service.activate(host);
    const c = canvas();
    // jsdom getBoundingClientRect is all-zeros and pixelToData is identity, so
    // data coords equal the client coords.
    c.dispatchEvent(new MouseEvent('pointerdown', { clientX: 10, clientY: 10 }));
    c.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, clientY: 50 }));
    c.dispatchEvent(new MouseEvent('pointerup', { clientX: 40, clientY: 50 }));
    expect(applyZoomToBox).toHaveBeenCalledWith([10, 40, 50, 10]);
  });

  it('ignores a tiny drag (accidental click) without zooming', () => {
    service.activate(host);
    const c = canvas();
    c.dispatchEvent(new MouseEvent('pointerdown', { clientX: 10, clientY: 10 }));
    c.dispatchEvent(new MouseEvent('pointerup', { clientX: 12, clientY: 11 })); // < 5px each axis
    expect(applyZoomToBox).not.toHaveBeenCalled();
  });

  it('mousemove and mouseup without a prior mousedown are no-ops', () => {
    service.activate(host);
    const c = canvas();
    expect(() => {
      c.dispatchEvent(new MouseEvent('pointermove', { clientX: 5, clientY: 5 }));
      c.dispatchEvent(new MouseEvent('pointerup', { clientX: 40, clientY: 40 }));
    }).not.toThrow();
    expect(applyZoomToBox).not.toHaveBeenCalled();
  });

  it('draws the selection rectangle on drag-move without throwing', () => {
    service.activate(host);
    const c = canvas();
    c.dispatchEvent(new MouseEvent('pointerdown', { clientX: 10, clientY: 10 }));
    expect(() => c.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, clientY: 50 }))).not.toThrow();
  });

  it('only the primary button starts a zoom box (RT-31)', () => {
    service.activate(host);
    const c = canvas();
    c.dispatchEvent(new MouseEvent('pointerdown', { button: 2, clientX: 10, clientY: 10 }));
    c.dispatchEvent(new MouseEvent('pointerup', { button: 2, clientX: 60, clientY: 60 }));
    expect(applyZoomToBox).not.toHaveBeenCalled();
    service.deactivate();
  });
});
