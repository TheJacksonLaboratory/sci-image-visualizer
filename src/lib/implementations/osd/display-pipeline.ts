import { IChannelState } from '../../contracts/channel-histogram-api.contract';
import { Rgb } from '../../contracts/colormap-lut';

/**
 * The OSD pixel display pipeline (refactoring plan, Step 4 — a pure move of
 * the recolor math out of the visualizer service). Stateless: every call reads
 * the current display state through the host closures, exactly like the moved
 * code read the service's fields. Shared by tile recoloring and the composite
 * export so they stay identical.
 */
export interface DisplayPipelineHost {
  /** Grayscale image (colormap LUT path) vs RGB/multichannel (additive tint). */
  isGrayscale(): boolean;
  /** 256-entry colormap LUT (grayscale path); null while options resolve. */
  colorLut(): Rgb[] | null;
  /** Latest per-channel display state from the store. */
  channelStates(): IChannelState[];
  /** Inverted background (white = zero). */
  invertBg(): boolean;
}

export class DisplayPipeline {
  constructor(private host: DisplayPipelineHost) {}

  /**
   * Apply the current display pipeline to an RGBA buffer in place; returns
   * whether any opaque pixel was written.
   *  - Grayscale: intensity → window + gamma + invert → colormap LUT.
   *  - RGB/multichannel: additive pseudo-colour merge — each visible channel's
   *    windowed intensity is tinted by its assigned colour and summed (Fiji
   *    "Merge Channels"). Defaults (R=red, G=green, B=blue) are the identity.
   */
  applyToRgba(d: Uint8ClampedArray): boolean {
    let changed = false;
    const channelStates = this.host.channelStates();
    const invertBg = this.host.invertBg();
    if (this.host.isGrayscale()) {
      const lut = this.host.colorLut();
      if (!lut) return false;
      const ch = channelStates[0];
      const wMin = ch ? ch.min : 0;
      const wSpan = ch && ch.max > ch.min ? ch.max - ch.min : 255;
      const invGamma = ch && ch.gamma > 0 ? 1 / ch.gamma : 1;
      // Precompute raw(0..255) -> final RGB once (256 window+gamma+invert+colormap
      // evaluations) and map each pixel by table lookup — a Math.pow per pixel
      // (~262k/tile) made the window/gamma sliders crawl on large stacks.
      const rL = new Uint8ClampedArray(256);
      const gL = new Uint8ClampedArray(256);
      const bL = new Uint8ClampedArray(256);
      for (let raw = 0; raw < 256; raw++) {
        let t = (raw - wMin) / wSpan;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (invGamma !== 1) t = Math.pow(t, invGamma);
        let v = Math.round(t * 255);
        if (invertBg) v = 255 - v;
        const c = lut[v];
        rL[raw] = c[0];
        gL[raw] = c[1];
        bL[raw] = c[2];
      }
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const raw =
          d[i] >= d[i + 1] ? (d[i] >= d[i + 2] ? d[i] : d[i + 2]) : d[i + 1] >= d[i + 2] ? d[i + 1] : d[i + 2];
        d[i] = rL[raw];
        d[i + 1] = gL[raw];
        d[i + 2] = bL[raw];
        changed = true;
      }
    } else {
      const chans = [channelStates[0], channelStates[1], channelStates[2]];
      const tints = chans.map((c) => this.tint01(c));
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        let oR = 0, oG = 0, oB = 0;
        for (let k = 0; k < 3; k++) {
          const c = chans[k];
          if (c && !c.visible) continue;
          const v = this.channelIntensity(d[i + k], c);
          const tint = tints[k];
          oR += v * tint[0];
          oG += v * tint[1];
          oB += v * tint[2];
        }
        if (oR > 255) oR = 255;
        if (oG > 255) oG = 255;
        if (oB > 255) oB = 255;
        if (invertBg) { oR = 255 - oR; oG = 255 - oG; oB = 255 - oB; }
        d[i] = oR;
        d[i + 1] = oG;
        d[i + 2] = oB;
        changed = true;
      }
    }
    return changed;
  }

  /** Precomputed lum(0..255) → tinted-RGB lookup for a channel's window/gamma/
   *  colour. Building it costs 256 channelIntensity() calls; using it makes a
   *  full-tile recolor ~262k array lookups instead of ~262k Math.pow() calls. */
  channelRgbLut(st?: IChannelState): { r: Uint8ClampedArray; g: Uint8ClampedArray; b: Uint8ClampedArray } {
    const r = new Uint8ClampedArray(256);
    const g = new Uint8ClampedArray(256);
    const b = new Uint8ClampedArray(256);
    const [tr, tg, tb] = this.tint01(st);
    for (let lum = 0; lum < 256; lum++) {
      const v = this.channelIntensity(lum, st);
      r[lum] = v * tr;
      g[lum] = v * tg;
      b[lum] = v * tb;
    }
    return { r, g, b };
  }

  /** Windowed + gamma intensity (0..255) for a channel, ignoring tint/invert. */
  channelIntensity(val: number, c?: IChannelState): number {
    if (!c) return val;
    const span = c.max > c.min ? c.max - c.min : 0;
    if (!span) return 0;
    let t = (val - c.min) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (c.gamma > 0 && c.gamma !== 1) t = Math.pow(t, 1 / c.gamma);
    return t * 255;
  }

  /** A channel's pseudo-colour tint as [r,g,b] in 0..1 (default white). */
  tint01(c?: IChannelState): [number, number, number] {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(c?.color ?? '');
    return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [1, 1, 1];
  }

  /** True when any RGB channel is windowed/hidden/gamma'd/re-tinted or the
   *  background is inverted — otherwise the tile passes through unchanged. */
  rgbNeedsRecolor(): boolean {
    if (this.host.invertBg()) return true;
    const defaults = ['#ff0000', '#00ff00', '#0000ff'];
    const channelStates = this.host.channelStates();
    for (let k = 0; k < 3; k++) {
      const c = channelStates[k];
      if (
        c && (!c.visible || c.min !== 0 || c.max !== 255 || c.gamma !== 1 ||
          (c.color || '').toLowerCase() !== defaults[k])
      ) {
        return true;
      }
    }
    return false;
  }
}
