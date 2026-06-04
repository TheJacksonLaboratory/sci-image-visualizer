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
});
