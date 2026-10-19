import { gzipSync, gunzipSync } from 'zlib';

import { isLabelVolumeName, readLabelVolume } from './label-volume';

const gunzip = async (b: Uint8Array) => new Uint8Array(gunzipSync(b));
const enc = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** A uint16 volume of sizes n (axis 0 fastest) whose voxel (a0, a1, a2) holds 100·a0 + 10·a1 + a2. */
function coded(n: [number, number, number], little = true): Uint8Array {
  const out = new Uint8Array(n[0] * n[1] * n[2] * 2);
  const view = new DataView(out.buffer);
  let i = 0;
  for (let a2 = 0; a2 < n[2]; a2++)
    for (let a1 = 0; a1 < n[1]; a1++)
      for (let a0 = 0; a0 < n[0]; a0++) view.setUint16(2 * i++, 100 * a0 + 10 * a1 + a2, little);
  return out;
}

function nrrd(fields: string, data: Uint8Array): Uint8Array {
  return concat(enc(`NRRD0004\n${fields}\n\n`), data);
}

function nifti(n: number[], datatype: number, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(352);
  const v = new DataView(head.buffer);
  v.setInt32(0, 348, true);
  v.setInt16(40, n.length, true);
  n.forEach((d, i) => v.setInt16(42 + 2 * i, d, true));
  v.setInt16(70, datatype, true);
  v.setFloat32(108, 352, true);
  head.set(enc('n+1\0'), 344);
  return concat(head, data);
}

describe('readLabelVolume', () => {
  it('cuts a 3D NRRD along its first axis, each section its third axis wide, its second high', async () => {
    const vol = await readLabelVolume(
      'a.nrrd',
      nrrd('type: unsigned short\ndimension: 3\nsizes: 4 3 2\nendian: little\nencoding: raw', coded([4, 3, 2])),
    );
    expect([vol.format, vol.width, vol.height, vol.slices]).toEqual(['nrrd', 2, 3, 4]);
    // Section 3: x = axis 2, y = axis 1.
    expect(Array.from(vol.sliceLabels(3))).toEqual([300, 301, 310, 311, 320, 321]);
  });

  it('reads gzip and big-endian NRRD data', async () => {
    const vol = await readLabelVolume(
      'a.nrrd',
      nrrd(
        'type: ushort\ndimension: 3\nsizes: 4 3 2\nendian: big\nencoding: gzip',
        new Uint8Array(gzipSync(coded([4, 3, 2], false))),
      ),
      gunzip,
    );
    expect(Array.from(vol.sliceLabels(1))).toEqual([100, 101, 110, 111, 120, 121]);
  });

  it("gives a NRRD's voxel size per slice axis, in micrometres, as the Allen CCF's header says it", async () => {
    const data = coded([2, 3, 4]);
    const fields = (extra: string) =>
      `type: uint16\ndimension: 3\nsizes: 2 3 4\nencoding: raw\nendian: little\n${extra}`;
    // Sections along axis 0 (200 um apart), each axis 2 wide and axis 1 high (25 um pixels).
    const ccf = await readLabelVolume(
      'a.nrrd',
      nrrd(fields('space directions: (200,0,0) (0,25,0) (0,0,25)'), data),
    );
    expect(ccf.spacing).toEqual([25, 25, 200]);
    const mm = await readLabelVolume(
      'a.nrrd',
      nrrd(fields('spacings: 0.2 0.025 0.05\nspace units: "mm" "mm" "mm"'), data),
    );
    expect(mm.spacing?.map((n) => Math.round(n))).toEqual([50, 25, 200]);
    expect((await readLabelVolume('a.nrrd', nrrd(fields(''), data))).spacing).toBeUndefined();
  });

  it("gives a NIfTI's voxel size from its pixdim, in micrometres", async () => {
    const file = nifti([4, 3, 2], 512, coded([4, 3, 2]));
    const v = new DataView(file.buffer);
    [10, 10, 200].forEach((d, i) => v.setFloat32(80 + 4 * i, d / 1000, true)); // mm, the NIfTI default
    expect((await readLabelVolume('a.nii', file)).spacing?.map((n) => Math.round(n))).toEqual([10, 10, 200]);
    file[123] = 3; // micrometres
    [10, 10, 200].forEach((d, i) => v.setFloat32(80 + 4 * i, d, true));
    expect((await readLabelVolume('a.nii', file)).spacing).toEqual([10, 10, 200]);
  });

  it('reads a 2D NRRD as one slice', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const vol = await readLabelVolume(
      'a.nrrd',
      nrrd('type: uchar\ndimension: 2\nsizes: 3 2\nencoding: raw', data),
    );
    expect([vol.width, vol.height, vol.slices]).toEqual([3, 2, 1]);
    expect(Array.from(vol.sliceLabels(0))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('slices a NIfTI along its third axis, each slice its first axis wide, its second high', async () => {
    const vol = await readLabelVolume('a.nii', nifti([4, 3, 2], 512, coded([4, 3, 2])));
    expect([vol.format, vol.width, vol.height, vol.slices]).toEqual(['nifti', 4, 3, 2]);
    expect(Array.from(vol.sliceLabels(1))).toEqual([1, 101, 201, 301, 11, 111, 211, 311, 21, 121, 221, 321]);
  });

  it('reads a gzipped .nii.gz', async () => {
    const vol = await readLabelVolume(
      'a.nii.gz',
      new Uint8Array(gzipSync(nifti([4, 3, 2], 512, coded([4, 3, 2])))),
      gunzip,
    );
    expect(vol.slices).toBe(2);
  });

  it('refuses what it cannot read as labels, saying why', async () => {
    await expect(
      readLabelVolume('a.nrrd', nrrd('type: uchar\nsizes: 2 2 2\ndata file: a.raw', new Uint8Array())),
    ).rejects.toThrow(/detached/);
    await expect(readLabelVolume('a.nii', nifti([2, 2, 2, 3], 2, new Uint8Array(24)))).rejects.toThrow(/4D/);
    await expect(
      readLabelVolume('a.nrrd', nrrd('type: uchar\nsizes: 4 4 4\nencoding: raw', new Uint8Array(3))),
    ).rejects.toThrow(/needed/);
    await expect(readLabelVolume('a.tif', new Uint8Array())).rejects.toThrow(/not a NIfTI/);
  });

  it('knows its file names', () => {
    expect(['a.nrrd', 'b.NII', 'c.nii.gz', 'd.tif', 'e.geojson'].map(isLabelVolumeName)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});
