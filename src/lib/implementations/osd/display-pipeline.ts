import { IChannelState } from '../../contracts/channel-histogram-api.contract';
import { Rgb } from '../../contracts/colormap-lut';
import { parseCssColor } from '../../contracts/color';

/**
 * The OSD pixel display pipeline (refactoring plan, Step 4 — a pure move of
 * the recolor math out of the visualizer service). Stateless: every call reads
 * the current display state through the host closures, exactly like the moved
 * code read the service's fields. Shared by tile recoloring, the serverless
 * multichannel compositor and the composite export so they stay identical.
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
   *  - Grayscale: intensity → window → invert → gamma → colormap LUT.
   *  - RGB/multichannel: additive pseudo-colour merge — each visible channel's
   *    intensity (window → invert → gamma, see {@link channelIntensity}) is
   *    tinted by its assigned colour and summed (Fiji "Merge Channels"), then
   *    clamped. Invert is per channel, before the merge, as napari-js inverts
   *    each additive layer (NAPARI-BOUNDARY-2) — not the composite. Defaults
   *    (R=red, G=green, B=blue) are the identity.
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
      // Precompute raw(0..255) -> final RGB once (256 window+invert+gamma+colormap
      // evaluations) and map each pixel by table lookup — a Math.pow per pixel
      // (~262k/tile) made the window/gamma sliders crawl on large stacks.
      // The order is napari-js's `windowGamma` (window → invert → gamma), so the
      // same channel state draws the same image under both backends; only the
      // exponent differs by convention (ImageJ t^(1/γ) here, converted to
      // napari's t^γ at the napari boundary).
      const rL = new Uint8ClampedArray(256);
      const gL = new Uint8ClampedArray(256);
      const bL = new Uint8ClampedArray(256);
      for (let raw = 0; raw < 256; raw++) {
        let t = (raw - wMin) / wSpan;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (invertBg) t = 1 - t;
        if (invGamma !== 1) t = Math.pow(t, invGamma);
        const c = lut[Math.round(t * 255)];
        rL[raw] = c[0];
        gL[raw] = c[1];
        bL[raw] = c[2];
      }
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        // maxRgb (contracts/intensity) inlined on purpose: this loop runs
        // ~262k times per tile on every recolor.
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
        let oR = 0,
          oG = 0,
          oB = 0;
        for (let k = 0; k < 3; k++) {
          const c = chans[k];
          if (c && !c.visible) continue;
          const v = this.channelIntensity(d[i + k], c, invertBg);
          const tint = tints[k];
          oR += v * tint[0];
          oG += v * tint[1];
          oB += v * tint[2];
        }
        if (oR > 255) oR = 255;
        if (oG > 255) oG = 255;
        if (oB > 255) oB = 255;
        d[i] = oR;
        d[i + 1] = oG;
        d[i + 2] = oB;
        changed = true;
      }
    }
    return changed;
  }

  /** Precomputed lum(0..255) → tinted-RGB lookup for a channel's window/invert/
   *  gamma/colour. Building it costs 256 channelIntensity() calls; using it makes a
   *  full-tile recolor ~262k array lookups instead of ~262k Math.pow() calls. */
  channelRgbLut(st?: IChannelState): { r: Uint8ClampedArray; g: Uint8ClampedArray; b: Uint8ClampedArray } {
    const r = new Uint8ClampedArray(256);
    const g = new Uint8ClampedArray(256);
    const b = new Uint8ClampedArray(256);
    const [tr, tg, tb] = this.tint01(st);
    const invert = this.host.invertBg();
    for (let lum = 0; lum < 256; lum++) {
      const v = this.channelIntensity(lum, st, invert);
      r[lum] = v * tr;
      g[lum] = v * tg;
      b[lum] = v * tb;
    }
    return { r, g, b };
  }

  /**
   * Additive ('lighter') merge of single-band channel planes into one opaque
   * RGBA image — what OSD's drawer shows for a per-channel image, where each
   * channel tile is tinted by {@link channelRgbLut}. Hidden channels, missing
   * planes and planes of another size contribute nothing. Used by the
   * serverless multichannel compositor and the multichannel composite export.
   */
  compositeChannels(
    planes: ReadonlyArray<Uint8ClampedArray | null | undefined>,
    states: ReadonlyArray<IChannelState | undefined>,
  ): Uint8ClampedArray {
    const len = planes.find((p) => p && p.length)?.length ?? 0;
    const out = new Uint8ClampedArray(len);
    for (let c = 0; c < planes.length; c++) {
      const st = states[c];
      const pd = planes[c];
      if ((st && st.visible === false) || !pd || pd.length !== len) continue;
      this.addChannel(out, pd, st);
    }
    for (let i = 3; i < out.length; i += 4) out[i] = 255; // opaque
    return out;
  }

  /** Add one single-band plane, tinted by its channel state, onto `out`
   *  (Uint8ClampedArray clamps → additive 'lighter'). */
  addChannel(out: Uint8ClampedArray, plane: Uint8ClampedArray, st?: IChannelState): void {
    const { r, g, b } = this.channelRgbLut(st);
    for (let i = 0; i < out.length; i += 4) {
      if (plane[i + 3] === 0) continue;
      const lum = plane[i]; // single-band plane (R=G=B)
      out[i] += r[lum];
      out[i + 1] += g[lum];
      out[i + 2] += b[lum];
    }
  }

  /**
   * A channel's display intensity (0..255, before its tint): window → invert →
   * gamma, the order of napari-js's `windowGamma`, which every additive napari
   * layer applies on its own before the layers are summed (NAPARI-BOUNDARY-2).
   * The gamma exponent is the ImageJ one (t^(1/γ)). An empty window span maps to
   * 0 before the invert; with no channel state the value passes through.
   */
  channelIntensity(val: number, c?: IChannelState, invert = false): number {
    let t: number;
    if (!c) {
      t = val / 255;
    } else {
      const span = c.max > c.min ? c.max - c.min : 0;
      t = span ? (val - c.min) / span : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    if (invert) t = 1 - t;
    if (c && c.gamma > 0 && c.gamma !== 1) t = Math.pow(t, 1 / c.gamma);
    return t * 255;
  }

  /** A channel's pseudo-colour tint as [r,g,b] in 0..1 (default white). */
  tint01(c?: IChannelState): [number, number, number] {
    const rgb = parseCssColor(c?.color);
    return rgb ? [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255] : [1, 1, 1];
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
        c &&
        (!c.visible ||
          c.min !== 0 ||
          c.max !== 255 ||
          c.gamma !== 1 ||
          (c.color || '').toLowerCase() !== defaults[k])
      ) {
        return true;
      }
    }
    return false;
  }
}
