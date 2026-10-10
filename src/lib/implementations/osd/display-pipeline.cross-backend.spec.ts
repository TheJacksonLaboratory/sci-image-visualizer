import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import { DisplayPipeline } from './display-pipeline';
import { IChannelState } from '../../contracts/channel-histogram-api.contract';
import { Rgb } from '../../contracts/colormap-lut';

/**
 * Cross-backend check (review NAPARI-BOUNDARY-2): the OSD display pipeline must draw what
 * napari-js draws for the same channel state — window → invert → gamma, with the gamma exponent
 * converted at the napari boundary (ImageJ γ here = napari-js 1/γ). For RGB / multichannel the
 * invert is per channel, before the additive merge (each napari layer inverts on its own).
 *
 * The reference is napari-js's OWN code (`windowGamma`, `mapScalar`, `additiveComposite` — the
 * CPU ground truth its shader is tested against — and `tintColormap`), not a copy: jest maps
 * `napari-js` to a stub and cannot load the ESM bundle, so the modules are taken from the
 * installed package's source map and transpiled here. A napari-js upgrade that changes the math
 * fails this spec.
 */
type WindowGamma = (value: number, lo: number, hi: number, gamma: number, invert: boolean) => number;
type RGB = [number, number, number];
interface NapariColormap {
  sample(t: number): RGB;
}
type MapScalar = (
  value: number,
  opts: { climLo: number; climHi: number; gamma: number; invert: boolean; colormap: NapariColormap },
) => RGB;

/** One napari-js source module (by its path suffix in the source map), transpiled to CommonJS.
 *  Only type-only imports are allowed: `require` resolves to nothing. */
function napariModule(suffix: string): Record<string, unknown> {
  const map = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'node_modules/napari-js/dist/napari-js.js.map'), 'utf8'),
  ) as { sources: string[]; sourcesContent: string[] };
  const i = map.sources.findIndex((s) => s.endsWith(suffix));
  if (i < 0) throw new Error(`napari-js source map has no ${suffix}`);
  const js = ts.transpileModule(map.sourcesContent[i], {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  new Function('exports', 'module', 'require', js)(mod.exports, mod, () => ({}));
  return mod.exports;
}

function napariWindowGamma(): WindowGamma {
  return napariModule('src/color/display-pipeline.ts')['windowGamma'] as WindowGamma;
}

const IDENTITY_LUT: Rgb[] = Array.from({ length: 256 }, (_, v) => [v, v, v] as Rgb);

/** OSD's grayscale output (identity LUT) for every raw byte 0..255. */
function osdGray(st: IChannelState, invert: boolean): number[] {
  const pipe = new DisplayPipeline({
    isGrayscale: () => true,
    colorLut: () => IDENTITY_LUT,
    channelStates: () => [st],
    invertBg: () => invert,
  });
  const d = new Uint8ClampedArray(256 * 4);
  for (let v = 0; v < 256; v++) d.set([v, v, v, 255], v * 4);
  pipe.applyToRgba(d);
  return Array.from({ length: 256 }, (_, v) => d[v * 4]);
}

describe('DisplayPipeline matches napari-js windowGamma (NAPARI-BOUNDARY-2)', () => {
  const windowGamma = napariWindowGamma();

  it.each([
    { gamma: 2, min: 0, max: 255, invert: false },
    { gamma: 2, min: 0, max: 255, invert: true },
    { gamma: 0.5, min: 30, max: 200, invert: true },
    { gamma: 1, min: 30, max: 200, invert: true },
    { gamma: 1.7, min: 10, max: 120, invert: false },
  ])('γ=$gamma window [$min, $max] invert=$invert', ({ gamma, min, max, invert }) => {
    const st: IChannelState = { index: 0, name: 'c', color: '#ffffff', min, max, gamma, visible: true };
    const napari = Array.from({ length: 256 }, (_, v) =>
      Math.round(windowGamma(v, min, max, 1 / gamma, invert) * 255),
    );
    expect(osdGray(st, invert)).toEqual(napari);
  });
});

/**
 * napari-js's multichannel composite of one pixel: one additive layer per visible channel —
 * `mapScalar` through the channel's black→tint ramp (`tintColormap`) with the layer's own
 * invert — summed and clamped by `additiveComposite`; as 0..255 bytes.
 */
function napariComposite(values: number[], states: IChannelState[], invert: boolean): number[] {
  const pipeline = napariModule('src/color/display-pipeline.ts');
  const mapScalar = pipeline['mapScalar'] as MapScalar;
  const additiveComposite = pipeline['additiveComposite'] as (colors: readonly RGB[]) => RGB;
  const tintColormap = napariModule('src/color/colormap.ts')['tintColormap'] as (hex: string) => NapariColormap;
  const layers = states
    .map((st, k) => ({ st, v: values[k] }))
    .filter(({ st }) => st.visible)
    .map(({ st, v }) =>
      mapScalar(v, {
        climLo: st.min,
        climHi: st.max,
        gamma: 1 / st.gamma, // toNapariGamma
        invert,
        colormap: tintColormap(st.color),
      }),
    );
  return additiveComposite(layers).map((c) => Math.round(c * 255));
}

function ch(index: number, color: string, partial: Partial<IChannelState> = {}): IChannelState {
  return { index, name: `c${index}`, color, min: 0, max: 255, gamma: 1, visible: true, ...partial };
}

/** Every component within 1 of the reference (byte rounding: OSD rounds each channel's tinted
 *  byte before the merge, napari-js rounds the merged float). */
function expectWithinOne(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((a, i) => expect(Math.abs(a - expected[i])).toBeLessThanOrEqual(1));
}

describe('RGB / multichannel: per-channel invert before the additive merge (NAPARI-BOUNDARY-2)', () => {
  const cases: Array<{ label: string; values: number[]; states: IChannelState[] }> = [
    {
      label: 'default R/G/B tints, γ=2',
      values: [64, 128, 192],
      states: [ch(0, '#ff0000', { gamma: 2 }), ch(1, '#00ff00', { gamma: 2 }), ch(2, '#0000ff', { gamma: 2 })],
    },
    {
      label: 'windowed, mixed γ, re-tinted',
      values: [40, 150, 220],
      states: [
        ch(0, '#ff00ff', { min: 20, max: 180, gamma: 0.6 }),
        ch(1, '#00ffff', { min: 50, max: 250, gamma: 1.8 }),
        ch(2, '#ffff00', { min: 0, max: 255, gamma: 1 }),
      ],
    },
    {
      label: 'overlapping white tints (saturating sum), one channel hidden',
      values: [200, 100, 30],
      states: [ch(0, '#ffffff'), ch(1, '#ffffff', { gamma: 1.5 }), ch(2, '#0000ff', { visible: false })],
    },
  ];

  /** OSD's RGB tile recolor (`applyToRgba`, non-grayscale) of one pixel. */
  function osdRgb(values: number[], states: IChannelState[], invert: boolean): number[] {
    const pipe = new DisplayPipeline({
      isGrayscale: () => false,
      colorLut: () => null,
      channelStates: () => states,
      invertBg: () => invert,
    });
    const d = new Uint8ClampedArray([values[0], values[1], values[2], 255]);
    pipe.applyToRgba(d);
    return [d[0], d[1], d[2]];
  }

  /** OSD's multichannel composite (`compositeChannels`, one single-band plane per channel —
   *  the same `channelRgbLut` math as the per-channel tile recolor and the export). */
  function osdMultichannel(values: number[], states: IChannelState[], invert: boolean): number[] {
    const pipe = new DisplayPipeline({
      isGrayscale: () => false,
      colorLut: () => null,
      channelStates: () => states,
      invertBg: () => invert,
    });
    const planes = values.map((v) => new Uint8ClampedArray([v, v, v, 255]));
    const out = pipe.compositeChannels(planes, states);
    return [out[0], out[1], out[2]];
  }

  describe.each([true, false])('invert=%s', (invert) => {
    it.each(cases)('RGB tile recolor: $label', ({ values, states }) => {
      expectWithinOne(osdRgb(values, states, invert), napariComposite(values, states, invert));
    });

    it.each(cases)('multichannel composite: $label', ({ values, states }) => {
      expectWithinOne(osdMultichannel(values, states, invert), napariComposite(values, states, invert));
    });
  });

  it('differs from inverting the whole composite (the old OSD order) once γ ≠ 1', () => {
    const { values, states } = cases[0];
    const plain = napariComposite(values, states, false);
    const wholeInvert = plain.map((c) => 255 - c);
    const perChannel = osdRgb(values, states, true);
    expect(perChannel).toEqual(napariComposite(values, states, true));
    expect(perChannel).not.toEqual(wholeInvert);
  });
});
