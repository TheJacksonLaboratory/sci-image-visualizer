import { DisplayPipeline, DisplayPipelineHost } from './display-pipeline';
import { IChannelState } from '../../contracts/channel-histogram-api.contract';
import { Rgb } from '../../contracts/colormap-lut';

/**
 * Unit tests for the display pipeline (refactoring plan, Step 4) — the
 * windowing/gamma/invert/tint math behind tile recoloring and the composite
 * export, on small RGBA fixtures.
 */

function ch(partial: Partial<IChannelState> = {}): IChannelState {
  return { index: 0, name: 'c', color: '#ffffff', min: 0, max: 255, gamma: 1, visible: true, ...partial };
}

/** Identity grayscale LUT: value v → [v, v, v]. */
const IDENTITY_LUT: Rgb[] = Array.from({ length: 256 }, (_, i) => [i, i, i] as Rgb);

/** One RGBA pixel buffer from [r, g, b] triples (alpha 255). */
function rgba(...pixels: Array<[number, number, number]>): Uint8ClampedArray {
  const d = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b], i) => {
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  });
  return d;
}

function makePipeline(state: {
  gray?: boolean; lut?: Rgb[] | null; channels?: IChannelState[]; invert?: boolean;
}): { pipe: DisplayPipeline; state: any } {
  const st = { gray: true, lut: IDENTITY_LUT, channels: [ch()], invert: false, ...state };
  const host: DisplayPipelineHost = {
    isGrayscale: () => st.gray,
    colorLut: () => st.lut,
    channelStates: () => st.channels,
    invertBg: () => st.invert,
  };
  return { pipe: new DisplayPipeline(host), state: st };
}

describe('DisplayPipeline', () => {
  // ── grayscale path ────────────────────────────────────────────────────
  it('is a no-op (returns false) when no colormap LUT is built yet', () => {
    const { pipe } = makePipeline({ lut: null });
    const d = rgba([10, 10, 10]);
    expect(pipe.applyToRgba(d)).toBe(false);
    expect([d[0], d[1], d[2]]).toEqual([10, 10, 10]);
  });

  it('full-range window + gamma 1 + identity LUT is the identity', () => {
    const { pipe } = makePipeline({});
    const d = rgba([0, 0, 0], [128, 128, 128], [255, 255, 255]);
    expect(pipe.applyToRgba(d)).toBe(true);
    expect([d[0], d[4], d[8]]).toEqual([0, 128, 255]);
  });

  it('windows [100..200] onto the full output range (endpoints + midpoint)', () => {
    const { pipe } = makePipeline({ channels: [ch({ min: 100, max: 200 })] });
    const d = rgba([100, 100, 100], [150, 150, 150], [200, 200, 200], [50, 50, 50], [250, 250, 250]);
    pipe.applyToRgba(d);
    expect(d[0]).toBe(0);    // window min → black
    expect(d[4]).toBe(128);  // midpoint → round(0.5 * 255)
    expect(d[8]).toBe(255);  // window max → white
    expect(d[12]).toBe(0);   // below window clamps
    expect(d[16]).toBe(255); // above window clamps
  });

  it('applies gamma through the transfer curve (γ=2 brightens midtones)', () => {
    const { pipe } = makePipeline({ channels: [ch({ gamma: 2 })] });
    const d = rgba([128, 128, 128]);
    pipe.applyToRgba(d);
    // t = (128/255)^(1/2) ≈ 0.7086 → round(180.7) = 181
    expect(d[0]).toBe(181);
  });

  it('invert flips the display value before the LUT', () => {
    const { pipe } = makePipeline({ invert: true });
    const d = rgba([0, 0, 0], [255, 255, 255]);
    pipe.applyToRgba(d);
    expect(d[0]).toBe(255);
    expect(d[4]).toBe(0);
  });

  it('skips fully transparent pixels', () => {
    const { pipe } = makePipeline({ invert: true });
    const d = rgba([10, 10, 10]);
    d[3] = 0; // transparent
    expect(pipe.applyToRgba(d)).toBe(false);
    expect(d[0]).toBe(10); // untouched
  });

  // ── RGB / multichannel additive path ──────────────────────────────────
  const RGB_DEFAULTS = [
    ch({ index: 0, color: '#ff0000' }),
    ch({ index: 1, color: '#00ff00' }),
    ch({ index: 2, color: '#0000ff' }),
  ];

  it('default R/G/B tints are the identity for an RGB image', () => {
    const { pipe } = makePipeline({ gray: false, channels: RGB_DEFAULTS });
    const d = rgba([10, 130, 250]);
    pipe.applyToRgba(d);
    expect([d[0], d[1], d[2]]).toEqual([10, 130, 250]);
  });

  it('hiding a channel removes its contribution', () => {
    const { pipe } = makePipeline({
      gray: false,
      channels: [ch({ color: '#ff0000', visible: false }), RGB_DEFAULTS[1], RGB_DEFAULTS[2]],
    });
    const d = rgba([200, 130, 250]);
    pipe.applyToRgba(d);
    expect([d[0], d[1], d[2]]).toEqual([0, 130, 250]);
  });

  it('re-tinting merges additively and clamps at 255 (Fiji merge)', () => {
    // Both channels tinted white → each contributes its intensity to R, G and B.
    const { pipe } = makePipeline({
      gray: false,
      channels: [ch({ color: '#ffffff' }), ch({ index: 1, color: '#ffffff' }), ch({ index: 2, color: '#0000ff', visible: false })],
    });
    const d = rgba([200, 100, 0]);
    pipe.applyToRgba(d);
    // R, G and B each receive 200 + 100 = 300 → clamped to 255.
    expect([d[0], d[1], d[2]]).toEqual([255, 255, 255]);
  });

  // ── rgbNeedsRecolor gate ──────────────────────────────────────────────
  it('rgbNeedsRecolor is false at the R/G/B defaults (tile passthrough)', () => {
    const { pipe } = makePipeline({ gray: false, channels: RGB_DEFAULTS });
    expect(pipe.rgbNeedsRecolor()).toBe(false);
  });

  it.each([
    ['invert', { invert: true, channels: RGB_DEFAULTS }],
    ['hidden channel', { channels: [ch({ color: '#ff0000', visible: false }), RGB_DEFAULTS[1], RGB_DEFAULTS[2]] }],
    ['windowed channel', { channels: [ch({ color: '#ff0000', max: 200 }), RGB_DEFAULTS[1], RGB_DEFAULTS[2]] }],
    ['gamma', { channels: [ch({ color: '#ff0000', gamma: 2 }), RGB_DEFAULTS[1], RGB_DEFAULTS[2]] }],
    ['re-tint', { channels: [ch({ color: '#00ffff' }), RGB_DEFAULTS[1], RGB_DEFAULTS[2]] }],
  ])('rgbNeedsRecolor is true with %s', (_label, state) => {
    const { pipe } = makePipeline({ gray: false, ...(state as any) });
    expect(pipe.rgbNeedsRecolor()).toBe(true);
  });

  // ── channelRgbLut (per-channel tile tint tables) ──────────────────────
  it('channelRgbLut bakes window + tint into 256-entry tables', () => {
    const { pipe } = makePipeline({});
    const { r, g, b } = pipe.channelRgbLut(ch({ min: 0, max: 255, color: '#00ffff' })); // cyan
    expect(r[255]).toBe(0);   // no red in cyan
    expect(g[255]).toBe(255);
    expect(b[255]).toBe(255);
    expect(g[128]).toBe(128); // linear mid
  });

  it('channelIntensity returns 0 for an empty window span', () => {
    const { pipe } = makePipeline({});
    expect(pipe.channelIntensity(100, ch({ min: 50, max: 50 }))).toBe(0);
  });
});
