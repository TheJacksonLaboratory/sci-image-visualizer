/**
 * Colormap → RGB lookup-table builder.
 *
 * Lets a non-Plotly backend (OpenSeadragon) recolor grayscale pixels with the
 * exact same colormaps the Plotly heatmap uses. The input is a colormap value
 * straight from `COLORMAP_OPTIONS` (see plot.utilities) — the same value handed
 * to Plotly's `colorscale` — so the two surfaces stay in lock-step.
 *
 * A colormap value is either:
 *   - an array of `[stop, color]` pairs (the matplotlib tables, see {@link lutScale}), or
 *   - a Plotly built-in scale *name* string (e.g. 'Viridis', 'Reds'), or
 *   - a 256-entry RGB table itself (a `napari-js/colormaps` `*_LUT`), used as is.
 * `color` may be `'rgb(r, g, b)'` or `'#rrggbb'`/`'#rgb'`.
 */

import { Colormap, buildLut } from 'napari-js';

import { Rgb, parseCssColor } from './color';

export type { Rgb };
type Stop = [number, string];

/**
 * Plotly's built-in named colorscales (copied verbatim from plotly.js
 * `components/colorscale/scales.js`), for the `COLORMAP_OPTIONS` entries whose
 * `value` is a name string rather than an inline LUT array.
 */
const BUILTIN_SCALES: Record<string, Stop[]> = {
  Greys: [
    [0, 'rgb(0,0,0)'],
    [1, 'rgb(255,255,255)'],
  ],
  YlGnBu: [
    [0, 'rgb(8,29,88)'],
    [0.125, 'rgb(37,52,148)'],
    [0.25, 'rgb(34,94,168)'],
    [0.375, 'rgb(29,145,192)'],
    [0.5, 'rgb(65,182,196)'],
    [0.625, 'rgb(127,205,187)'],
    [0.75, 'rgb(199,233,180)'],
    [0.875, 'rgb(237,248,217)'],
    [1, 'rgb(255,255,217)'],
  ],
  Greens: [
    [0, 'rgb(0,68,27)'],
    [0.125, 'rgb(0,109,44)'],
    [0.25, 'rgb(35,139,69)'],
    [0.375, 'rgb(65,171,93)'],
    [0.5, 'rgb(116,196,118)'],
    [0.625, 'rgb(161,217,155)'],
    [0.75, 'rgb(199,233,192)'],
    [0.875, 'rgb(229,245,224)'],
    [1, 'rgb(247,252,245)'],
  ],
  YlOrRd: [
    [0, 'rgb(128,0,38)'],
    [0.125, 'rgb(189,0,38)'],
    [0.25, 'rgb(227,26,28)'],
    [0.375, 'rgb(252,78,42)'],
    [0.5, 'rgb(253,141,60)'],
    [0.625, 'rgb(254,178,76)'],
    [0.75, 'rgb(254,217,118)'],
    [0.875, 'rgb(255,237,160)'],
    [1, 'rgb(255,255,204)'],
  ],
  Bluered: [
    [0, 'rgb(0,0,255)'],
    [1, 'rgb(255,0,0)'],
  ],
  RdBu: [
    [0, 'rgb(5,10,172)'],
    [0.35, 'rgb(106,137,247)'],
    [0.5, 'rgb(190,190,190)'],
    [0.6, 'rgb(220,170,132)'],
    [0.7, 'rgb(230,145,90)'],
    [1, 'rgb(178,10,28)'],
  ],
  Reds: [
    [0, 'rgb(220,220,220)'],
    [0.2, 'rgb(245,195,157)'],
    [0.4, 'rgb(245,160,105)'],
    [1, 'rgb(178,10,28)'],
  ],
  Blues: [
    [0, 'rgb(5,10,172)'],
    [0.35, 'rgb(40,60,190)'],
    [0.5, 'rgb(70,100,245)'],
    [0.6, 'rgb(90,120,245)'],
    [0.7, 'rgb(106,137,247)'],
    [1, 'rgb(220,220,220)'],
  ],
  Picnic: [
    [0, 'rgb(0,0,255)'],
    [0.1, 'rgb(51,153,255)'],
    [0.2, 'rgb(102,204,255)'],
    [0.3, 'rgb(153,204,255)'],
    [0.4, 'rgb(204,204,255)'],
    [0.5, 'rgb(255,255,255)'],
    [0.6, 'rgb(255,204,255)'],
    [0.7, 'rgb(255,153,255)'],
    [0.8, 'rgb(255,102,204)'],
    [0.9, 'rgb(255,102,102)'],
    [1, 'rgb(255,0,0)'],
  ],
  Rainbow: [
    [0, 'rgb(150,0,90)'],
    [0.125, 'rgb(0,0,200)'],
    [0.25, 'rgb(0,25,255)'],
    [0.375, 'rgb(0,152,255)'],
    [0.5, 'rgb(44,255,150)'],
    [0.625, 'rgb(151,255,0)'],
    [0.75, 'rgb(255,234,0)'],
    [0.875, 'rgb(255,111,0)'],
    [1, 'rgb(255,0,0)'],
  ],
  Portland: [
    [0, 'rgb(12,51,131)'],
    [0.25, 'rgb(10,136,186)'],
    [0.5, 'rgb(242,211,56)'],
    [0.75, 'rgb(242,143,56)'],
    [1, 'rgb(217,30,30)'],
  ],
  Jet: [
    [0, 'rgb(0,0,131)'],
    [0.125, 'rgb(0,60,170)'],
    [0.375, 'rgb(5,255,255)'],
    [0.625, 'rgb(255,255,0)'],
    [0.875, 'rgb(250,0,0)'],
    [1, 'rgb(128,0,0)'],
  ],
  Hot: [
    [0, 'rgb(0,0,0)'],
    [0.3, 'rgb(230,0,0)'],
    [0.6, 'rgb(255,210,0)'],
    [1, 'rgb(255,255,255)'],
  ],
  Blackbody: [
    [0, 'rgb(0,0,0)'],
    [0.2, 'rgb(230,0,0)'],
    [0.4, 'rgb(230,210,0)'],
    [0.7, 'rgb(255,255,255)'],
    [1, 'rgb(160,200,255)'],
  ],
  Earth: [
    [0, 'rgb(0,0,130)'],
    [0.1, 'rgb(0,180,180)'],
    [0.2, 'rgb(40,210,40)'],
    [0.4, 'rgb(230,230,50)'],
    [0.6, 'rgb(120,70,20)'],
    [1, 'rgb(255,255,255)'],
  ],
  Electric: [
    [0, 'rgb(0,0,0)'],
    [0.15, 'rgb(30,0,100)'],
    [0.4, 'rgb(120,0,100)'],
    [0.6, 'rgb(160,90,0)'],
    [0.8, 'rgb(230,200,0)'],
    [1, 'rgb(255,250,220)'],
  ],
  Viridis: [
    [0, '#440154'],
    [0.06274509803921569, '#48186a'],
    [0.12549019607843137, '#472d7b'],
    [0.18823529411764706, '#424086'],
    [0.25098039215686274, '#3b528b'],
    [0.3137254901960784, '#33638d'],
    [0.3764705882352941, '#2c728e'],
    [0.4392156862745098, '#26828e'],
    [0.5019607843137255, '#21918c'],
    [0.5647058823529412, '#1fa088'],
    [0.6274509803921569, '#28ae80'],
    [0.6901960784313725, '#3fbc73'],
    [0.7529411764705882, '#5ec962'],
    [0.8156862745098039, '#84d44b'],
    [0.8784313725490196, '#addc30'],
    [0.9411764705882353, '#d8e219'],
    [1, '#fde725'],
  ],
  Cividis: [
    [0, 'rgb(0,32,76)'],
    [0.058824, 'rgb(0,42,102)'],
    [0.117647, 'rgb(0,52,110)'],
    [0.176471, 'rgb(39,63,108)'],
    [0.235294, 'rgb(60,74,107)'],
    [0.294118, 'rgb(76,85,107)'],
    [0.352941, 'rgb(91,95,109)'],
    [0.411765, 'rgb(104,106,112)'],
    [0.470588, 'rgb(117,117,117)'],
    [0.529412, 'rgb(131,129,120)'],
    [0.588235, 'rgb(146,140,120)'],
    [0.647059, 'rgb(161,152,118)'],
    [0.705882, 'rgb(176,165,114)'],
    [0.764706, 'rgb(192,177,109)'],
    [0.823529, 'rgb(209,191,102)'],
    [0.882353, 'rgb(225,204,92)'],
    [0.941176, 'rgb(243,219,79)'],
    [1, 'rgb(255,233,69)'],
  ],
};

/**
 * A 256-entry RGB table (a `napari-js/colormaps` `*_LUT`, `Uint8Array(768)`) as an inline
 * Plotly colorscale: one `[i / 255, 'rgb(r, g, b)']` stop per entry, the shape the colormap
 * tree hands to Plotly's `colorscale` and to {@link buildColormapLut}. Stops are rounded to
 * six decimals, as the colormap asset this replaces carried them.
 */
export function lutScale(lut: ArrayLike<number>): Stop[] {
  const n = Math.floor(lut.length / 3);
  const scale: Stop[] = new Array(n);
  for (let i = 0; i < n; i++) {
    scale[i] = [Number((i / (n - 1)).toFixed(6)), `rgb(${lut[i * 3]}, ${lut[i * 3 + 1]}, ${lut[i * 3 + 2]})`];
  }
  return scale;
}

/** Parse a Plotly colorscale color (`rgb(r,g,b)` or `#rrggbb`/`#rgb`) to RGB; black when unparseable. */
function parseColor(c: string): Rgb {
  return parseCssColor(c) ?? [0, 0, 0];
}

/**
 * Build a 256-entry RGB lookup table from a `COLORMAP_OPTIONS` value, indexed by
 * grayscale value 0–255. Returns null if the value can't be resolved to a scale.
 *
 * The Plotly side (the value's forms, the colour strings, the built-in names) is
 * parsed here; the interpolation is napari-js's own `Colormap` sampled by `buildLut`,
 * so both backends ramp a scale the same way.
 * @param value  array of `[stop, color]` pairs, a Plotly built-in name string, or a
 *   256-entry RGB `Uint8Array(768)`
 * @param reverse  mirror the scale (matches Plotly's `reversescale`)
 */
export function buildColormapLut(value: unknown, reverse = false): Rgb[] | null {
  if (value instanceof Uint8Array && value.length === 768) {
    const lut: Rgb[] = new Array(256);
    for (let i = 0; i < 256; i++) lut[i] = [value[i * 3], value[i * 3 + 1], value[i * 3 + 2]];
    if (reverse) lut.reverse();
    return lut;
  }
  let scale: Stop[] | null = null;
  if (Array.isArray(value)) scale = value as Stop[];
  else if (typeof value === 'string') scale = BUILTIN_SCALES[value] ?? null;
  if (!scale || scale.length < 2) return null;

  const colormap = new Colormap(
    'plotly-scale',
    scale.map((s) => {
      const [r, g, b] = parseColor(String(s[1]));
      return { t: Number(s[0]), color: [r / 255, g / 255, b / 255] };
    }),
  );
  const rgba = buildLut(colormap, 256);
  const lut: Rgb[] = new Array(256);
  for (let i = 0; i < 256; i++) lut[i] = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
  if (reverse) lut.reverse();
  return lut;
}
