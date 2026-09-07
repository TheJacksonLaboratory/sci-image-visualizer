import { PlotType, rendererOwnsWheel } from './plot-type';

/**
 * Which plot types keep their own wheel zoom.
 *
 * The shell's wheel listener applies a fixed step per event. Handing it a plot
 * type whose renderer reads the scroll delta makes zoom an order of magnitude
 * too sensitive — measured at 30% per event against napari-js's 3% — and throws
 * away the renderer's device normalization and easing.
 */
describe('rendererOwnsWheel', () => {
  it('leaves the wheel to napari-js for the spatial-omics modes', () => {
    // The regression: these are drawn by the same napari-js viewer as the image
    // view, but the shell gated on an `isHeatmap` flag that defaults to true and
    // only goes false for the 3D Plotly scenes, so it took their wheel too.
    expect(rendererOwnsWheel(PlotType.SPATIAL_OMICS)).toBe(true);
    expect(rendererOwnsWheel(PlotType.SPATIAL_OMICS_3D)).toBe(true);
  });

  it('leaves the wheel to the image view, as it always did', () => {
    expect(rendererOwnsWheel(PlotType.IMAGE)).toBe(true);
  });

  it('keeps the shell’s step for the Plotly plot types', () => {
    // These have no renderer-side wheel zoom to defer to, so the fixed step is
    // the only zoom they have — turning it off would leave them unable to zoom.
    expect(rendererOwnsWheel(PlotType.HEATMAP)).toBe(false);
    expect(rendererOwnsWheel(PlotType.CONTOUR)).toBe(false);
  });
});
