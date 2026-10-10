import { axesSourceRect, channelDisplayRestyle, frameHistogram, tracePixels } from './plotly-readback';
import { PlotType } from '../../contracts/plot-type';

describe('plotly-readback', () => {
  it('flattens an RGB image trace, keeping its channels', () => {
    const px = tracePixels({ type: 'image', z: [[[1, 2, 3], [4, 5, 6]]] })!;
    expect(px).toMatchObject({ width: 2, height: 1, channels: 3 });
    expect(Array.from(px.data)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('flattens a heatmap trace to one rounded channel, and refuses an empty one', () => {
    const px = tracePixels({ type: 'heatmap', z: [[1.4, 2.6], [3, 4]] })!;
    expect(px).toMatchObject({ width: 2, height: 2, channels: 1 });
    expect(Array.from(px.data)).toEqual([1, 3, 3, 4]);
    expect(tracePixels({ type: 'heatmap', z: [] })).toBeNull();
    expect(tracePixels(undefined)).toBeNull();
  });

  it('bins a channel of RGB cells, or their luminance past the channels, clamped to 0-255', () => {
    const frame = [[[10, 20, 30], [10, 20, 30]], [[300, -5, 0]]];
    expect(frameHistogram(frame, 0).counts[10]).toBe(2);
    expect(frameHistogram(frame, 0).counts[255]).toBe(1);
    expect(frameHistogram(frame, 1).counts[0]).toBe(1);
    expect(frameHistogram([[7, 7, 8]], 0)).toMatchObject({ max: 2 });
  });

  it('reads the shown rect off the axes (reversed y), else the whole image', () => {
    expect(axesSourceRect([10, 50], [80, 20], [0, 100, 0, 100])).toEqual({ x: 10, y: 20, width: 40, height: 60 });
    expect(axesSourceRect(undefined, undefined, [0, 100, 0, 50])).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(axesSourceRect(undefined, undefined, undefined)).toBeNull();
  });

  it('restyles the window by plot type, and cancels reverse against invert', () => {
    const ch = [{ index: 0, name: 'I', color: '#fff', min: 5, max: 9, gamma: 1, visible: true }];
    expect(channelDisplayRestyle(ch, true, true, 'Viridis', PlotType.HEATMAP))
      .toEqual({ reversescale: false, colorscale: 'Viridis', zmin: 5, zmax: 9, zauto: false });
    expect(channelDisplayRestyle(ch, true, false, null, PlotType.ISOSURFACE))
      .toEqual({ reversescale: true, cmin: 5, cmax: 9, cauto: false });
    expect(channelDisplayRestyle([], false, false, undefined, PlotType.HEATMAP)).toEqual({ reversescale: false });
  });
});
