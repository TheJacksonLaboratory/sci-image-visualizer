import { VisualizerStore } from './visualizer-store.service';
import { IChannelState } from '../contracts/channel-histogram-api.contract';

/**
 * Pins the "Reset" baseline behaviour of the Channels & Histogram pane: resetting
 * a channel must restore its display window AND gamma AND its default tint colour
 * (not just min/max), so a colour the user changed snaps back on reset. The store
 * is constructed directly (no HttpClient) — the LUT fetch no-ops without one.
 */
describe('VisualizerStore.resetChannelState', () => {
  // channelCount>1 with rgbChannels==1 → one tinted channel per band, default
  // palette #ff0000/#00ff00/#0000ff (see deriveChannels).
  const meta = [{ channelCount: 3, rgbChannels: 1, x: 100, y: 100, z: 1 }] as any;

  it('restores window, gamma AND the default tint colour', () => {
    const store = new VisualizerStore();
    store.setImageMeta(meta);
    expect(store.currentChannelStates()[0].color).toBe('#ff0000');

    store.setChannelState(0, { color: '#123456', min: 10, max: 200, gamma: 2 });
    expect(store.currentChannelStates()[0].color).toBe('#123456');

    store.resetChannelState(0);
    expect(store.currentChannelStates()[0]).toMatchObject({
      color: '#ff0000',
      min: 0,
      max: 255,
      gamma: 1,
    });
  });

  it('only resets the targeted channel', () => {
    const store = new VisualizerStore();
    store.setImageMeta(meta);
    store.setChannelState(1, { color: '#abcdef', min: 50, max: 150 });

    store.resetChannelState(0);

    const states = store.currentChannelStates();
    expect(states[0].color).toBe('#ff0000'); // reset to default
    expect(states[1].color).toBe('#abcdef'); // untouched
    expect(states[1].min).toBe(50);
  });

  it('falls back to neutral defaults when no image baseline was captured', () => {
    const store = new VisualizerStore();
    const seed: IChannelState = {
      index: 0, name: 'X', color: '#abcabc', min: 5, max: 9, gamma: 3, visible: true,
    };
    store.setChannelStates([seed]);

    store.resetChannelState(0);

    expect(store.currentChannelStates()[0]).toMatchObject({
      color: '#ffffff',
      min: 0,
      max: 255,
      gamma: 1,
    });
  });
});
