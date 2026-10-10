import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import { DisplayPipeline } from './display-pipeline';
import { IChannelState } from '../../contracts/channel-histogram-api.contract';
import { Rgb } from '../../contracts/colormap-lut';

/**
 * Cross-backend check (review NAPARI-BOUNDARY-2): the OSD grayscale display pipeline must draw
 * what napari-js draws for the same channel state — window → invert → gamma, with the gamma
 * exponent converted at the napari boundary (ImageJ γ here = napari-js 1/γ).
 *
 * The reference is napari-js's OWN `windowGamma` (the CPU ground truth its shader is tested
 * against), not a copy: jest maps `napari-js` to a stub and cannot load the ESM bundle, so the
 * function is taken from the installed package's source map and transpiled here. A napari-js
 * upgrade that changes the math fails this spec.
 */
type WindowGamma = (value: number, lo: number, hi: number, gamma: number, invert: boolean) => number;

function napariWindowGamma(): WindowGamma {
  const map = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'node_modules/napari-js/dist/napari-js.js.map'), 'utf8'),
  ) as { sources: string[]; sourcesContent: string[] };
  const i = map.sources.findIndex((s) => s.endsWith('src/color/display-pipeline.ts'));
  if (i < 0) throw new Error('napari-js source map has no color/display-pipeline.ts');
  const js = ts.transpileModule(map.sourcesContent[i], {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  new Function('exports', 'module', 'require', js)(mod.exports, mod, () => ({}));
  return mod.exports['windowGamma'] as WindowGamma;
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
