/**
 * A label image of an OME-Zarr store (`labels/<name>/`, NGFF 0.4 on zarr v2 or 0.5 on zarr v3),
 * read in the browser from the store's files (a folder chosen, or a zip's members): its full
 * resolution level, sliced along z, with the classes its `image-label` metadata names and colours.
 *
 * Chunks are decoded when a slice that needs them is read, so a store is never decoded whole.
 * Only what label images use: C-order chunks of integer (or integer-valued float) samples, through
 * the codecs {@link decodeChunk} reads, a missing chunk being the fill value. Sharded or transposed
 * arrays, F-order and filters throw rather than be read wrongly. Pure: usable from workers.
 */
import { labelClasses, LabelClasses } from './label-classes';
import type { RegionImportFile } from './region-import';
import { decodeChunk, Inflate } from './zarr-codecs';

/** A stack of label slices read on demand. Label 0 is background. */
export interface LabelStack {
  width: number;
  height: number;
  slices: number;
  /** Size of a voxel, x, y, z, in micrometres, when the source says. */
  spacing?: [number, number, number];
  /** Slice `z`'s labels, row-major (`height` rows of `width`). */
  labels(z: number): Promise<Uint32Array>;
}

/** An OME-Zarr label image: its name, its slices, its classes. */
export interface OmeZarrLabels {
  name: string;
  stack: LabelStack;
  classes: LabelClasses;
}

/** Whether `files` hold a zarr store (any zarr metadata among them). */
export function hasZarrMetadata(files: readonly RegionImportFile[]): boolean {
  return files.some((f) => /(^|\/)(\.zattrs|\.zarray|\.zgroup|zarr\.json)$/.test(norm(f.name)));
}

/**
 * The first label image of the zarr store among `files` (the order `labels/`'s listing gives,
 * else the first found), or null when the store has none.
 */
export async function readOmeZarrLabels(
  files: readonly RegionImportFile[],
  inflate?: Inflate,
): Promise<OmeZarrLabels | null> {
  const byPath = new Map(files.map((f) => [norm(f.name), f]));
  const groups = new Map<string, Record<string, unknown>>();
  for (const [path, file] of byPath) {
    const m = /^(.*?)\/?(\.zattrs|zarr\.json)$/.exec(path);
    if (!m) continue;
    const doc = JSON.parse(await file.text()) as Record<string, unknown>;
    const attrs = (m[2] === 'zarr.json' ? (doc['attributes'] as Record<string, unknown>) : doc) ?? {};
    groups.set(m[1], ((attrs['ome'] as Record<string, unknown>) ?? attrs) as Record<string, unknown>);
  }
  const listed: string[] = [];
  for (const [dir, ome] of groups) {
    for (const name of (ome['labels'] as string[] | undefined) ?? []) listed.push(join(dir, name));
  }
  const isLabel = (dir: string) => {
    const ome = groups.get(dir);
    return !!ome?.['multiscales'] && (!!ome['image-label'] || /(^|\/)labels\/[^/]+$/.test(dir));
  };
  const dir = [...listed, ...groups.keys()].find(isLabel);
  if (dir === undefined) return null;
  const ome = groups.get(dir) as Record<string, unknown>;
  const ms = (ome['multiscales'] as Multiscale[])[0];
  const dataset = ms.datasets[0];
  const array = await readArrayMeta(byPath, join(dir, dataset.path));
  const axes = (ms.axes ?? ['z', 'y', 'x'].slice(3 - array.shape.length)).map((a) =>
    typeof a === 'string' ? { name: a } : a,
  );
  if (axes.length !== array.shape.length)
    throw new Error(`OME-Zarr ${dir}: ${axes.length} axes for a ${array.shape.length}-D array`);
  const at = (n: string) => axes.findIndex((a) => a.name.toLowerCase() === n);
  const ix = at('x');
  const iy = at('y');
  const iz = at('z');
  if (ix < 0 || iy < 0) throw new Error(`OME-Zarr ${dir}: no x and y axes`);
  const scale = dataset.coordinateTransformations?.find((t) => t.type === 'scale')?.scale;
  const um = (i: number) => (i < 0 ? 1 : (scale?.[i] ?? 1) * unitToMicrons(axes[i].unit));
  const stack = labelStack(byPath, join(dir, dataset.path), array, { ix, iy, iz }, inflate);
  stack.spacing = [um(ix), um(iy), iz < 0 ? 1 : um(iz)];
  const name = ms.name ?? dir.split('/').pop() ?? 'labels';
  return { name, stack, classes: imageLabelClasses(ome['image-label'] as ImageLabel | undefined) };
}

interface Multiscale {
  name?: string;
  axes?: Array<string | { name: string; type?: string; unit?: string }>;
  datasets: Array<{ path: string; coordinateTransformations?: Array<{ type: string; scale?: number[] }> }>;
}

interface ImageLabel {
  colors?: Array<{ 'label-value': number; rgba?: number[] }>;
  properties?: Array<Record<string, unknown> & { 'label-value': number }>;
}

/** What one array's chunks are and how they decode. */
interface ArrayMeta {
  shape: number[];
  chunks: number[];
  /** Sample reader: element `i` of a decoded chunk. */
  dtype: { bytes: number; read: (v: DataView, at: number) => number };
  codecs: { id: string }[];
  fill: number;
  key: (index: number[]) => string;
}

async function readArrayMeta(byPath: Map<string, RegionImportFile>, path: string): Promise<ArrayMeta> {
  const v2 = byPath.get(join(path, '.zarray'));
  if (v2) {
    const m = JSON.parse(await v2.text());
    if (m.order && m.order !== 'C') throw new Error(`zarr ${path}: ${m.order}-order chunks are not supported`);
    if (m.filters?.length) throw new Error(`zarr ${path}: filters are not supported`);
    const sep = m.dimension_separator ?? '.';
    return {
      shape: m.shape,
      chunks: m.chunks,
      dtype: v2Dtype(m.dtype, path),
      codecs: m.compressor ? [m.compressor] : [],
      fill: Number(m.fill_value ?? 0) || 0,
      key: (index) => index.join(sep),
    };
  }
  const v3 = byPath.get(join(path, 'zarr.json'));
  if (!v3) throw new Error(`zarr ${path}: no array metadata`);
  const m = JSON.parse(await v3.text());
  if (m.chunk_grid?.name !== 'regular')
    throw new Error(`zarr ${path}: chunk grid ${m.chunk_grid?.name} is not supported`);
  const codecs = (m.codecs ?? []) as Array<{ name: string; configuration?: Record<string, unknown> }>;
  const bytes = codecs[0];
  if (bytes?.name !== 'bytes') {
    throw new Error(
      `zarr ${path}: codec ${bytes?.name ?? 'none'} before bytes is not supported (sharding, transpose)`,
    );
  }
  const little = (bytes.configuration?.['endian'] ?? 'little') === 'little';
  const enc = m.chunk_key_encoding ?? { name: 'default' };
  const sep = (enc.configuration?.separator as string) ?? (enc.name === 'v2' ? '.' : '/');
  return {
    shape: m.shape,
    chunks: m.chunk_grid.configuration.chunk_shape,
    dtype: v3Dtype(m.data_type, little, path),
    codecs: codecs.slice(1).map((c) => ({ id: c.name, ...(c.configuration ?? {}) })),
    fill: Number(m.fill_value ?? 0) || 0,
    key: (index) => (enc.name === 'v2' ? index.join(sep) : ['c', ...index].join(sep)),
  };
}

/** The slices of the array at `path`, decoding (and keeping) the chunk layers a slice spans. */
function labelStack(
  byPath: Map<string, RegionImportFile>,
  path: string,
  a: ArrayMeta,
  axes: { ix: number; iy: number; iz: number },
  inflate?: Inflate,
): LabelStack {
  const { ix, iy, iz } = axes;
  const width = a.shape[ix];
  const height = a.shape[iy];
  const slices = iz < 0 ? 1 : a.shape[iz];
  const cx = a.chunks[ix];
  const cy = a.chunks[iy];
  // The chunks (their decodes, pending or done) of the last chunk layer along z read: a slice's
  // neighbours share it. A read keeps the layer it started with, so a read of another layer
  // replacing this cache while it awaits a chunk cannot change what it reads.
  let layer: { kz: number; chunks: Map<string, Promise<Uint8Array | null>> } | null = null;
  const chunk = async (index: number[]): Promise<Uint8Array | null> => {
    const file = byPath.get(join(path, a.key(index)));
    if (!file) return null;
    return decodeChunk(await file.bytes(), a.codecs, inflate);
  };
  return {
    width,
    height,
    slices,
    async labels(z: number): Promise<Uint32Array> {
      if (z < 0 || z >= slices) throw new Error(`slice ${z} of ${slices}`);
      const kz = iz < 0 ? 0 : Math.floor(z / a.chunks[iz]);
      if (layer?.kz !== kz) layer = { kz, chunks: new Map() };
      const mine = layer;
      const out = new Uint32Array(width * height);
      const strides = a.chunks.map((_, d) => a.chunks.slice(d + 1).reduce((p, n) => p * n, 1));
      for (let gy = 0; gy * cy < height; gy++) {
        for (let gx = 0; gx * cx < width; gx++) {
          // Every other axis (time, channel) at its first index.
          const index = a.shape.map((_, d) => (d === ix ? gx : d === iy ? gy : d === iz ? kz : 0));
          const key = index.join(',');
          let pending = mine.chunks.get(key);
          if (!pending) {
            pending = chunk(index);
            mine.chunks.set(key, pending);
            // A chunk that failed to decode is not kept: the next read tries it again.
            pending.catch(() => mine.chunks.delete(key));
          }
          const data = await pending;
          const view = data ? new DataView(data.buffer, data.byteOffset, data.byteLength) : null;
          const inZ = iz < 0 ? 0 : z - kz * a.chunks[iz];
          for (let y = gy * cy; y < Math.min(height, (gy + 1) * cy); y++) {
            for (let x = gx * cx; x < Math.min(width, (gx + 1) * cx); x++) {
              let v = a.fill;
              if (view) {
                const local = a.shape.map((_, d) =>
                  d === ix ? x - gx * cx : d === iy ? y - gy * cy : d === iz ? inZ : 0,
                );
                const i = local.reduce((p, n, d) => p + n * strides[d], 0);
                v = a.dtype.read(view, i * a.dtype.bytes);
              }
              if (v > 0xffffffff) {
                // A label id past 32 bits would be another label once narrowed: refuse it.
                throw new Error(`zarr ${path}: label ${v} does not fit 32 bits`);
              }
              out[y * width + x] = v > 0 ? v : 0;
            }
          }
        }
      }
      return out;
    },
  };
}

const SAMPLE: Record<string, { bytes: number; read: (v: DataView, at: number, le: boolean) => number }> = {
  u1: { bytes: 1, read: (v, at) => v.getUint8(at) },
  i1: { bytes: 1, read: (v, at) => v.getInt8(at) },
  u2: { bytes: 2, read: (v, at, le) => v.getUint16(at, le) },
  i2: { bytes: 2, read: (v, at, le) => v.getInt16(at, le) },
  u4: { bytes: 4, read: (v, at, le) => v.getUint32(at, le) },
  i4: { bytes: 4, read: (v, at, le) => v.getInt32(at, le) },
  u8: { bytes: 8, read: (v, at, le) => Number(v.getBigUint64(at, le)) },
  i8: { bytes: 8, read: (v, at, le) => Number(v.getBigInt64(at, le)) },
  f4: { bytes: 4, read: (v, at, le) => Math.round(v.getFloat32(at, le)) },
  f8: { bytes: 8, read: (v, at, le) => Math.round(v.getFloat64(at, le)) },
};

function v2Dtype(dtype: string, path: string): ArrayMeta['dtype'] {
  const m = /^([<>|])([uif])(\d)$/.exec(dtype);
  const s = m ? SAMPLE[m[2] + m[3]] : undefined;
  if (!m || !s) throw new Error(`zarr ${path}: dtype ${dtype} is not a label type`);
  const le = m[1] !== '>';
  return { bytes: s.bytes, read: (v, at) => s.read(v, at, le) };
}

function v3Dtype(type: string, little: boolean, path: string): ArrayMeta['dtype'] {
  const m = /^(u?int|float)(8|16|32|64)$/.exec(type);
  const code = m ? (m[1] === 'uint' ? 'u' : m[1] === 'int' ? 'i' : 'f') + Number(m[2]) / 8 : '';
  const s = SAMPLE[code];
  if (!s) throw new Error(`zarr ${path}: data type ${type} is not a label type`);
  return { bytes: s.bytes, read: (v, at) => s.read(v, at, little) };
}

/** The classes `image-label` names (a property naming each value) and colours; others unnamed. */
function imageLabelClasses(meta: ImageLabel | undefined): LabelClasses {
  const named = new Map<number, { name?: string; color?: string }>();
  for (const p of meta?.properties ?? []) {
    const name = ['name', 'class', 'label', 'acronym', 'structure', 'type']
      .map((k) => p[k])
      .find((v) => typeof v === 'string');
    named.set(p['label-value'], { ...named.get(p['label-value']), name: name as string | undefined });
  }
  for (const c of meta?.colors ?? []) {
    if (!c.rgba) continue;
    const hex = `#${c.rgba
      .slice(0, 3)
      .map((n) => Math.round(n).toString(16).padStart(2, '0'))
      .join('')}`.toUpperCase();
    named.set(c['label-value'], { ...named.get(c['label-value']), color: hex });
  }
  if (!named.size) return labelClasses(undefined);
  const classHierarchy: Array<{ name: string; color?: string; value: number }> = [];
  const seen = new Set<string>();
  for (const [value, { name, color }] of named) {
    const cls = name ?? `label ${value}`;
    // One class per name: an instance segmentation names many values alike.
    if (!seen.has(cls)) classHierarchy.push({ name: cls, ...(color ? { color } : {}), value });
    seen.add(cls);
  }
  const labels = Object.fromEntries([...named].map(([v, { name }]) => [v, name ?? `label ${v}`]));
  return labelClasses({ classHierarchy, labels });
}

function unitToMicrons(unit: string | undefined): number {
  switch (unit?.toLowerCase()) {
    case 'nanometer':
      return 1e-3;
    case 'millimeter':
      return 1e3;
    case 'centimeter':
      return 1e4;
    case 'meter':
      return 1e6;
    default:
      return 1; // micrometer, or none said
  }
}

/** A path relative to the store, '/'-separated, without a leading './'. */
function norm(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\//, '');
}

function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}
