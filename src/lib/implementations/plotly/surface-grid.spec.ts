import {
  SURFACE_MAX_SAMPLES,
  downsampleMatrix,
  strideFor,
  toScalarMatrix,
} from './plotly-trace-builders';

/**
 * The grid preparation the SURFACE renderer does before handing `z` to Plotly.
 *
 * `plotSurface` lives in `PlotlyService` (it is also reused by the high-def zoom
 * re-fetch), so it is not reachable through `PLOTLY_PLOT_TYPE_IMPLS`. These tests
 * cover the two pure pieces it now composes — the scalar projection and the mesh
 * cap — which is where the bug was: a surface built straight from a ~1000² preview
 * asks the gl3d renderer for ~1M vertices, the one grid size no other scalar mode
 * ever requests (CONTOUR caps at 400/axis, SCATTER3D / ISOSURFACE at 40-48).
 */
describe('surface grid preparation', () => {
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

  /** Exactly what plotSurface computes for its `z`. */
  function surfaceZ(frame: any[]): number[][] {
    const scalar = toScalarMatrix(frame);
    const rows = scalar.length;
    const cols = rows > 0 ? scalar[0].length : 0;
    const stride = Math.max(
      strideFor(rows, SURFACE_MAX_SAMPLES),
      strideFor(cols, SURFACE_MAX_SAMPLES));
    return downsampleMatrix(scalar, stride, stride);
  }

  it('caps a full-size preview grid on both axes', () => {
    // The real shape for the 18896x19376 slide in issue #40: a 1024-longest-side
    // preview comes back 999 x 1024, i.e. 1,022,976 cells.
    const z = surfaceZ(scalarFrame(999, 1024));

    expect(z.length).toBeLessThanOrEqual(SURFACE_MAX_SAMPLES);
    expect(z[0].length).toBeLessThanOrEqual(SURFACE_MAX_SAMPLES);
    // Two orders of magnitude fewer vertices than the uncapped mesh.
    expect(z.length * z[0].length).toBeLessThan(999 * 1024 / 8);
  });

  it('keeps the mesh proportions when capping (one stride for both axes)', () => {
    const z = surfaceZ(scalarFrame(999, 1024));
    const sourceAspect = 999 / 1024;
    const cappedAspect = z[0].length / z.length;
    // An uneven per-axis stride would distort a mesh that carries no x0/dx/y0/dy.
    expect(cappedAspect).toBeCloseTo(sourceAspect, 1);
  });

  it('leaves an already-small grid untouched', () => {
    const frame = scalarFrame(8, 4);
    const z = surfaceZ(frame);
    expect(z).toEqual(frame);
  });

  it('projects RGB cells to luminance so z is never an array', () => {
    // plotSurface is only reached when isGrayscale is set, but `load()` captured
    // that flag when the pixels were fetched. If it flips without a reload the
    // frames are still [r, g, b], and Plotly would coerce each cell to NaN.
    const z = surfaceZ(rgbFrame(500, 600));

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
  });
});
