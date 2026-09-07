/**
 * Minimal NIfTI-1 reader — enough for the Allen CCF reference volumes.
 *
 * NIfTI is a 348-byte header followed by the voxels, optionally gzipped, and the
 * Allen volumes are the plain single-file `.nii.gz` case. That makes a reader
 * about eighty lines, against a dependency that would pull in a whole medical
 * imaging stack for one array.
 *
 * Deliberately NOT supported, because these files do not use it: separate
 * `.hdr`/`.img` pairs, NIfTI-2, RGB/complex datatypes, and the affine (`sform`/
 * `qform`) beyond `pixdim`. The Allen volumes are axis-aligned and already
 * resampled into the frame their cell coordinates use, so `pixdim` is the whole
 * spatial story. A file that needs more than this should say so loudly rather
 * than be read approximately — hence the throws.
 */
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const HEADER_BYTES = 348;

/** NIfTI datatype codes → how to read the voxels. */
const DTYPES = new Map([
  [2, { name: 'uint8', bytes: 1, read: (b, o, n) => new Uint8Array(b.buffer, b.byteOffset + o, n) }],
  [4, { name: 'int16', bytes: 2, read: (b, o, n) => new Int16Array(b.buffer, b.byteOffset + o, n) }],
  [8, { name: 'int32', bytes: 4, read: (b, o, n) => new Int32Array(b.buffer, b.byteOffset + o, n) }],
  [16, { name: 'float32', bytes: 4, read: (b, o, n) => new Float32Array(b.buffer, b.byteOffset + o, n) }],
  [64, { name: 'float64', bytes: 8, read: (b, o, n) => new Float64Array(b.buffer, b.byteOffset + o, n) }],
  [512, { name: 'uint16', bytes: 2, read: (b, o, n) => new Uint16Array(b.buffer, b.byteOffset + o, n) }],
]);

/** Parse the header out of an already-decompressed buffer. */
export function readNiftiHeader(buf) {
  if (buf.length < HEADER_BYTES) throw new Error('[nifti] file shorter than a header');

  // sizeof_hdr is 348 in the file's own byte order — the standard endianness
  // probe, and the only way to know before reading anything else.
  let little = true;
  if (buf.readInt32LE(0) !== HEADER_BYTES) {
    if (buf.readInt32BE(0) !== HEADER_BYTES) {
      throw new Error('[nifti] not a NIfTI-1 file (sizeof_hdr is neither 348 LE nor BE)');
    }
    little = false;
  }
  const i16 = (o) => (little ? buf.readInt16LE(o) : buf.readInt16BE(o));
  const f32 = (o) => (little ? buf.readFloatLE(o) : buf.readFloatBE(o));

  const ndim = i16(40);
  if (ndim < 3) throw new Error(`[nifti] need at least 3 dimensions, got ${ndim}`);
  const dims = [i16(42), i16(44), i16(46)];
  // A 4th dimension would be time or channels; taking volume 0 silently could
  // hide three quarters of a file, so refuse instead.
  const dim4 = ndim >= 4 ? i16(48) : 1;
  if (dim4 > 1) throw new Error(`[nifti] 4D files are not supported (dim[4] = ${dim4})`);

  const code = i16(70);
  const dtype = DTYPES.get(code);
  if (!dtype) throw new Error(`[nifti] unsupported datatype code ${code}`);

  const pixdim = [f32(80), f32(84), f32(88)];
  // scl_slope of 0 means "no scaling", which is not the same as multiplying by 0.
  const slope = f32(112) || 1;
  const inter = f32(116);

  return {
    dims,
    pixdim,
    dtype: dtype.name,
    little,
    slope,
    inter,
    voxels: dims[0] * dims[1] * dims[2],
    dataOffset: Math.max(HEADER_BYTES, Math.round(f32(108))),
    _dtype: dtype,
  };
}

/**
 * Read a `.nii` / `.nii.gz` into `{ dims, pixdim, data }`.
 *
 * `data` is the raw voxel array in file order (x-fastest), NOT scaled — callers
 * that care apply `slope`/`inter`. Multi-byte data in the non-native byte order
 * is refused rather than byte-swapped, because every file we serve is
 * little-endian and a silent swap is a bug waiting to look like anatomy.
 */
export async function readNifti(filePath) {
  const raw = await readFile(filePath);
  const buf = filePath.endsWith('.gz') ? gunzipSync(raw) : raw;
  const h = readNiftiHeader(buf);

  if (!h.little && h._dtype.bytes > 1) {
    throw new Error('[nifti] big-endian multi-byte data is not supported');
  }
  const need = h.dataOffset + h.voxels * h._dtype.bytes;
  if (buf.length < need) {
    throw new Error(`[nifti] truncated: need ${need} bytes, have ${buf.length}`);
  }
  return { ...h, data: h._dtype.read(buf, h.dataOffset, h.voxels) };
}
