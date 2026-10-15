/**
 * An image of a plane through a volume (the X or Y section beside the 3D view), cut from the
 * volume's voxels and displayed the way napari-js displays the volume: each channel windowed,
 * inverted and gamma-corrected (napari-js's `windowGamma`) and coloured by its colormap's LUT
 * (`buildLut`), the channels added (an additive composite, clamped).
 *
 * Pure: no DOM, no GPU.
 */
import { buildLut, windowGamma } from 'napari-js';
import type { Colormap } from 'napari-js';

import type { SectionAxis } from './section';

/** One channel of a volume as it is displayed. */
export interface VolumeChannelVoxels {
  /** uint8 voxels, x fastest, then y, then z. */
  data: Uint8Array;
  /** The colormap the 3D view draws the channel with (a tint, or the display colormap). */
  colormap: Colormap;
  /** Display window over 0..255. */
  min: number;
  max: number;
  /** napari-js gamma (see `toNapariGamma`): the windowed value t shows as t^γ. */
  gamma: number;
  visible: boolean;
}

export interface VolumeVoxels {
  width: number;
  height: number;
  depth: number;
  channels: readonly VolumeChannelVoxels[];
  invert: boolean;
}

/** An RGBA image, row by row. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * The image of the plane `axis = index` (a voxel index): through x, slices across and y down;
 * through y, x across and slices down — the section coordinates of `geometry/section`.
 */
export function resliceImage(vol: VolumeVoxels, axis: SectionAxis, index: number): RgbaImage {
  const { width: w, height: h, depth: d } = vol;
  const at = Math.min(Math.max(0, Math.round(index)), (axis === 'x' ? w : h) - 1);
  const outW = axis === 'x' ? d : w;
  const outH = axis === 'x' ? h : d;
  const rgb = new Float32Array(outW * outH * 3);
  for (const ch of vol.channels) {
    if (!ch.visible) continue;
    const lut = channelLut(ch, vol.invert);
    for (let row = 0; row < outH; row++) {
      for (let col = 0; col < outW; col++) {
        const voxel = axis === 'x' ? at + w * (row + h * col) : col + w * (at + h * row);
        const k = (row * outW + col) * 3;
        const v = ch.data[voxel] * 3;
        rgb[k] += lut[v];
        rgb[k + 1] += lut[v + 1];
        rgb[k + 2] += lut[v + 2];
      }
    }
  }
  const data = new Uint8ClampedArray(outW * outH * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    data[j] = rgb[i];
    data[j + 1] = rgb[i + 1];
    data[j + 2] = rgb[i + 2];
    data[j + 3] = 255;
  }
  return { width: outW, height: outH, data };
}

/** Voxel value (0..255) → displayed RGB (0..255 each), as 256 RGB triples. */
function channelLut(ch: VolumeChannelVoxels, invert: boolean): Float32Array {
  const colors = buildLut(ch.colormap); // RGBA8 × 256
  const last = colors.length / 4 - 1;
  const lut = new Float32Array(256 * 3);
  for (let v = 0; v < 256; v++) {
    const i = 4 * Math.round(windowGamma(v, ch.min, ch.max, ch.gamma, invert) * last);
    lut[3 * v] = colors[i];
    lut[3 * v + 1] = colors[i + 1];
    lut[3 * v + 2] = colors[i + 2];
  }
  return lut;
}
