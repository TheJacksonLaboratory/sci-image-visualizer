import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { gunzipSync, inflateSync } from 'zlib';
import { decode as decodePng } from 'fast-png';

import { importFile, RegionImportFile } from './region-import';
import type { RegionSource } from '../region-source/region-source';
import { openAnnotations, readAnnotationSlices, splitByPlane } from './open-annotations';

const decoders = {
  inflate: async (b: Uint8Array, format: 'gzip' | 'deflate') =>
    new Uint8Array(format === 'gzip' ? gunzipSync(b) : inflateSync(b)),
  gunzip: async (b: Uint8Array) => new Uint8Array(gunzipSync(b)),
};
const enc = (s: string) => new TextEncoder().encode(s);

/** The blobs behind the blob URLs made (jsdom has no object URLs). */
const blobs = new Map<string, Blob>();
let made = 0;
beforeAll(() => {
  Object.assign(URL, {
    createObjectURL: (b: Blob) => {
      const url = `blob:test/${++made}`;
      blobs.set(url, b);
      return url;
    },
    revokeObjectURL: (url: string) => blobs.delete(url),
  });
});

/** A blob URL's PNG, decoded (jsdom's Blob has no arrayBuffer: through a FileReader). */
async function pixels(url: string) {
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blobs.get(url) as Blob);
  });
  return decodePng(new Uint8Array(buffer));
}

/** A 3 x 2 x 2 (sections x height x width) uint16 NRRD atlas: section z holds labels 1 (left
 *  column) and 2 (right), but section 1 is all 3; 200 um sections of 25 um pixels. */
function atlas(): RegionImportFile[] {
  const sizes = [3, 2, 2];
  const data = new Uint8Array(3 * 2 * 2 * 2);
  const view = new DataView(data.buffer);
  for (let x = 0; x < 2; x++)
    for (let y = 0; y < 2; y++)
      for (let z = 0; z < 3; z++) {
        view.setUint16(2 * (z + 3 * (y + 2 * x)), z === 1 ? 3 : x + 1, true);
      }
  const head =
    `NRRD0004\ntype: uint16\ndimension: 3\nsizes: ${sizes.join(' ')}\nencoding: raw\nendian: little\n` +
    'space directions: (200,0,0) (0,25,0) (0,0,25)\n\n';
  const volume = new Uint8Array([...enc(head), ...data]);
  const regionset = {
    classHierarchy: [
      { name: 'CTX', title: 'Cortex', color: '#ff0000', value: 1 },
      { name: 'HPF', title: 'Hippocampal formation', color: '#00ff00', value: 2, parent: 'CTX' },
      { name: 'MB', color: '#0000ff', value: 3 },
    ],
  };
  return [
    importFile(volume, 'atlas/annotation.nrrd'),
    importFile(JSON.stringify(regionset), 'atlas/regionset.json'),
  ];
}

describe('openAnnotations', () => {
  it('opens a label volume by itself: its slices in gray levels, traced as regions in their colours', async () => {
    const opened = await openAnnotations(atlas(), decoders);
    const { info } = opened;
    expect(info.trueImageSize).toEqual([2, 2]);
    expect(info.isStack).toBe(true);
    expect(info.urls).toHaveLength(3);
    expect(info.tiled).toBe(false);
    // Grayscale, so the Volume and Isosurface views take it.
    expect(info.isGrayscale).toBe(true);
    expect(info.imageMeta[0]).toEqual(
      expect.objectContaining({ x: 2, y: 2, z: 3, mppX: 25, mppY: 25, mppZ: 200, rgbChannels: 1 }),
    );
    expect(info.initialZIndex).toBe(1);
    expect(opened.summary).toBe('3 slices of 2 × 2, 2 × 2');

    const slice0 = await pixels(info.urls[0]);
    expect([slice0.width, slice0.height, slice0.channels]).toEqual([2, 2, 1]);
    // Each structure at its colour's luminance: CTX (red) 76, HPF (green) 150; MB (blue) 29.
    expect(Array.from(slice0.data.slice(0, 2))).toEqual([76, 150]);
    expect((await pixels(info.urls[1])).data[0]).toBe(29);

    const source = await info.regionSlices!.get(0)!();
    const counts = await source.getClassCounts(0);
    expect(counts).toEqual({ CTX: 1, HPF: 1 });
    expect(source.info.hierarchy?.find((n) => n.name === 'HPF')?.parent).toBe('CTX');
    // Drawn over the label image itself, the regions are outlined dark (its regionset names no style).
    expect(source.info.style?.stroke).toBe('#3c3c3c');
    source.dispose();

    opened.dispose();
    expect(info.urls.every((u) => !blobs.has(u))).toBe(true);
  });

  it("opens an OME-Zarr store's label image (fixtures/make_ome_zarr_labels.py)", async () => {
    const root = join(__dirname, 'fixtures');
    const files: RegionImportFile[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(importFile(new Uint8Array(readFileSync(p)), relative(root, p)));
      }
    };
    walk(join(root, 'cells-v04.ome.zarr'));
    const { info } = await openAnnotations(files, decoders);
    expect(info.trueImageSize).toEqual([8, 6]);
    expect(info.urls).toHaveLength(3);
    expect(info.imageMeta[0]).toEqual(expect.objectContaining({ mppX: 0.5, mppZ: 2 }));
    expect(info.fileName).toMatch(/^cells · annotations \[\d+\]$/);
    // Label 1 (x 0..2 of rows 0..2) is Nucleus, red (luminance 76); slice 0's first column is background.
    expect((await pixels(info.urls[1])).data[0]).toBe(76);
    expect((await pixels(info.urls[0])).data[0]).toBe(0);
    // A slice's source holds its regions on plane 0 (the slice's own).
    const counts = await (await info.regionSlices!.get(2)!()).getClassCounts(0);
    expect(counts['Membrane']).toBe(1);
  });

  it('opens a folder of per-slice GeoJSON on a blank stack as large as its regions reach', async () => {
    const square = (x: number, y: number, s: number) => ({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [x, y],
            [x + s, y],
            [x + s, y + s],
            [x, y + s],
            [x, y],
          ],
        ],
      },
      properties: { classification: { name: 'Tumor', color: [200, 0, 0] } },
    });
    const files = [0, 1].map((z) =>
      importFile(
        JSON.stringify({ type: 'FeatureCollection', features: [square(10, 20, 30 + 40 * z)] }),
        `roi/slice_${z}.geojson`,
      ),
    );
    const { info } = await openAnnotations([
      ...files,
      importFile('{"classHierarchy":[{"name":"Tumor"}]}', 'roi/regionset.json'),
    ]);
    expect(info.trueImageSize).toEqual([80, 90]);
    expect(info.isGrayscale).toBe(true);
    expect(info.urls).toHaveLength(2);
    const blank = await pixels(info.urls[1]);
    expect([blank.width, blank.height, blank.channels]).toEqual([80, 90, 1]);
    // The sources measured are handed over, not parsed again.
    const first = await info.regionSlices!.get(1)!();
    expect(first.info.bounds).toEqual([10, 20, 80, 90]);
  });

  it('refuses regions too large to show without their image, and files with no annotations', async () => {
    const huge = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] } },
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [20000, 9000],
            ],
          },
          properties: {},
        },
      ],
    };
    await expect(openAnnotations([importFile(JSON.stringify(huge), 'slide.geojson')])).rejects.toThrow(
      /20000 × 9000/,
    );
    await expect(openAnnotations([importFile('x', 'notes.txt')])).rejects.toThrow(/Choose a label volume/);
  });
});

describe('openAnnotations, the sources it measures', () => {
  /** A region source of `bounds` whose disposal is recorded. */
  const fake = (bounds: [number, number, number, number]) =>
    ({ info: { bounds, planes: [0] }, dispose: jest.fn() }) as unknown as RegionSource & { dispose: jest.Mock };
  const slices = (n: number) =>
    Array.from({ length: n }, (_, z) =>
      importFile('{"type":"FeatureCollection","features":[]}', `roi/s_${z}.geojson`),
    );

  it('releases them when the regions are too large to show', async () => {
    const opened = [fake([0, 0, 100, 100]), fake([0, 0, 20000, 9000])];
    let i = 0;
    const openGeoJson = async () => opened[i++];
    await expect(openAnnotations(slices(2), { openGeoJson })).rejects.toThrow(
      /more than 8192 on a side: open the image they were drawn on, and import them onto it/,
    );
    expect(opened.map((s) => s.dispose.mock.calls.length)).toEqual([1, 1]);
  });

  it('releases the ones already open when a later slice fails to open', async () => {
    const first = fake([0, 0, 10, 10]);
    let i = 0;
    const openGeoJson = async () => {
      if (i++ === 0) return first;
      throw new Error('bad slice');
    };
    await expect(openAnnotations(slices(2), { openGeoJson })).rejects.toThrow('bad slice');
    expect(first.dispose).toHaveBeenCalledTimes(1);
  });

  it('hands a source to the store once, and releases on dispose only those the store never took', async () => {
    const opened = [fake([0, 0, 10, 10]), fake([0, 0, 20, 20])];
    let i = 0;
    const openGeoJson = async () => opened[i++] ?? fake([0, 0, 1, 1]);
    const result = await openAnnotations(slices(2), { openGeoJson });
    expect(await result.info.regionSlices!.get(0)!()).toBe(opened[0]); // the store takes slice 0's
    result.dispose();
    expect(opened[0].dispose).not.toHaveBeenCalled(); // the store's now
    expect(opened[1].dispose).toHaveBeenCalledTimes(1);
  });
});

describe('readAnnotationSlices', () => {
  it('gives a label volume its size up front, so an import can warn when it differs', async () => {
    const set = await readAnnotationSlices(atlas(), decoders);
    expect(set?.kind).toBe('labels');
    expect(set?.size).toEqual([2, 2]);
    expect(set?.spacing).toEqual([25, 25, 200]);
    expect(set?.openers.size).toBe(3);
    // An import keeps the ontology's own look (none here).
    const source = await set!.openers.get(0)!();
    expect(source.info.style).toBeUndefined();
  });
});

describe('splitByPlane', () => {
  it('splits a z-indexed GeoJSON into one collection per plane, its features moved to plane 0', () => {
    const doc = {
      type: 'FeatureCollection',
      classHierarchy: [{ name: 'A' }],
      features: [
        {
          type: 'Feature',
          id: 'a',
          geometry: { type: 'Point', coordinates: [1, 1], plane: { c: -1, z: 2, t: 0 } },
        },
        { type: 'Feature', id: 'b', geometry: { type: 'Point', coordinates: [2, 2] } },
      ],
    };
    const slices = splitByPlane(JSON.stringify(doc)).map((t) => JSON.parse(t));
    expect(slices).toHaveLength(3);
    expect(slices[0].features.map((f: { id: string }) => f.id)).toEqual(['b']);
    expect(slices[1].features).toEqual([]);
    expect(slices[2].features[0]).toEqual({
      type: 'Feature',
      id: 'a',
      geometry: { type: 'Point', coordinates: [1, 1] },
    });
    expect(slices[2].classHierarchy).toEqual([{ name: 'A' }]);
  });

  it('leaves a GeoJSON on one plane as it is', () => {
    const text = '{"type":"FeatureCollection","features":[]}';
    expect(splitByPlane(text)).toEqual([text]);
  });
});
