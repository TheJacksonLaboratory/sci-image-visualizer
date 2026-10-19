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
