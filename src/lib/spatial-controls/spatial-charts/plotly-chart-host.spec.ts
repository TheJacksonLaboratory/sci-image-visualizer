jest.mock('plotly.js-dist-min', () => ({
  react: jest.fn().mockResolvedValue(undefined),
  relayout: jest.fn(),
  purge: jest.fn(() => {
    throw new Error('no plot');
  }),
}));
import * as Plotly from 'plotly.js-dist-min';

import { PlotlyChartHost } from './plotly-chart-host';

describe('PlotlyChartHost', () => {
  let host: PlotlyChartHost;
  let div: HTMLDivElement;

  beforeEach(() => {
    jest.clearAllMocks();
    host = new PlotlyChartHost();
    div = document.createElement('div');
    div.id = 'host-test';
    Object.defineProperty(div, 'clientWidth', { value: 320, configurable: true });
    document.body.appendChild(div);
  });

  afterEach(() => div.remove());

  it('remembers whether the drawn layout fixed its height, and refits accordingly', async () => {
    await host.draw('host-test', [], { height: 500 });
    expect(Plotly.react).toHaveBeenCalledWith('host-test', [], { height: 500 }, expect.any(Object));
    expect(host.hasFixedHeight).toBe(true);
    host.refit('host-test');
    expect(Plotly.relayout).toHaveBeenLastCalledWith(div, { width: 320 });
    await host.draw('host-test', [], {});
    host.refit('host-test');
    expect(Plotly.relayout).toHaveBeenLastCalledWith(div, { autosize: true });
  });

  it('does not refit a missing or zero-width div, nor fail purging an empty one', () => {
    host.refit('nowhere');
    Object.defineProperty(div, 'clientWidth', { value: 0 });
    host.refit('host-test');
    expect(Plotly.relayout).not.toHaveBeenCalled();
    expect(() => host.purge('host-test')).not.toThrow();
  });

  it('turns a selection into observation indices, and an empty one into a clear', () => {
    const listeners: Record<string, (ev?: unknown) => void> = {};
    Object.assign(div, {
      on: (name: string, fn: (ev?: unknown) => void) => {
        listeners[name] = fn;
      },
      removeAllListeners: jest.fn(),
    });
    const selected = jest.fn();
    const deselected = jest.fn();
    host.bindSelection('host-test', { selected, deselected });
    listeners['plotly_selected']({ points: [{ customdata: 4 }, { customdata: 'x' }, { customdata: 9 }] });
    expect(selected).toHaveBeenCalledWith([4, 9]);
    listeners['plotly_selected']({ points: [] });
    listeners['plotly_deselect']();
    expect(deselected).toHaveBeenCalledTimes(2);
    host.unbindSelection('host-test');
    expect((div as unknown as { removeAllListeners: jest.Mock }).removeAllListeners).toHaveBeenCalledWith(
      'plotly_deselect',
    );
  });

  it('reads back a 3D camera, or a 2D range only once zoomed', () => {
    expect(host.liveView('host-test')).toBeNull();
    const full = (layout: unknown) => Object.assign(div, { _fullLayout: layout });
    full({ scene: { camera: { eye: 1 } } });
    expect(host.liveView('host-test')).toEqual({ camera: { eye: 1 } });
    full({ xaxis: { range: [0, 1], autorange: true }, yaxis: { range: [0, 1], autorange: true } });
    expect(host.liveView('host-test')).toBeNull();
    full({ xaxis: { range: [0, 1], autorange: false }, yaxis: { range: [2, 3], autorange: false } });
    expect(host.liveView('host-test')).toEqual({ ranges: { x: [0, 1], y: [2, 3] } });
  });
});
