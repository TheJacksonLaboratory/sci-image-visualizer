import { PlotType } from '../../contracts/plot-type';
import { PLOTLY_PLOT_TYPE_IMPLS, TraceBuildInput } from './plotly-trace-builders';

/**
 * Unit tests for the pure plot-type trace builders. No Angular / Plotly —
 * these are plain functions, which is exactly why they live outside the
 * service (and relocate cleanly into the visualization library).
 */
describe('plotly-trace-builders', () => {
  function grayInput(overrides: Partial<TraceBuildInput> = {}): TraceBuildInput {
    // 2 frames, 4x3 (width x height) scalar matrices.
    const frame = [
      [0, 10, 20, 30],
      [40, 50, 60, 70],
      [80, 90, 100, 110],
    ];
    return {
      frames: [frame, frame.map(r => r.map(v => v + 1))],
      width: 4,
      height: 3,
      ratios: [2, 2],
      trueImageSize: [0, 8, 0, 6],
      isGrayscale: true,
      colorscale: 'Viridis',
      reversescale: false,
      regions: [],
      shapeColor: '#00FFFF',
      isoMin: 100,
      isoMax: 200,
      ...overrides,
    };
  }

  it('registry covers contour, scatter, scatter3d, isosurface only', () => {
    const keys = Object.keys(PLOTLY_PLOT_TYPE_IMPLS).sort();
    expect(keys).toEqual(
      [PlotType.CONTOUR, PlotType.ISOSURFACE, PlotType.SCATTER, PlotType.SCATTER3D].sort(),
    );
    // The original renderers stay in the service, not the registry.
    expect(PLOTLY_PLOT_TYPE_IMPLS[PlotType.HEATMAP]).toBeUndefined();
    expect(PLOTLY_PLOT_TYPE_IMPLS[PlotType.SURFACE]).toBeUndefined();
  });

  it('CONTOUR builds one contour trace per frame, first visible', () => {
    const traces = PLOTLY_PLOT_TYPE_IMPLS[PlotType.CONTOUR]!.buildTraces(grayInput());
    expect(traces.length).toBe(2);
    expect(traces[0].type).toBe('contour');
    expect(traces[0].visible).toBe(true);
    expect(traces[1].visible).toBe(false);
    expect(traces[0].dx).toBe(2);
  });

  it('SCATTER plots region centroids', () => {
    const regions = [
      { xpoints: [0, 10, 10, 0], ypoints: [0, 0, 10, 10] }, // centroid (5,5)
      { xpoints: [20, 30], ypoints: [20, 40] },             // centroid (25,30)
    ];
    const traces = PLOTLY_PLOT_TYPE_IMPLS[PlotType.SCATTER]!.buildTraces(grayInput({ regions }));
    expect(traces[0].x).toEqual([5, 25]);
    expect(traces[0].y).toEqual([5, 30]);
    expect(traces[0].text).toEqual(['R1', 'R2']);
  });

  it('SCATTER3D produces parallel x/y/z/value voxel arrays', () => {
    const traces = PLOTLY_PLOT_TYPE_IMPLS[PlotType.SCATTER3D]!.buildTraces(grayInput());
    const t = traces[0];
    expect(t.type).toBe('scatter3d');
    expect(t.x.length).toBe(t.y.length);
    expect(t.y.length).toBe(t.z.length);
    expect(t.z.length).toBe(t.marker.color.length);
    expect(t.x.length).toBeGreaterThan(0);
  });

  it('ISOSURFACE uses the supplied isoMin/isoMax bounds', () => {
    const traces = PLOTLY_PLOT_TYPE_IMPLS[PlotType.ISOSURFACE]!.buildTraces(
      grayInput({ isoMin: 80, isoMax: 180 }));
    const t = traces[0];
    expect(t.type).toBe('isosurface');
    expect(t.isomin).toBe(80);
    expect(t.isomax).toBe(180);
    expect(t.value.length).toBe(t.x.length);
  });

  it('converts RGB frames to luminance for scalar plots', () => {
    const rgbFrame = [
      [[255, 0, 0], [0, 255, 0]],
      [[0, 0, 255], [255, 255, 255]],
    ];
    const traces = PLOTLY_PLOT_TYPE_IMPLS[PlotType.CONTOUR]!.buildTraces(grayInput({
      frames: [rgbFrame],
      isGrayscale: false,
      width: 2,
      height: 2,
    }));
    // Row index 1 → [blue, white] → luminance [~29.07, 255].
    expect(traces[0].z[1][0]).toBeCloseTo(0.114 * 255, 2);
    expect(traces[0].z[1][1]).toBeCloseTo(255, 2);
  });

  it('thickens a single frame so 3D traces still render', () => {
    const traces = PLOTLY_PLOT_TYPE_IMPLS[PlotType.SCATTER3D]!.buildTraces(grayInput({
      frames: [grayInput().frames[0]],
    }));
    // z spans two planes (0 and 1) even though only one frame was supplied.
    const zMax = Math.max(...traces[0].z);
    expect(zMax).toBe(1);
  });
});
