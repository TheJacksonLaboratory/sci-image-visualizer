import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { gunzipSync, inflateSync } from 'zlib';

import { importFile, RegionImportFile } from './region-import';
import { hasZarrMetadata, readOmeZarrLabels } from './ome-zarr-labels';

const inflate = async (b: Uint8Array, format: 'gzip' | 'deflate') =>
  new Uint8Array(format === 'gzip' ? gunzipSync(b) : inflateSync(b));

/** A fixture store's files as a folder pick names them (fixtures/make_ome_zarr_labels.py). */
function store(name: string): RegionImportFile[] {
  const root = join(__dirname, 'fixtures');
  const out: RegionImportFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(importFile(new Uint8Array(readFileSync(path)), relative(root, path)));
    }
  };
  walk(join(root, name));
  return out;
}

/** What the fixture's labels are (see make_ome_zarr_labels.py). */
function expected(z: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 8; x++) {
      out.push(
        z === 2 && y === 5 ? 70000 : z === 0 && x === 0 ? 0 : 1 + Math.floor(x / 3) + 10 * Math.floor(y / 3),
      );
    }
  }
  return out;
}

describe.each([
  ['NGFF 0.4 on zarr v2, Blosc lz4', 'cells-v04.ome.zarr', [0.5, 0.5, 2]],
  ['NGFF 0.5 on zarr v3, zstd', 'cells-v05.ome.zarr', [1, 1, 1]],
])('readOmeZarrLabels (%s)', (_, name, spacing) => {
  it('finds the label image, not the image it labels, and reads every slice across its chunks', async () => {
    const files = store(name);
    expect(hasZarrMetadata(files)).toBe(true);
    const labels = await readOmeZarrLabels(files, inflate);
    expect(labels?.name).toBe('cells');
    const stack = labels!.stack;
    expect([stack.width, stack.height, stack.slices]).toEqual([8, 6, 3]);
    expect(stack.spacing).toEqual(spacing);
    for (const z of [0, 1, 2]) expect(Array.from(await stack.labels(z))).toEqual(expected(z));
  });

  it('names and colours the classes its image-label metadata gives, and leaves the rest unnamed', async () => {
    const { classes } = (await readOmeZarrLabels(store(name), inflate))!;
    expect(classes.classOf(1)).toEqual(expect.objectContaining({ name: 'Nucleus', color: '#FF0000' }));
    expect(classes.classOf(70000)).toEqual(expect.objectContaining({ name: 'Membrane', color: '#0000FF' }));
    expect(classes.classOf(12).name).toBe('label 12');
  });
});

describe('readOmeZarrLabels', () => {
  it('is null for a store without a label image', async () => {
    const files = store('cells-v04.ome.zarr').filter((f) => !f.name.includes('/labels/'));
    expect(await readOmeZarrLabels(files, inflate)).toBeNull();
  });

  it('reads a missing chunk as the fill value', async () => {
    const files = store('cells-v04.ome.zarr').filter((f) => !/labels\/cells\/0\/1\/0\/0$/.test(f.name));
    const slice = Array.from(await (await readOmeZarrLabels(files, inflate))!.stack.labels(1));
    expect(slice.slice(0, 4)).toEqual([0, 0, 0, 0]); // chunk (1, 0, 0) is gone
    expect(slice.slice(4, 8)).toEqual(expected(1).slice(4, 8));
  });
});

describe('readOmeZarrLabels, slices read at once', () => {
  /**
   * An uncompressed uint8 label store in memory: `slices` slices of 1 x `width`, chunked one voxel
   * a chunk, voxel (z, x) = 10 * (z + 1) + x; `hold` names chunk files whose reads wait for release.
   */
  function memoryStore(slices: number, width: number, hold: Set<string>) {
    const waiting = new Map<string, () => void>();
    const files: RegionImportFile[] = [
      importFile(
        JSON.stringify({ 'image-label': {}, multiscales: [{ axes: ['z', 'y', 'x'], datasets: [{ path: '0' }] }] }),
        'labels/a/.zattrs',
      ),
      importFile(
        JSON.stringify({
          shape: [slices, 1, width],
          chunks: [1, 1, 1],
          dtype: '|u1',
          compressor: null,
          fill_value: 0,
          order: 'C',
        }),
        'labels/a/0/.zarray',
      ),
    ];
    for (let z = 0; z < slices; z++) {
      for (let x = 0; x < width; x++) {
        const name = `labels/a/0/${z}.0.${x}`;
        const data = new Uint8Array([10 * (z + 1) + x]);
        files.push({
          name,
          text: async () => '',
          bytes: () =>
            hold.has(name)
              ? new Promise<Uint8Array>((resolve) => waiting.set(name, () => resolve(data)))
              : Promise.resolve(data),
        });
      }
    }
    return { files, release: (name: string) => waiting.get(name)?.() };
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  it.each([
    ['one chunk a slice', 1],
    ['a slice across several chunks', 2],
  ])('keeps a read on its own chunk layer while another layer is read (%s)', async (_, width) => {
    const store = memoryStore(2, width, new Set(['labels/a/0/0.0.0']));
    const { stack } = (await readOmeZarrLabels(store.files))!;
    const first = stack.labels(0); // waits on its first chunk
    await tick();
    expect(Array.from(await stack.labels(1))).toEqual(Array.from({ length: width }, (_, x) => 20 + x));
    store.release('labels/a/0/0.0.0');
    expect(Array.from(await first)).toEqual(Array.from({ length: width }, (_, x) => 10 + x));
  });

  it('reads a chunk again after it failed to decode', async () => {
    const store = memoryStore(1, 1, new Set());
    let fail = true;
    const chunk = store.files.find((f) => f.name.endsWith('0.0.0'))!;
    const ok = chunk.bytes;
    chunk.bytes = () => (fail ? Promise.reject(new Error('network')) : ok());
    const { stack } = (await readOmeZarrLabels(store.files))!;
    await expect(stack.labels(0)).rejects.toThrow('network');
    fail = false;
    expect(Array.from(await stack.labels(0))).toEqual([10]);
  });
});

describe('readOmeZarrLabels, chunk contents', () => {
  /** A one-image label store in memory: `zarray` its array metadata, `chunks` its chunk files. */
  const store = (zarray: object, chunks: Record<string, Uint8Array>) => [
    importFile(
      JSON.stringify({ 'image-label': {}, multiscales: [{ axes: ['z', 'y', 'x'], datasets: [{ path: '0' }] }] }),
      'labels/a/.zattrs',
    ),
    importFile(JSON.stringify({ fill_value: 0, order: 'C', compressor: null, ...zarray }), 'labels/a/0/.zarray'),
    ...Object.entries(chunks).map(([key, data]) => importFile(data, `labels/a/0/${key}`)),
  ];

  it('reads an edge chunk, which zarr stores whole (padded), along x as along y', async () => {
    // Width 3 in chunks of 2: the second chunk holds x = 2 and a padding voxel.
    const files = store(
      { shape: [1, 1, 3], chunks: [1, 1, 2], dtype: '|u1' },
      { '0.0.0': new Uint8Array([1, 2]), '0.0.1': new Uint8Array([3, 0]) },
    );
    expect(Array.from(await (await readOmeZarrLabels(files))!.stack.labels(0))).toEqual([1, 2, 3]);
  });

  it('reads 64-bit labels that fit 32 bits, and refuses one that does not rather than narrow it', async () => {
    const u64 = (v: bigint) => {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigUint64(0, v, true);
      return b;
    };
    const fits = store({ shape: [1, 1, 1], chunks: [1, 1, 1], dtype: '<u8' }, { '0.0.0': u64(4294967295n) });
    expect(Array.from(await (await readOmeZarrLabels(fits))!.stack.labels(0))).toEqual([4294967295]);
    const wide = store({ shape: [1, 1, 1], chunks: [1, 1, 1], dtype: '<u8' }, { '0.0.0': u64(4294967296n + 5n) });
    await expect((await readOmeZarrLabels(wide))!.stack.labels(0)).rejects.toThrow(/does not fit 32 bits/);
  });
});
