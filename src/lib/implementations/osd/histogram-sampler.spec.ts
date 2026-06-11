import { of, throwError, firstValueFrom } from 'rxjs';

import { HistogramSampler, HistogramSamplerHost } from './histogram-sampler';

// Control the tile pixels without canvas/bitmap machinery: the sampler only
// reads `img.data` off fetchTileRgba's result.
jest.mock('./tile-client', () => ({
  ...jest.requireActual('./tile-client'),
  fetchTileRgba: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tileClient = require('./tile-client');

/** A fake tile of n pixels, all with the given [r,g,b] (alpha 255). */
function tile(n: number, [r, g, b]: [number, number, number]) {
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  return { data, width: n, height: 1 };
}

describe('HistogramSampler', () => {
  let host: HistogramSamplerHost & { state: any };
  let sampler: HistogramSampler;
  let http: any;
  let onWindow: jest.Mock;
  let onSampled: jest.Mock;

  // One 64x64 single-tile level (small grid → full-res sampling).
  const DESC = { width: 64, height: 64, tileSize: 64, channels: 2, levels: [{ width: 64, height: 64 }] };

  beforeEach(() => {
    (tileClient.fetchTileRgba as jest.Mock).mockReset();
    onWindow = jest.fn();
    onSampled = jest.fn();
    const state = { gray: true, realLevels: 1, channelCount: 2 };
    host = {
      state,
      realLevels: () => state.realLevels,
      channelCount: () => state.channelCount,
      isGrayscale: () => state.gray,
      onChannelHistogramsSampled: onSampled,
      onGrayWindowSampled: onWindow,
    };
    http = { get: jest.fn() };
    sampler = new HistogramSampler(http, 'api/', host);
  });

  it('returns null before any sampling resolves', () => {
    expect(sampler.get(0, 0)).toBeNull();
  });

  // ── computeImageWindow (grayscale) ────────────────────────────────────
  it('bins a grayscale tile and reports the measured auto-window', async () => {
    (tileClient.fetchTileRgba as jest.Mock).mockResolvedValue(tile(4, [30, 30, 30]));
    await sampler.computeImageWindow(DESC, 'B64', 0);

    const h = sampler.get(0, 0)!;
    expect(h.counts[30]).toBe(4);
    // min === max → no usable window; only a real span triggers the seed.
    expect(onWindow).not.toHaveBeenCalled();
  });

  it('reports min/max to the host when the full-res samples have a real span', async () => {
    (tileClient.fetchTileRgba as jest.Mock)
      .mockResolvedValueOnce(tile(2, [5, 5, 5]))
      .mockResolvedValue(tile(2, [40, 40, 40]));
    const twoTiles = { ...DESC, width: 128, levels: [{ width: 128, height: 64 }] }; // 2-tile grid
    await sampler.computeImageWindow(twoTiles, 'B64', 0);
    expect(onWindow).toHaveBeenCalledWith(5, 40);
  });

  it('samples R/G/B histograms (no window) for RGB images', async () => {
    host.state.gray = false;
    (tileClient.fetchTileRgba as jest.Mock).mockResolvedValue(tile(3, [10, 20, 30]));
    await sampler.computeImageWindow(DESC, 'B64', 0);

    expect(sampler.get(0, 0)!.counts[10]).toBe(3); // R
    expect(sampler.get(0, 1)!.counts[20]).toBe(3); // G
    expect(sampler.get(0, 2)!.counts[30]).toBe(3); // B
    expect(onWindow).not.toHaveBeenCalled();
  });

  it('survives per-tile fetch failures (histogram just loses those samples)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (tileClient.fetchTileRgba as jest.Mock).mockRejectedValue(new Error('504'));
    await sampler.computeImageWindow(DESC, 'B64', 0);
    expect(sampler.get(0, 0)).not.toBeNull(); // empty but present
    warn.mockRestore();
  });

  // ── computeMultiChannelHistograms ─────────────────────────────────────
  it('bins one histogram per channel from per-channel tiles and nudges the pane', async () => {
    (tileClient.fetchTileRgba as jest.Mock).mockImplementation((_http: any, url: string) =>
      Promise.resolve(tile(2, url.includes('channel=0') ? [15, 15, 15] : [240, 240, 240])));
    await sampler.computeMultiChannelHistograms(DESC, 'B64', 3);

    expect(sampler.get(3, 0)!.counts[15]).toBe(2);
    expect(sampler.get(3, 1)!.counts[240]).toBe(2);
    expect(onSampled).toHaveBeenCalled();
  });

  it('gives up when even the coarsest real level is too many tiles', async () => {
    const huge = { ...DESC, width: 10_000, height: 10_000, levels: [{ width: 10_000, height: 10_000 }] };
    await sampler.computeMultiChannelHistograms(huge, 'B64', 0);
    expect(tileClient.fetchTileRgba).not.toHaveBeenCalled();
    expect(sampler.get(0, 0)).toBeNull();
  });

  // ── native histogram fetch ────────────────────────────────────────────
  const NATIVE = {
    bitDepth: 16, rangeMin: 96, rangeMax: 150, observedMin: 96, observedMax: 150,
    binWidth: 0.215, counts: [4, 0, 8],
  };

  it('maps the server HistogramInfo to native bins and caches per slice+channel', async () => {
    http.get.mockReturnValue(of(NATIVE));
    const h = (await firstValueFrom(sampler.native$('B64', 0, 1, 256)))!;
    expect(h.bitDepth).toBe(16);
    expect(h.bins[0]).toBe(96);
    expect(h.bins[2]).toBeCloseTo(96 + 2 * 0.215);
    expect(h.max).toBe(8);
    expect(http.get.mock.calls[0][0]).toContain('histogram?info=B64&channel=1&z=0&bins=256');

    // Cached: a second subscription must not refetch.
    await firstValueFrom(sampler.native$('B64', 0, 1, 256));
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  it('returns null (pane retries) when the native fetch fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    http.get.mockReturnValue(throwError(() => new Error('202')));
    await expect(firstValueFrom(sampler.native$('B64', 0, 0, 256))).resolves.toBeNull();
    warn.mockRestore();
  });

  it('clear() drops both caches', async () => {
    http.get.mockReturnValue(of(NATIVE));
    await firstValueFrom(sampler.native$('B64', 0, 0, 256));
    (tileClient.fetchTileRgba as jest.Mock).mockResolvedValue(tile(1, [9, 9, 9]));
    await sampler.computeImageWindow(DESC, 'B64', 0);

    sampler.clear();
    expect(sampler.get(0, 0)).toBeNull();
    await firstValueFrom(sampler.native$('B64', 0, 0, 256));
    expect(http.get).toHaveBeenCalledTimes(2); // refetched after clear
  });
});
