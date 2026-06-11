import { PlotlyCoordinateTransform } from './plotly-coordinate-transform';

/** Stub Plotly axes: p2d/l2p are simple linear maps so the expected math is obvious. */
function axes() {
  return {
    xaxis: { p2d: (px: number) => px / 10, l2p: (d: number) => d * 10, _offset: 50 },
    yaxis: { p2d: (px: number) => px / 5, l2p: (d: number) => d * 5, _offset: 20 },
  };
}

describe('PlotlyCoordinateTransform', () => {
  it('isReady is false before the layout has axes', () => {
    const t = new PlotlyCoordinateTransform(() => ({}), () => null);
    expect(t.isReady()).toBe(false);
  });

  it('isReady is true once _fullLayout carries both axes', () => {
    const t = new PlotlyCoordinateTransform(
      () => ({ _fullLayout: axes() }),
      () => document.createElement('div'),
    );
    expect(t.isReady()).toBe(true);
  });

  it('clientToData subtracts the container rect + axis offset, then applies p2d', () => {
    const container = { getBoundingClientRect: () => ({ left: 100, top: 200 }) } as any;
    const t = new PlotlyCoordinateTransform(() => ({ _fullLayout: axes() }), () => container);
    // x: p2d(300 - 100 - 50) = p2d(150) = 15 ; y: p2d(450 - 200 - 20) = p2d(230) = 46
    expect(t.clientToData(300, 450)).toEqual({ x: 15, y: 46 });
  });

  it('clientToData returns NaN when the axes or container rect are unavailable', () => {
    const t = new PlotlyCoordinateTransform(() => ({}), () => null);
    expect(t.clientToData(1, 2)).toEqual({ x: NaN, y: NaN });
  });

  it('dataLengthToScreen is |l2p(len) - l2p(0)|', () => {
    const t = new PlotlyCoordinateTransform(() => ({ _fullLayout: axes() }), () => null);
    expect(t.dataLengthToScreen(4)).toBe(40);
  });

  it('dataLengthToScreen is 0 with no x-axis', () => {
    const t = new PlotlyCoordinateTransform(() => ({}), () => null);
    expect(t.dataLengthToScreen(4)).toBe(0);
  });
});
