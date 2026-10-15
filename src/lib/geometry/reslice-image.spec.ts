import { colormapFromLut, reverseColormap, tintColormap } from 'napari-js';

import { VolumeVoxels, resliceImage } from './reslice-image';

/** A 4 × 3 × 2 volume whose voxel (x, y, z) is 10·x + 50·y + 100·z. */
function volume(channels: Partial<VolumeVoxels['channels'][number]>[] = [{}]): VolumeVoxels {
  const data = new Uint8Array(4 * 3 * 2);
  for (let z = 0; z < 2; z++)
    for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) data[x + 4 * (y + 3 * z)] = 10 * x + 50 * y + 100 * z;
  return {
    width: 4,
    height: 3,
    depth: 2,
    invert: false,
    channels: channels.map((c) => ({
      data,
      colormap: tintColormap('#ffffff'),
      min: 0,
      max: 255,
      gamma: 1,
      visible: true,
      ...c,
    })),
  };
}

const red = (img: { data: Uint8ClampedArray }) => Array.from(img.data.filter((_, i) => i % 4 === 0));

describe('resliceImage', () => {
  it('cuts through x: slices across, y down', () => {
    const img = resliceImage(volume(), 'x', 1);
    expect([img.width, img.height]).toEqual([2, 3]);
    // Row y, column z: 10 + 50y + 100z.
    expect(red(img)).toEqual([10, 110, 60, 160, 110, 210]);
    expect(img.data[3]).toBe(255);
  });

  it('cuts through y: x across, slices down; clamps the plane into the volume', () => {
    const img = resliceImage(volume(), 'y', 9);
    expect([img.width, img.height]).toEqual([4, 2]);
    expect(red(img)).toEqual([100, 110, 120, 130, 200, 210, 220, 230]); // y = 2
  });

  it('windows, inverts and tints each channel, adding the visible ones', () => {
    const vol = volume([
      { colormap: tintColormap('#ff0000'), min: 100, max: 200 },
      { colormap: tintColormap('#00ff00'), visible: false },
    ]);
    const img = resliceImage(vol, 'x', 0);
    // Column z, row y: 0, 100 | 50, 150 | 100, 200, windowed over 100..200.
    expect(red(img)).toEqual([0, 0, 0, 128, 0, 255]);
    expect(Array.from(img.data.filter((_, i) => i % 4 === 1))).toEqual([0, 0, 0, 0, 0, 0]);
    const inverted = resliceImage({ ...vol, invert: true }, 'x', 0);
    expect(red(inverted)[0]).toBe(255);
  });

  it("colours each channel through its colormap's LUT, as the 3D view does (reversed, gamma)", () => {
    // Red falls as the value rises; green is the value.
    const ramp = colormapFromLut(
      'down',
      Array.from({ length: 256 }, (_, i) => [255 - i, i, 0] as [number, number, number]),
    );
    const img = resliceImage(volume([{ colormap: ramp, min: 100, max: 200 }]), 'x', 0);
    expect(red(img)).toEqual([255, 255, 255, 127, 255, 0]);
    expect(Array.from(img.data.filter((_, i) => i % 4 === 2))).toEqual([0, 0, 0, 0, 0, 0]);
    // Reverse-scale flips the ramp; napari gamma 2 shows the window's middle at a quarter.
    const reversed = resliceImage(volume([{ colormap: reverseColormap(tintColormap('#ffffff')) }]), 'x', 0);
    expect(red(reversed)[0]).toBe(255);
    const gamma = resliceImage(volume([{ min: 100, max: 200, gamma: 2 }]), 'x', 0);
    expect(red(gamma)[3]).toBe(64);
  });
});
