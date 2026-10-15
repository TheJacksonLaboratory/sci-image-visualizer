import { TestBed } from '@angular/core/testing';

import { IImageInfo } from '../contracts/image.contract';
import { makePolygon } from '../models/polygon-factory';
import { Rectangle, Region } from '../models/region';
import { RegionSource, RegionSourceView } from '../region-source/region-source';
import { RegionFeatureTable } from '../region-source/region-tiles';
import { RegionStore } from './region-store.service';
import { OPEN_REGION_SOURCES } from './region-source-scope';
import { VisualizerStore } from './visualizer-store.service';

const square = (x: number, y: number, s: number) => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
];

function feature(id: string, x: number, label = 'A', z?: number) {
  return {
    type: 'Feature',
    id,
    properties: { classification: { name: label, color: [255, 0, 0] }, acronym: id.toUpperCase() },
    geometry: { type: 'Polygon', coordinates: [square(x, 0, 10)], ...(z === undefined ? {} : { plane: { z } }) },
  };
}

/** A main-thread source over a GeoJSON collection, counting what it is asked. */
function tableSource(features: object[]): RegionSource & { disposed: boolean; asked: string[][] } {
  const table = RegionFeatureTable.fromGeoJson(JSON.stringify({ type: 'FeatureCollection', features }));
  const source = {
    info: table.info(),
    disposed: false,
    asked: [] as string[][],
    getTile: async (z: number, k: { level: number; gx: number; gy: number }) => table.tile(z, k.level, k.gx, k.gy),
    getFeatures: async (ids: readonly string[]) => {
      source.asked.push([...ids]);
      return table.features(ids);
    },
    getIndex: async (z: number, q: never) => table.index(z, q),
    getClassCounts: async (z: number, exclude?: readonly string[]) => table.classCounts(z, exclude),
    getClassOutlines: async (c: readonly string[], level: number, ex?: readonly string[]) =>
      table.classOutlines(c, level, ex),
    exportGeoJson: async (exclude: readonly string[], extra: readonly object[]) =>
      table.exportGeoJson(exclude, extra),
    dispose: () => {
      source.disposed = true;
    },
  };
  return source;
}

const flush = () => new Promise((r) => setTimeout(r));

function image(url: string): IImageInfo {
  return { urls: [url] } as IImageInfo;
}

describe('RegionStore region sources', () => {
  let store: RegionStore;
  let view: RegionSourceView | null;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [RegionStore, VisualizerStore] });
    store = TestBed.inject(RegionStore);
    store.setActiveImage(image('a.tif'));
    store.getRegionSourceView$().subscribe((v) => (view = v));
  });

  it('publishes the slice source as a view, and its class colours as imported ones', async () => {
    store.attachRegionSource(tableSource([feature('a', 0, 'Cortex')]));
    expect(store.hasRegionSource()).toBe(true);
    await flush();
    expect(view?.plane).toBe(0);
    expect(view?.taken.size).toBe(0);
    expect(view?.colorOf({ label: 'Cortex', color: null })).toBe('#ff0000');
    expect(store.getRegions()).toEqual([]);
  });

  it('takes features into the working set exactly once, with their id and properties', async () => {
    const source = tableSource([feature('a', 0), feature('b', 20)]);
    store.attachRegionSource(source);
    await flush();
    const ids = await store.takeSourceFeatures(['b']);
    expect(ids).toHaveLength(1);
    const [r] = store.getRegions();
    expect(r.id).toBe(ids[0]);
    expect(r.name).toBe(`shape${r.id}`);
    expect(r.sourceId).toBe('b');
    expect(r.properties).toEqual({ acronym: 'B' });
    expect(r.bounds).toBeInstanceOf(Rectangle);
    expect(view?.taken.has('b')).toBe(true);
    // Taking it again neither asks the source nor adds a region.
    expect(await store.takeSourceFeatures(['b'])).toEqual(ids);
    expect(source.asked).toEqual([['b']]);
    expect(store.getRegions()).toHaveLength(1);
  });

  it('selects taken features, adding to the selection on request', async () => {
    store.attachRegionSource(tableSource([feature('a', 0), feature('b', 20)]));
    await flush();
    await store.selectSourceFeatures(['a']);
    expect(store.getSelectedShapeIndices()).toEqual([0]);
    await store.selectSourceFeatures(['b'], true);
    expect(store.getSelectedShapeIndices()).toEqual([0, 1]);
  });

  it('keeps a taken feature out of the source after its region is deleted', async () => {
    store.attachRegionSource(tableSource([feature('a', 0)]));
    await flush();
    const [id] = await store.takeSourceFeatures(['a']);
    store.removeRegion(id);
    expect(store.getRegions()).toEqual([]);
    expect(view?.taken.has('a')).toBe(true);
  });

  it('undoes past a take: the feature goes back to the source', async () => {
    store.attachRegionSource(tableSource([feature('a', 0)]));
    await flush();
    // Gestures, so the two commits are two undo steps (not one coalesced burst).
    store.beginGesture();
    store.addRegion(
      Object.assign(new Region(), { bounds: Object.assign(new Rectangle(), { width: 5, height: 5 }) }),
    );
    store.endGesture();
    const [id] = await store.takeSourceFeatures(['a']);
    store.beginGesture();
    store.moveRegion(id, 5, 0);
    store.endGesture();
    store.undo(); // the move
    expect(store.getRegions()).toHaveLength(2);
    expect(view?.taken.has('a')).toBe(true);
    store.undo(); // the drawn region, recorded before the take
    expect(store.getRegions()).toEqual([]);
    expect(view?.taken.has('a')).toBe(false);
  });

  it('deletes source features as one undo step', async () => {
    store.attachRegionSource(tableSource([feature('a', 0), feature('b', 20)]));
    await flush();
    store.deleteSourceFeatures(['a']);
    expect(view?.taken.has('a')).toBe(true);
    expect(store.canUndo()).toBe(true);
    store.undo();
    expect(view?.taken.has('a')).toBe(false);
    store.redo();
    expect(view?.taken.has('a')).toBe(true);
  });

  it('follows the image: another image has its own source, and coming back restores the first', async () => {
    store.attachRegionSource(tableSource([feature('a', 0)]));
    await flush();
    await store.takeSourceFeatures(['a']);
    store.setActiveImage(image('b.tif'));
    await flush();
    expect(view).toBeNull();
    store.setActiveImage(image('a.tif'));
    await flush();
    expect(view?.taken.has('a')).toBe(true);
    expect(store.getRegions()[0].sourceId).toBe('a');
  });

  it('serves each slice of a stack from its plane of one z-indexed source', async () => {
    store.enterStackMode(new Map(), 0, 'combined');
    store.attachRegionSource(tableSource([feature('a', 0, 'A', 0), feature('b', 0, 'A', 1)]), 'planes');
    await flush();
    expect(view?.plane).toBe(0);
    store.setDisplaySlice(1);
    await flush();
    expect(view?.plane).toBe(1);
    const [id] = await store.takeSourceFeatures(['b']);
    expect(store.getRegions().find((r) => r.id === id)?.z).toBe(1);
    store.setDisplaySlice(0);
    await flush();
    expect(view?.taken.size).toBe(0);
  });

  it('opens per-slice sources lazily and closes the least recently shown', async () => {
    store.enterStackMode(new Map(), 0, 'per-slice-file');
    const sources = Array.from({ length: OPEN_REGION_SOURCES + 2 }, (_, z) => tableSource([feature(`s${z}`, 0)]));
    const opened: number[] = [];
    sources.forEach((s, z) =>
      store.attachRegionSource(
        async () => {
          opened.push(z);
          return s;
        },
        { slice: z },
      ),
    );
    await flush();
    expect(opened).toEqual([0]);
    for (let z = 1; z < sources.length; z++) {
      store.setDisplaySlice(z);
      await flush();
    }
    expect(opened).toEqual(sources.map((_, z) => z));
    expect(sources[0].disposed).toBe(true);
    expect(sources[1].disposed).toBe(true);
    expect(sources[2].disposed).toBe(false);
    store.setDisplaySlice(0);
    await flush();
    expect(opened[opened.length - 1]).toBe(0);
    expect(view?.source).toBe(sources[0]);
  });

  it('drops a take that resolves after the slice changed', async () => {
    store.enterStackMode(new Map(), 0, 'per-slice-file');
    store.attachRegionSource(tableSource([feature('a', 0)]), { slice: 0 });
    await flush();
    const pending = store.takeSourceFeatures(['a']);
    store.setDisplaySlice(1);
    expect(await pending).toEqual([]);
    expect(store.getRegions()).toEqual([]);
  });

  it("takes nothing from the outgoing slice's source while the incoming one opens", async () => {
    store.enterStackMode(new Map(), 0, 'per-slice-file');
    // Both slices' sources have a feature 'a', in different places.
    store.attachRegionSource(tableSource([feature('a', 0)]), { slice: 0 });
    let open!: (s: RegionSource) => void;
    const next = tableSource([feature('a', 50)]);
    store.attachRegionSource(() => new Promise<RegionSource>((r) => (open = r)), { slice: 1 });
    await flush();
    expect(view?.plane).toBe(0);
    store.setDisplaySlice(1);
    // The outgoing view is gone at once: nothing can be taken from it into slice 1.
    expect(view).toBeNull();
    expect(await store.selectSourceFeatures(['a'])).toEqual([]);
    store.deleteSourceFeatures(['a']);
    open(next);
    await flush();
    expect(view?.source).toBe(next);
    expect(view?.taken.size).toBe(0);
    const [id] = await store.takeSourceFeatures(['a']);
    expect((store.getRegions().find((r) => r.id === id)?.bounds as Rectangle).x).toBe(50);
  });

  it('keeps the labels the user turned off when the same source shows again', async () => {
    const plain = tableSource([feature('a', 0)]);
    const source = { ...plain, info: { ...plain.info, style: { labels: true } } };
    store.enterStackMode(new Map(), 0, 'combined');
    store.attachRegionSource(source, 'planes');
    await flush();
    expect(view?.labels).toBe(true);
    store.setShowShapeLabel(false);
    store.setDisplaySlice(1);
    await flush();
    expect(view?.source).toBe(source);
    expect(view?.labels).toBe(false);
  });

  it('detaches the image sources', async () => {
    const source = tableSource([feature('a', 0)]);
    store.attachRegionSource(source);
    await flush();
    store.detachRegionSources();
    await flush();
    expect(view).toBeNull();
    expect(store.hasRegionSource()).toBe(false);
    expect(source.disposed).toBe(true);
  });

  it('recolours the view when the class colours change', async () => {
    store.attachRegionSource(tableSource([feature('a', 0, 'Cortex')]));
    await flush();
    const before = view;
    TestBed.inject(VisualizerStore).upsertClass({ name: 'Cortex', color: '#00FF00' });
    expect(view).not.toBe(before);
    expect(view?.colorOf({ label: 'Cortex', color: null })).toBe('#00FF00');
  });

  it('lists the source without what was taken', async () => {
    store.attachRegionSource(tableSource([feature('a', 0), feature('b', 20), feature('c', 40)]));
    await flush();
    await store.takeSourceFeatures(['b']);
    const page = await store.getRegionSourceIndex({ offset: 0, limit: 10 });
    expect(page.rows.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('exports the source through the working set: untaken features, then the regions', async () => {
    store.attachRegionSource(tableSource([feature('a', 0), feature('b', 20), feature('c', 40)]));
    await flush();
    const [id] = await store.takeSourceFeatures(['b']);
    store.moveRegion(id, 100, 0);
    store.deleteSourceFeatures(['c']);
    const out = JSON.parse(await store.getGeoJsonWithSource(store.getRegions()));
    expect(out.features.map((f: { id: string }) => f.id)).toEqual(['a', 'b']);
    const moved = out.features[1];
    expect(moved.geometry.coordinates[0][0]).toEqual([120, 0]);
    expect(moved.properties.acronym).toBe('B');
  });

  it('exports plain regions as before without a source', async () => {
    const out = JSON.parse(await store.getGeoJsonWithSource([]));
    expect(out).toEqual({ features: [], type: 'FeatureCollection' });
  });

  it('re-writes a folder-stack slice whose source lost features', async () => {
    store.enterStackMode(new Map(), 0, 'per-slice-file');
    store.attachRegionSource(tableSource([feature('a', 0)]), { slice: 3 });
    store.setDisplaySlice(3);
    await flush();
    store.deleteSourceFeatures(['a']);
    expect(Array.from(store.getStackSaveSlices().keys())).toEqual([3]);
    const out = JSON.parse(await store.getGeoJsonWithSource([], 3));
    expect(out.features).toEqual([]);
  });

  it('exports a z-indexed source over every slice, without what any slice took', async () => {
    store.enterStackMode(new Map(), 0, 'combined');
    store.attachRegionSource(tableSource([feature('a', 0, 'A', 0), feature('b', 0, 'A', 1)]), 'planes');
    store.setDisplaySlice(1);
    await flush();
    store.deleteSourceFeatures(['b']);
    store.setDisplaySlice(0);
    await flush();
    const out = JSON.parse(await store.getGeoJsonWithSource(store.getSliceRegions()));
    expect(out.features.map((f: { id: string }) => f.id)).toEqual(['a']);
  });

  it("drops the slice's own source for regions imported in its place, and keeps the other slices'", async () => {
    store.enterStackMode(new Map(), 0, 'per-slice-file');
    const kept = tableSource([feature('k', 0)]);
    const replaced = tableSource([feature('a', 0), feature('b', 20)]);
    store.attachRegionSource(kept, { slice: 0 });
    store.attachRegionSource(replaced, { slice: 1 });
    store.setDisplaySlice(1);
    await flush();
    await store.dropSliceRegionSource();
    store.setRegions([]);
    await flush();
    expect(view).toBeNull();
    expect(replaced.disposed).toBe(true);
    expect(JSON.parse(await store.getGeoJsonWithSource(store.getRegions(), 1)).features).toEqual([]);
    store.setDisplaySlice(0);
    await flush();
    expect(view?.source).toBe(kept);
  });

  it("takes a slice's features out of a z-indexed source for regions imported in its place", async () => {
    store.enterStackMode(new Map(), 0, 'combined');
    store.attachRegionSource(
      tableSource([feature('a', 0, 'A', 0), feature('b', 0, 'A', 1), feature('c', 20, 'A', 1)]),
      'planes',
    );
    store.setDisplaySlice(1);
    await flush();
    await store.dropSliceRegionSource();
    expect([...(view?.taken ?? [])].sort()).toEqual(['b', 'c']);
    expect(store.hasRegionSource()).toBe(true); // slice 0 still draws 'a'
    const out = JSON.parse(await store.getGeoJsonWithSource(store.getSliceRegions()));
    expect(out.features.map((f: { id: string }) => f.id)).toEqual(['a']);
  });

  it('counts the classes still in the source and selects whole classes', async () => {
    store.attachRegionSource(tableSource([feature('a', 0, 'X'), feature('b', 20, 'X'), feature('c', 40, 'Y')]));
    await flush();
    expect(await store.getRegionSourceClassCounts()).toEqual({ X: 2, Y: 1 });
    const ids = await store.selectClasses(['X']);
    expect(ids).toHaveLength(2);
    expect(store.getRegions().map((r) => r.sourceId)).toEqual(['a', 'b']);
    expect(store.getSelectedShapeIndices()).toEqual([0, 1]);
    expect(await store.getRegionSourceClassCounts()).toEqual({ Y: 1 });
    await store.selectClasses(['Y'], true);
    expect(store.getSelectedShapeIndices()).toEqual([0, 1, 2]);
  });

  it("applies the source's style hint, and the user's choice over it", async () => {
    const styled = tableSource([feature('a', 0)]);
    (styled.info as { style?: object }).style = { fillOpacity: 0.8, labels: true, stroke: '#222' };
    store.attachRegionSource(styled);
    await flush();
    expect(store.getRegionStyle()).toEqual({
      fillOpacity: 0.8,
      stroke: '#222',
      strokeWidth: null,
      highlight: null,
    });
    expect(store.getShowShapeLabel()).toBe(true);
    expect(view?.style.fillOpacity).toBe(0.8);
    expect(view?.labels).toBe(true);
    store.setRegionStyle({ fillOpacity: 0 });
    expect(store.getRegionStyle().fillOpacity).toBe(0);
    expect(view?.style.fillOpacity).toBe(0);
    store.setActiveImage(image('b.tif'));
    await flush();
    expect(store.getRegionStyle()).toEqual({ fillOpacity: 0, stroke: null, strokeWidth: null, highlight: null });
  });

  it('reconstructs classes in 3D across the slices of a z-indexed source and the drawn regions', async () => {
    const big = (id: string, z: number, label = 'A') => ({
      type: 'Feature',
      id,
      properties: { classification: { name: label } },
      geometry: { type: 'Polygon', coordinates: [square(0, 0, 40).map(([x, y]) => [x * 1, y * 1])], plane: { z } },
    });
    store.enterStackMode(new Map(), 0, 'combined');
    store.attachRegionSource(tableSource([big('a0', 0), big('a1', 1), big('b1', 1, 'B')]), 'planes');
    await flush();
    store.setDisplaySlice(2);
    await flush();
    store.addRegion(
      Object.assign(new Region(), {
        label: 'A',
        bounds: Object.assign(new Rectangle(), { x: 0, y: 0, width: 40, height: 40 }),
      }),
    );
    const [a, b] = await store.reconstructClasses(
      [
        { key: 'a', classes: ['A'] },
        { key: 'none', classes: ['Z'] },
      ],
      4,
    );
    expect(a.key).toBe('a');
    expect(a.mesh.faces.length).toBeGreaterThan(0);
    const zs = Array.from(a.mesh.vertices.filter((_, i) => i % 3 === 2));
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(-0.5);
    expect(Math.max(...zs)).toBeLessThanOrEqual(2.5);
    expect(Math.max(...zs)).toBeGreaterThan(1.5); // slice 2's drawn region is part of it
    expect(b.mesh.faces.length).toBe(0);
  });

  it('lofts a class traced as lines on each slice into a sheet (a layer boundary), with no volume', async () => {
    const line = (id: string, z: number, y: number) => ({
      type: 'Feature',
      id,
      properties: { classification: { name: 'ILM' } },
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, y],
          [50, y + 5],
          [100, y],
        ],
        plane: { z },
      },
    });
    store.enterStackMode(new Map(), 0, 'combined');
    store.attachRegionSource(tableSource([line('l0', 0, 20), line('l1', 1, 22)]), 'planes');
    await flush();
    store.setDisplaySlice(2);
    await flush();
    store.addRegion(
      Object.assign(new Region(), {
        label: 'ILM',
        bounds: makePolygon([0, 50, 100], [24, 29, 24], { closed: false }),
      }),
    );
    const [sheet] = await store.reconstructClasses([{ key: 'ilm', classes: ['ILM'] }], 10);
    expect(sheet.mesh.faces.length).toBeGreaterThan(0);
    const zs = new Set(Array.from(sheet.mesh.vertices.filter((_, i) => i % 3 === 2)));
    expect(zs).toEqual(new Set([0, 1, 2])); // the drawn line on slice 2 is part of it
    expect((await store.classVolumes(['ILM'])).get('ILM')).toBe(0);
  });

  it('reads the sources once for volumes and surfaces while regions are drawn, again once a feature is taken', async () => {
    const source = tableSource([feature('a', 0), feature('b', 20), feature('c', 40, 'B')]);
    const reads = jest.spyOn(RegionFeatureTable.prototype, 'classOutlines');
    store.attachRegionSource(source);
    await flush();
    expect(Object.fromEntries(await store.classVolumes(['A', 'B']))).toEqual({ A: 200, B: 100 });
    await store.reconstructClasses([{ key: 'A', classes: ['A'] }], 1);
    // The surface at full detail reuses the outlines the volume read.
    expect(reads.mock.calls.map(([classes]) => classes)).toEqual([['A'], ['B']]);

    // Drawing: the volumes and the surface take it in, the sources are not read again.
    store.addRegion(
      Object.assign(new Region(), {
        label: 'A',
        bounds: Object.assign(new Rectangle(), { x: 100, y: 0, width: 5, height: 4 }),
      }),
    );
    expect((await store.classVolumes(['A', 'B'])).get('A')).toBe(220);
    const [a] = await store.reconstructClasses([{ key: 'A', classes: ['A'] }], 1);
    expect(Math.max(...Array.from(a.mesh.vertices.filter((_, i) => i % 3 === 0)))).toBeGreaterThan(100);
    expect(reads).toHaveBeenCalledTimes(2);

    // Taking a feature changes what the source holds: read again, the total unchanged.
    await store.takeSourceFeatures(['b']);
    expect((await store.classVolumes(['A'])).get('A')).toBe(220);
    expect(reads).toHaveBeenCalledTimes(3);
    reads.mockRestore();
  });

  it('reads every class at once for a section, by class and slice, the drawn regions included', async () => {
    const at = (id: string, z: number, label: string, geometry: object) => ({
      type: 'Feature',
      id,
      properties: { classification: { name: label } },
      geometry: { ...geometry, plane: { z } },
    });
    const poly = { type: 'Polygon', coordinates: [square(0, 0, 10)] };
    const line = {
      type: 'LineString',
      coordinates: [
        [0, 5],
        [10, 5],
      ],
    };
    store.enterStackMode(new Map(), 0, 'combined');
    store.attachRegionSource(
      tableSource([at('a0', 0, 'A', poly), at('a1', 1, 'A', poly), at('l1', 1, 'ILM', line)]),
      'planes',
    );
    await flush();
    store.setDisplaySlice(2);
    store.addRegion(
      Object.assign(new Region(), {
        label: 'B',
        bounds: Object.assign(new Rectangle(), { x: 0, y: 0, width: 4, height: 4 }),
      }),
    );
    const byClass = await store.outlinesByClass(0);
    expect([...byClass.keys()].sort()).toEqual(['A', 'B', 'ILM']);
    expect(byClass.get('A')!.map((s) => [s.z, s.rings.length])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(byClass.get('ILM')!.map((s) => [s.z, s.rings.length, s.lines?.length])).toEqual([[1, 0, 1]]);
    expect(byClass.get('B')!.map((s) => s.z)).toEqual([2]);
  });
});
