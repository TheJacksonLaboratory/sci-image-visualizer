import { OsdTileLoading } from './osd-tile-loading';

type Handler = (e: { fullyLoaded: boolean }) => void;

/** An OSD world item: loaded or not, firing `fully-loaded-change` as it changes. */
function item(fullyLoaded: boolean) {
  const handlers = new Set<Handler>();
  return {
    loaded: fullyLoaded,
    getFullyLoaded() {
      return this.loaded;
    },
    addHandler: (_: string, h: Handler) => handlers.add(h),
    removeHandler: (_: string, h: Handler) => handlers.delete(h),
    set(loaded: boolean) {
      this.loaded = loaded;
      handlers.forEach((h) => h({ fullyLoaded: loaded }));
    },
    handlers,
  };
}

function viewer(items: ReturnType<typeof item>[]) {
  const world = new Map<string, Set<(e: { item: unknown }) => void>>();
  const on = (event: string) => world.get(event) ?? world.set(event, new Set()).get(event)!;
  return {
    element: document.createElement('div'),
    world: {
      getItemCount: () => items.length,
      getItemAt: (i: number) => items[i],
      addHandler: (event: string, h: (e: { item: unknown }) => void) => on(event).add(h),
      removeHandler: (event: string, h: (e: { item: unknown }) => void) => on(event).delete(h),
    },
    fire: (event: string, it: unknown) => on(event).forEach((h) => h({ item: it })),
  };
}

describe('OsdTileLoading', () => {
  it("shows 'Image reloading…' while an item fetches its tiles, and nothing once all are loaded", () => {
    const a = item(false);
    const v = viewer([a]);
    const loading = new OsdTileLoading(v);
    expect(loading.text).toBe('Image reloading…');
    a.set(true);
    expect(loading.text).toBe('');
    a.set(false);
    expect(loading.text).toBe('Image reloading…');
    loading.destroy();
  });

  it('follows items added to the world (a re-open, a slice) and forgets removed ones', () => {
    const v = viewer([]);
    const loading = new OsdTileLoading(v);
    expect(loading.text).toBe('');
    const slice = item(false);
    v.fire('add-item', slice);
    expect(loading.text).toBe('Image reloading…');
    v.fire('remove-item', slice);
    expect(loading.text).toBe('');
    expect(slice.handlers.size).toBe(0);
    loading.destroy();
  });

  it('counts several items: shown until the last is loaded', () => {
    const a = item(false);
    const b = item(false);
    const loading = new OsdTileLoading(viewer([a, b]));
    a.set(true);
    expect(loading.text).toBe('Image reloading…');
    b.set(true);
    expect(loading.text).toBe('');
    loading.destroy();
  });

  it('removes its badge and listeners on destroy', () => {
    const a = item(false);
    const v = viewer([a]);
    const loading = new OsdTileLoading(v);
    expect(v.element.querySelector('.napari-loading-badge')).not.toBeNull();
    loading.destroy();
    expect(v.element.querySelector('.napari-loading-badge')).toBeNull();
    expect(a.handlers.size).toBe(0);
  });
});
