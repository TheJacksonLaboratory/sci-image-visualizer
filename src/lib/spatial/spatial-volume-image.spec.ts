import {
  buildVolumeStackImage, observationsInSlice, sliceIndexOf, volumeImageRef,
} from './spatial-volume-image';
import { SpatialDataset } from '../contracts/spatial-dataset.contract';

/**
 * The volume-as-image encoder. What matters here is that a dataset's ONE volume
 * file becomes the `urls[z]` + `isStack` shape the existing stack machinery drives
 * — and that each URL holds the right plane, since a slicing error would show
 * plausible-looking anatomy from the wrong depth.
 */
describe('buildVolumeStackImage', () => {
  const dataset = (over: Partial<SpatialDataset> = {}): SpatialDataset => ({
    id: 'abc.wholebrain',
    name: 'Whole mouse brain MERFISH',
    observations: { count: 2, x: new Float32Array([0, 1]), y: new Float32Array([0, 1]) },
    columns: [],
    volume: { width: 2, height: 3, depth: 4, voxelSize: [40, 40, 200] },
    micronsPerUnit: 1,
    ...over,
  } as SpatialDataset);

  /** Voxel v at (x, y, z) = z * 100 + y * 10 + x, so a mis-sliced plane is obvious. */
  const voxels = (w: number, h: number, d: number) => {
    const out = new Uint8Array(w * h * d);
    for (let z = 0; z < d; z++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) out[(z * h + y) * w + x] = z * 100 + y * 10 + x;
      }
    }
    return out;
  };

  let planes: Uint8ClampedArray[];
  let createUrl: jest.SpyInstance;

  beforeEach(() => {
    planes = [];
    let n = 0;
    // test-setup installs `URL.createObjectURL` as a jest.fn, and spying on an
    // existing mock hands back that same mock — so its call history survives
    // restoreAllMocks and has to be cleared per test.
    createUrl = jest.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:slice-${n++}`);
    createUrl.mockClear();
    jest
      .spyOn(CanvasRenderingContext2D.prototype, 'putImageData')
      .mockImplementation(((data: ImageData) => {
        planes.push(new Uint8ClampedArray(data.data)); // copy: the encoder reuses one buffer
      }) as unknown as typeof CanvasRenderingContext2D.prototype.putImageData);
  });

  afterEach(() => jest.restoreAllMocks());

  it('emits one image per z plane, as a grayscale stack opened mid-volume', async () => {
    const built = await buildVolumeStackImage(dataset(), voxels(2, 3, 4));

    expect(built!.urls).toEqual(['blob:slice-0', 'blob:slice-1', 'blob:slice-2', 'blob:slice-3']);
    expect(built!.info.urls).toBe(built!.urls);
    expect(built!.info.isStack).toBe(true);
    expect(built!.info.isGrayscale).toBe(true);
    // Blob URLs are complete images — OSD must not look for a tile pyramid.
    expect(built!.info.tiled).toBe(false);
    expect(built!.info.trueImageSize).toEqual([2, 3]);
    expect(built!.info.imageMeta[0]).toMatchObject({ channelCount: 1, rgbChannels: 1, x: 2, y: 3, z: 4 });
    // Mid-volume, not slice 0: the end planes of an anatomical volume are outside
    // the specimen, and an empty frame reads as a failed load.
    expect(built!.info.initialZIndex).toBe(2);
  });

  it('writes each plane at its own depth, greyscale-replicated with full alpha', async () => {
    await buildVolumeStackImage(dataset(), voxels(2, 3, 4));

    expect(planes.length).toBe(4);
    // Plane 2, pixel (1, 2) = 2 * 100 + 2 * 10 + 1 = 221, at RGBA offset (2 * 2 + 1) * 4.
    const p2 = planes[2];
    const o = (2 * 2 + 1) * 4;
    expect([p2[o], p2[o + 1], p2[o + 2], p2[o + 3]]).toEqual([221, 221, 221, 255]);
    // First pixel of each plane carries that plane's own base value (the fixture's
    // 300 for z=3 wrapped when it was written into the uint8 volume).
    expect(planes.map((p) => p[0])).toEqual([0, 100, 200, 300 & 255]);
  });

  it('keys the image on the dataset id, not only its display name', async () => {
    // The slice-blob cache keys off `fileName`, and only `id` is required to be
    // unique — two datasets sharing a display name would otherwise serve each
    // other's slices.
    const a = await buildVolumeStackImage(dataset({ id: 'abc.full' }), voxels(2, 3, 4));
    const b = await buildVolumeStackImage(dataset({ id: 'abc.sub10' }), voxels(2, 3, 4));

    expect(a!.info.fileName).not.toBe(b!.info.fileName);
    expect(a!.info.fileName).toContain('abc.full');
    // The name is still in there, since it is what a user sees.
    expect(a!.info.fileName).toContain('Whole mouse brain MERFISH');
  });

  it('scales mpp by micronsPerUnit, and reports none when the unit is unknown', async () => {
    const known = await buildVolumeStackImage(
      dataset({ micronsPerUnit: 2 }), voxels(2, 3, 4),
    );
    expect(known!.info.imageMeta[0].mppX).toBe(80);
    expect(known!.info.imageMeta[0].mppY).toBe(80);

    // No micronsPerUnit means the unit is UNKNOWN — a scale bar drawn from a
    // guess looks like a measurement, so mpp stays null.
    const unknown = await buildVolumeStackImage(
      dataset({ micronsPerUnit: undefined }), voxels(2, 3, 4),
    );
    expect(unknown!.info.imageMeta[0].mppX).toBeNull();
    expect(unknown!.info.imageMeta[0].mppY).toBeNull();
  });

  it('refuses a buffer that contradicts the declared geometry', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // One plane short: slicing this would show anatomy from the wrong depth.
    expect(await buildVolumeStackImage(dataset(), voxels(2, 3, 3))).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('returns null for a dataset that declares no volume', async () => {
    expect(await buildVolumeStackImage(dataset({ volume: undefined }), new Uint8Array(0))).toBeNull();
  });

  it('marks a single-plane volume as a flat image, with no initial slice', async () => {
    const built = await buildVolumeStackImage(
      dataset({ volume: { width: 2, height: 3, depth: 1, voxelSize: [40, 40, 200] } }),
      voxels(2, 3, 1),
    );
    expect(built!.info.isStack).toBe(false);
    expect(built!.info.initialZIndex).toBeUndefined();
  });
});

/**
 * The frame a registered volume defines: the affine that puts observations in a
 * slice's pixel grid, and which observations belong to a slice at all.
 */
describe('the volume as a coordinate frame', () => {
  const volume = { width: 275, height: 275, depth: 76, voxelSize: [40, 40, 200] as [number, number, number] };

  it('maps observation coordinates onto the slice pixel grid', () => {
    const ref = volumeImageRef(volume, 1);

    // The volume's near corner is the coordinate origin, so nothing translates and
    // a coordinate reaches pixels by dividing out the voxel size.
    expect(ref.scale).toEqual([1 / 40, 1 / 40]);
    expect(ref.translate).toEqual([0, 0]);
    // 4 mm along x is voxel 100 of 275.
    expect(4000 * ref.scale![0]).toBe(100);
    expect(ref.mppX).toBe(40);
  });

  it('reports no physical pixel size when the coordinate unit is unknown', () => {
    // Same rule as the image: an unstated unit must not become a scale bar.
    const ref = volumeImageRef(volume);
    expect(ref.mppX).toBeUndefined();
    expect(ref.mppY).toBeUndefined();
  });

  it('bins a z coordinate into its voxel plane, clamping outside the volume', () => {
    expect(sliceIndexOf(0, volume)).toBe(0);
    expect(sliceIndexOf(199, volume)).toBe(0);
    expect(sliceIndexOf(200, volume)).toBe(1);
    expect(sliceIndexOf(7600, volume)).toBe(38);
    // A cloud can sit slightly outside its template's box; clamp rather than
    // index off the end.
    expect(sliceIndexOf(-5, volume)).toBe(0);
    expect(sliceIndexOf(1e9, volume)).toBe(75);
  });

  it('picks out the observations in one plane', () => {
    const obs: any = {
      count: 5,
      x: new Float32Array([0, 1, 2, 3, 4]),
      y: new Float32Array([0, 0, 0, 0, 0]),
      // planes 0, 1, 1, 38, 0
      z: new Float32Array([10, 250, 399, 7600, 190]),
    };
    expect(Array.from(observationsInSlice(obs, volume, 0))).toEqual([0, 4]);
    expect(Array.from(observationsInSlice(obs, volume, 1))).toEqual([1, 2]);
    expect(Array.from(observationsInSlice(obs, volume, 38))).toEqual([3]);
    expect(Array.from(observationsInSlice(obs, volume, 2))).toEqual([]);
  });

  it('treats every observation as in-plane when the dataset carries no z', () => {
    const obs: any = { count: 3, x: new Float32Array(3), y: new Float32Array(3) };
    expect(Array.from(observationsInSlice(obs, volume, 7))).toEqual([0, 1, 2]);
  });
});
