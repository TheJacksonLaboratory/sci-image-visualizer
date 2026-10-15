/**
 * An image of a plane through a volume (the X or Y section beside the 3D view), cut from the
 * volume's voxels and displayed the way the 2D view displays a slice: each channel windowed,
 * inverted, gamma-corrected (napari-js's order) and tinted, the channels added.
 *
 * Pure: usable from workers.
 */
import type { SectionAxis } from './section';

/** One channel of a volume as it is displayed. */
export interface VolumeChannelVoxels {
  /** uint8 voxels, x fastest, then y, then z. */
  data: Uint8Array;
  /** Tint, `#rrggbb` (white: grayscale). */
  color: string;
  /** The colours the displayed value 0..255 maps to (256 RGB, 0..255 each), in place of the tint. */
  ramp?: ReadonlyArray<readonly [number, number, number]>;
  /** Display window over 0..255. */
  min: number;
  max: number;
  /** ImageJ gamma: the windowed value t shows as t^(1/γ). */
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
  const [r, g, b] = rgbOf(ch.color);
  const ramp = ch.ramp?.length === 256 ? ch.ramp : null;
  const span = ch.max - ch.min;
  const invGamma = ch.gamma > 0 ? 1 / ch.gamma : 1;
  const lut = new Float32Array(256 * 3);
  for (let v = 0; v < 256; v++) {
    let t = span > 0 ? Math.min(1, Math.max(0, (v - ch.min) / span)) : 0;
    if (invert) t = 1 - t;
    t = Math.pow(t, invGamma) * 255;
    if (ramp) {
      const [cr, cg, cb] = ramp[Math.round(t)];
      lut[3 * v] = cr;
      lut[3 * v + 1] = cg;
      lut[3 * v + 2] = cb;
      continue;
    }
    lut[3 * v] = t * r;
    lut[3 * v + 1] = t * g;
    lut[3 * v + 2] = t * b;
  }
  return lut;
}

/** `#rrggbb` → [0..1] × 3; white for anything else. */
function rgbOf(color: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
