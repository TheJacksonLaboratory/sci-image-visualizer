import { TestBed } from '@angular/core/testing';

import { ZoomToBoxToolService } from './zoom-to-box-tool.service';

describe('ZoomToBoxToolService overlay lifecycle', () => {
  let service: ZoomToBoxToolService;
  let applyZoomToBox: jest.Mock;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [ZoomToBoxToolService] });
    service = TestBed.inject(ZoomToBoxToolService);

    applyZoomToBox = jest.fn();
    service.bindHost({
      getPlotDiv: () => 'plot',
      pixelToData: (px, py) => ({ x: px, y: py }),
      applyZoomToBox,
    });

    document.body.innerHTML = '<div id="plot"></div>';
  });

  it('creates a canvas overlay when the tool is activated', () => {
    service.setMode(true);

    const plotEl = document.getElementById('plot');
    const canvas = plotEl?.querySelector('canvas');
    expect(canvas).toBeTruthy();
    expect(canvas?.style.cursor).toBe('crosshair');

    // Clean up.
    service.setMode(false);
    expect(plotEl?.querySelector('canvas')).toBeNull();
  });

  it('removes the canvas overlay when the tool is deactivated', () => {
    service.setMode(true);
    service.setMode(false);

    const plotEl = document.getElementById('plot');
    expect(plotEl?.querySelector('canvas')).toBeNull();
  });

  function canvas(): HTMLCanvasElement {
    return document.getElementById('plot')!.querySelector('canvas') as HTMLCanvasElement;
  }

  it('a drag selection applies the ordered [xMin, xMax, yMax, yMin] data coords', () => {
    service.setMode(true);
    const c = canvas();
    // jsdom getBoundingClientRect is all-zeros and pixelToData is identity, so
    // data coords equal the client coords.
    c.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10 }));
    c.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 50 }));
    c.dispatchEvent(new MouseEvent('mouseup', { clientX: 40, clientY: 50 }));
    expect(applyZoomToBox).toHaveBeenCalledWith([10, 40, 50, 10]);
  });

  it('ignores a tiny drag (accidental click) without zooming', () => {
    service.setMode(true);
    const c = canvas();
    c.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10 }));
    c.dispatchEvent(new MouseEvent('mouseup', { clientX: 12, clientY: 11 })); // < 5px each axis
    expect(applyZoomToBox).not.toHaveBeenCalled();
  });

  it('mousemove and mouseup without a prior mousedown are no-ops', () => {
    service.setMode(true);
    const c = canvas();
    expect(() => {
      c.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5 }));
      c.dispatchEvent(new MouseEvent('mouseup', { clientX: 40, clientY: 40 }));
    }).not.toThrow();
    expect(applyZoomToBox).not.toHaveBeenCalled();
  });

  it('draws the selection rectangle on drag-move without throwing', () => {
    service.setMode(true);
    const c = canvas();
    c.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10 }));
    expect(() => c.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 50 }))).not.toThrow();
  });
});
