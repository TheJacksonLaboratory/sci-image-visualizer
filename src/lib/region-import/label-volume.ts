/**
 * A label volume (a NIfTI-1 `.nii` / `.nii.gz` or a NRRD `.nrrd` of integer structure ids, an
 * atlas annotation say) read in the browser, sliced as the server opens the matching image:
 *
 * - **NRRD**: a 3D volume is cut along its FIRST axis, each section its third axis wide and its
 *   second axis high, as jit-service opens a NRRD volume (`AtlasNrrdReader`: the Allen CCF's 528
 *   coronal sections of 456 × 320, anterior first). A 2D NRRD is one slice.
 * - **NIfTI**: along its third axis, each slice its first axis wide and its second axis high, as
 *   Bio-Formats reads one (no row flip).
 *
 * Only what label volumes use: a single file (NRRD with attached data, NIfTI-1 `n+1`), integer
 * or integer-valued float samples, either byte order, raw or gzip. Anything else throws rather
 * than be read approximately. Pure: usable from workers.
 */

/** A label volume, sliced (see the module comment). Label 0 is background. */
export interface LabelVolume {
  format: 'nrrd' | 'nifti';
  /** A slice's width and height, in voxels (the image's pixels). */
  width: number;
  height: number;
  /** Number of slices. */
  slices: number;
  /** Size of a voxel along the slice's x, its y and across slices, in micrometres, when the file
   *  says (NRRD `space directions`/`spacings`, micrometres unless `space units` says otherwise;
   *  NIfTI `pixdim`, in its `xyzt_units`, millimetres when unset). */
  spacing?: [number, number, number];
  /** Slice `z`'s labels, row-major (`height` rows of `width`). */
  sliceLabels(z: number): Uint32Array;
}

/** Decompress gzip bytes (default: the platform's `DecompressionStream`). */
export type Gunzip = (bytes: Uint8Array) => Promise<Uint8Array>;

/** Whether a file name is a label volume this reads. */
export function isLabelVolumeName(name: string): boolean {
  return /\.(nrrd|nii|nii\.gz)$/i.test(name);
}

/** Read the label volume in `bytes`, named `name` (`.nrrd`, `.nii`, `.nii.gz`). */
export async function readLabelVolume(
  name: string,
  bytes: Uint8Array,
  gunzip: Gunzip = platformGunzip,
): Promise<LabelVolume> {
  if (/\.nrrd$/i.test(name)) return readNrrd(bytes, gunzip);
  if (/\.nii(\.gz)?$/i.test(name)) return readNifti(isGzip(bytes) ? await gunzip(bytes) : bytes);
  throw new Error(`${name}: not a NIfTI (.nii, .nii.gz) or NRRD (.nrrd) label volume`);
}

/** Sample types: their byte size and how one is read. */
type Sample = { bytes: number; read: (v: DataView, at: number, little: boolean) => number };
const SAMPLES: Record<string, Sample> = {
  u8: { bytes: 1, read: (v, at) => v.getUint8(at) },
  i8: { bytes: 1, read: (v, at) => v.getInt8(at) },
  u16: { bytes: 2, read: (v, at, le) => v.getUint16(at, le) },
  i16: { bytes: 2, read: (v, at, le) => v.getInt16(at, le) },
  u32: { bytes: 4, read: (v, at, le) => v.getUint32(at, le) },
  i32: { bytes: 4, read: (v, at, le) => v.getInt32(at, le) },
  f32: { bytes: 4, read: (v, at, le) => Math.round(v.getFloat32(at, le)) },
  f64: { bytes: 8, read: (v, at, le) => Math.round(v.getFloat64(at, le)) },
};

/** NRRD type names (every spelling the format allows) → sample type. */
const NRRD_TYPES: Record<string, string> = {
  'signed char': 'i8',
  int8: 'i8',
  int8_t: 'i8',
  uchar: 'u8',
  'unsigned char': 'u8',
  uint8: 'u8',
  uint8_t: 'u8',
  short: 'i16',
  'short int': 'i16',
  'signed short': 'i16',
  'signed short int': 'i16',
  int16: 'i16',
  int16_t: 'i16',
  ushort: 'u16',
  'unsigned short': 'u16',
  'unsigned short int': 'u16',
  uint16: 'u16',
  uint16_t: 'u16',
  int: 'i32',
  'signed int': 'i32',
  int32: 'i32',
  int32_t: 'i32',
  uint: 'u32',
  'unsigned int': 'u32',
  uint32: 'u32',
  uint32_t: 'u32',
  float: 'f32',
  double: 'f64',
};

/** NIfTI datatype codes → sample type. */
const NIFTI_TYPES: Record<number, string> = {
  2: 'u8',
  4: 'i16',
  8: 'i32',
  16: 'f32',
  64: 'f64',
  256: 'i8',
  512: 'u16',
  768: 'u32',
};

async function readNrrd(bytes: Uint8Array, gunzip: Gunzip): Promise<LabelVolume> {
  const end = headerEnd(bytes);
  if (end < 0) throw new Error('NRRD: no blank line ends the header');
  const lines = new TextDecoder('latin1').decode(bytes.subarray(0, end)).split(/\r?\n/);
  if (!/^NRRD\d{4}/.test(lines[0] ?? '')) throw new Error('NRRD: not a NRRD file');
  const field: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    if (line.startsWith('#')) continue;
    const at = line.indexOf(': ');
    if (at > 0) field[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 2).trim();
  }
  if (field['data file'] || field['datafile']) throw new Error('NRRD: detached data (a .nhdr) is not supported');
  const type = NRRD_TYPES[(field['type'] ?? '').toLowerCase()];
  if (!type) throw new Error(`NRRD: unsupported type "${field['type']}"`);
  const sizes = (field['sizes'] ?? '').split(/\s+/).filter(Boolean).map(Number);
  if (sizes.length !== 2 && sizes.length !== 3)
    throw new Error(`NRRD: need 2 or 3 dimensions, got ${sizes.length}`);
  const encoding = (field['encoding'] ?? 'raw').toLowerCase();
  let data = bytes.subarray(end);
  if (encoding === 'gzip' || encoding === 'gz') data = await gunzip(data);
  else if (encoding !== 'raw') throw new Error(`NRRD: unsupported encoding "${encoding}"`);
  const little = (field['endian'] ?? 'little').toLowerCase() !== 'big';
  // A 3D volume: sections along axis 0, each axis 2 wide and axis 1 high (jit-service's cut).
  const [n0, n1, n2] = sizes.length === 3 ? sizes : [sizes[0], sizes[1], 1];
  const axes = sizes.length === 3 ? { z: 0, x: 2, y: 1 } : { z: 2, x: 0, y: 1 };
  return volume('nrrd', [n0, n1, n2], axes, data, SAMPLES[type], little, nrrdSpacing(field, sizes.length));
}

/** Per file axis, the voxel size in micrometres (see {@link LabelVolume.spacing}), or undefined. */
function nrrdSpacing(field: Record<string, string>, dims: number): number[] | undefined {
  let sizes: number[] | undefined;
  const directions = field['space directions'];
  if (directions) {
    const vectors = directions.match(/\(([^)]*)\)|none/g) ?? [];
    sizes = vectors.filter((v) => v !== 'none').map((v) => Math.hypot(...v.slice(1, -1).split(',').map(Number)));
  } else if (field['spacings']) {
    sizes = field['spacings'].split(/\s+/).map(Number);
  }
  if (!sizes || sizes.length !== dims || sizes.some((n) => !(n > 0))) return undefined;
  const unit = (field['space units'] ?? '').replace(/"/g, '').trim().split(/\s+/)[0]?.toLowerCase();
  const factor = unit === 'mm' || unit === 'millimeters' ? 1e3 : unit === 'm' || unit === 'meters' ? 1e6 : 1;
  return [...sizes.map((n) => n * factor), ...(dims === 2 ? [1] : [])];
}

function readNifti(bytes: Uint8Array): LabelVolume {
  if (bytes.length < 352) throw new Error('NIfTI: shorter than a header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let little = true;
  if (view.getInt32(0, true) !== 348) {
    if (view.getInt32(0, false) !== 348) throw new Error('NIfTI: not a NIfTI-1 file');
    little = false;
  }
  const magic = new TextDecoder('latin1').decode(bytes.subarray(344, 347));
  if (magic !== 'n+1') throw new Error('NIfTI: a separate .hdr/.img pair is not supported');
  const ndim = view.getInt16(40, little);
  const dims = [1, 2, 3, 4].map((i) => view.getInt16(40 + 2 * i, little));
  if (ndim < 2) throw new Error(`NIfTI: need at least 2 dimensions, got ${ndim}`);
  if (ndim >= 4 && dims[3] > 1) throw new Error('NIfTI: a 4D file is not a label volume');
  const type = NIFTI_TYPES[view.getInt16(70, little)];
  if (!type) throw new Error(`NIfTI: unsupported datatype ${view.getInt16(70, little)}`);
  const offset = Math.max(352, Math.round(view.getFloat32(108, little)));
  const [n0, n1, n2] = [dims[0], dims[1], ndim >= 3 ? dims[2] : 1];
  // Slices along axis 2, each axis 0 wide and axis 1 high (Bio-Formats' planes).
  const pixdim = [1, 2, 3].map((i) => Math.abs(view.getFloat32(76 + 4 * i, little)));
  const units = bytes[123] & 7;
  const factor = units === 1 ? 1e6 : units === 3 ? 1 : 1e3; // metres, micrometres, else millimetres
  const spacing = pixdim.every((n) => n > 0) ? pixdim.map((n) => n * factor) : undefined;
  return volume(
    'nifti',
    [n0, n1, n2],
    { z: 2, x: 0, y: 1 },
    bytes.subarray(offset),
    SAMPLES[type],
    little,
    spacing,
  );
}

function volume(
  format: LabelVolume['format'],
  n: [number, number, number],
  axes: { z: number; x: number; y: number },
  data: Uint8Array,
  sample: Sample,
  little: boolean,
  spacing?: number[],
): LabelVolume {
  const count = n[0] * n[1] * n[2];
  if (!(count > 0)) throw new Error(`${format}: empty volume`);
  if (data.length < count * sample.bytes) {
    throw new Error(`${format}: ${data.length} bytes of data, ${count * sample.bytes} needed`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stride = [1, n[0], n[0] * n[1]];
  const width = n[axes.x];
  const height = n[axes.y];
  return {
    format,
    width,
    height,
    slices: n[axes.z],
    ...(spacing
      ? { spacing: [spacing[axes.x], spacing[axes.y], spacing[axes.z]] as [number, number, number] }
      : {}),
    sliceLabels(z: number): Uint32Array {
      const out = new Uint32Array(width * height);
      const base = z * stride[axes.z];
      const sx = stride[axes.x];
      const sy = stride[axes.y];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const v = sample.read(view, (base + x * sx + y * sy) * sample.bytes, little);
          out[y * width + x] = v > 0 ? v : 0;
        }
      }
      return out;
    },
  };
}

/** The offset just past the header's blank line (`\n\n` or `\r\n\r\n`); -1 without one. */
function headerEnd(bytes: Uint8Array): number {
  const limit = Math.min(bytes.length - 1, 1 << 20);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] !== 10) continue;
    if (bytes[i + 1] === 10) return i + 2;
    if (bytes[i + 1] === 13 && bytes[i + 2] === 10) return i + 3;
  }
  return -1;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function platformGunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('gzip data needs DecompressionStream');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
