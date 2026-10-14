import { TestBed } from '@angular/core/testing';

import { IImageInfo } from '../contracts/image.contract';
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
});
