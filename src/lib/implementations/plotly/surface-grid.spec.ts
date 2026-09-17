import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { MessageService } from 'primeng/api';
import * as Plotly from 'plotly.js-dist-min';

import { PlotlyService, PlotType } from './plotly.service';
import { VIZ_PORT_STUBS } from '../../testing/viz-port-stubs';
import { IImageInfo } from '../../contracts/image.contract';
import {
  SURFACE_MAX_SAMPLES,
  prepareSurfaceGrid,
  toScalarMatrix,
} from './plotly-trace-builders';

/**
 * The `z` grid a SURFACE trace is built from.
 *
 * `plotSurface` lives in `PlotlyService` rather than `PLOTLY_PLOT_TYPE_IMPLS`, so
 * it is not reachable through the trace-builder registry. The composition it
 * applies is `prepareSurfaceGrid`, which these tests call directly — the same
 * function the service calls, not a copy of the recipe.
 *
 * The bug: a surface built straight from a ~1000² preview asks the gl3d renderer
 * for ~1M vertices, the one grid size no other scalar mode ever requests
 * (CONTOUR caps at 400/axis, SCATTER3D / ISOSURFACE at 40-48).
 */
describe('prepareSurfaceGrid', () => {
  /** A `height x width` matrix of scalar cells. */
  function scalarFrame(width: number, height: number): number[][] {
    return Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => (x + y) % 256));
  }

  /** A `height x width` matrix of `[r, g, b]` cells. */
  function rgbFrame(width: number, height: number): any[][] {
    return Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => [x % 256, y % 256, 128]));
  }

  it('caps a full-size preview grid on both axes', () => {
    // The real shape for the 18896x19376 slide in issue #40: a 1024-longest-side
    // preview comes back 999 x 1024, i.e. 1,022,976 cells.
    const z = prepareSurfaceGrid(scalarFrame(999, 1024));

    expect(z.length).toBeLessThanOrEqual(SURFACE_MAX_SAMPLES);
    expect(z[0].length).toBeLessThanOrEqual(SURFACE_MAX_SAMPLES);
    // Two orders of magnitude fewer vertices than the uncapped mesh.
    expect(z.length * z[0].length).toBeLessThan(999 * 1024 / 8);
  });

  it('keeps the mesh proportions when capping (one stride for both axes)', () => {
    const z = prepareSurfaceGrid(scalarFrame(999, 1024));
    const sourceAspect = 999 / 1024;
    const cappedAspect = z[0].length / z.length;
    // An uneven per-axis stride would distort a mesh that carries no x0/dx/y0/dy.
    expect(cappedAspect).toBeCloseTo(sourceAspect, 1);
  });

  it('leaves an already-small grid untouched', () => {
    const frame = scalarFrame(8, 4);
    expect(prepareSurfaceGrid(frame)).toEqual(frame);
  });

  it('projects RGB cells to luminance so z is never an array', () => {
    // plotSurface is only reached when isGrayscale is set, but `load()` captured
    // that flag when the pixels were fetched. If it flips without a reload the
    // frames are still [r, g, b], and Plotly would coerce each cell to NaN.
    const z = prepareSurfaceGrid(rgbFrame(500, 600));

    for (const row of z) {
      for (const cell of row) {
        expect(Array.isArray(cell)).toBe(false);
        expect(Number.isFinite(cell)).toBe(true);
      }
    }
  });

  it('projects RGB with BT.601 weights, not the red channel', () => {
    // The reported symptom was a surface that looked like the red channel alone.
    // Pure green must therefore contribute, and more than pure red does.
    const red = toScalarMatrix([[[255, 0, 0]]])[0][0];
    const green = toScalarMatrix([[[0, 255, 0]]])[0][0];
    const blue = toScalarMatrix([[[0, 0, 255]]])[0][0];

    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
    expect(toScalarMatrix([[[255, 255, 255]]])[0][0]).toBeCloseTo(255, 0);
  });

  it('passes scalar frames through the projection unchanged', () => {
    const frame = scalarFrame(6, 5);
    expect(toScalarMatrix(frame)).toBe(frame);
  });

  it('tolerates an empty frame', () => {
    expect(toScalarMatrix([])).toEqual([]);
    expect(prepareSurfaceGrid([])).toEqual([]);
  });
});

/**
 * The guard that actually protects the fix: assert what `plotSurface` hands to
 * Plotly. The helper tests above would all still pass if `plotSurface` stopped
 * calling `prepareSurfaceGrid` and passed the raw frame through, so they cannot
 * catch the regression on their own.
 */
describe('PlotlyService SURFACE trace', () => {
  let service: PlotlyService;
  let newPlotSpy: jest.SpyInstance;

  /** Full-size preview shape, RGB cells — the worst case on both axes. */
  function rgbPreview(width: number, height: number): any[][] {
    return Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => [x % 256, y % 256, (x + y) % 256]));
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PlotlyService, ...VIZ_PORT_STUBS, MessageService],
    });
    service = TestBed.inject(PlotlyService);
    document.body.innerHTML = '<div id="plot"></div>';
    newPlotSpy = jest.spyOn(Plotly, 'newPlot').mockResolvedValue({} as any);
    // Plotly normally decorates the div with .on during newPlot; with newPlot
    // stubbed there is nothing to bind to, and event wiring is not under test.
    jest.spyOn(service as any, 'setEvents').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Drive the real dispatch in PlotlyService.plot for SURFACE. */
  async function plotSurfaceWith(frame: any[][]): Promise<any> {
    const imageInfo = {
      urls: ['unused-in-this-test'],
      trueImageSize: [999, 1024],
      // plot() routes SURFACE through plotSurface only on the grayscale branch.
      isGrayscale: true,
      isStack: false,
      showStack: false,
      scaleRatio: true,
      fileName: 'slide.tiff',
      imageMeta: [],
    } as unknown as IImageInfo;

    await service.plot('plot',
      { data: [frame], ratios: [1, 1], sizes: [frame[0].length, frame.length] },
      imageInfo, 811, PlotType.SURFACE);

    expect(newPlotSpy).toHaveBeenCalled();
    const traces = newPlotSpy.mock.calls[0][1] as any[];
    expect(traces).toHaveLength(1);
    expect(traces[0].type).toBe('surface');
    return traces[0];
  }

  it('caps the z grid it passes to Plotly', async () => {
    const trace = await plotSurfaceWith(rgbPreview(999, 1024));

    expect(trace.z.length).toBeLessThanOrEqual(SURFACE_MAX_SAMPLES);
    expect(trace.z[0].length).toBeLessThanOrEqual(SURFACE_MAX_SAMPLES);
    // The uncapped mesh this fix removes.
    expect(trace.z.length).toBeLessThan(1024);
  });

  it('passes scalar cells, never [r, g, b] arrays, to Plotly', async () => {
    const trace = await plotSurfaceWith(rgbPreview(999, 1024));

    for (const row of trace.z) {
      for (const cell of row) {
        expect(Array.isArray(cell)).toBe(false);
        expect(Number.isFinite(cell)).toBe(true);
      }
    }
  });

  it('matches prepareSurfaceGrid exactly, so the helper tests are binding', async () => {
    const frame = rgbPreview(999, 1024);
    const trace = await plotSurfaceWith(frame);

    expect(trace.z).toEqual(prepareSurfaceGrid(frame));
  });
});
