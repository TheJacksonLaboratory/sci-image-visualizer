import { OsdTileLoading } from './osd-tile-loading';

type Handler = () => void;

/** An OSD world item: loaded or not, shown or not, firing `fully-loaded-change` and
 *  `opacity-change` as they change. */
function item(fullyLoaded: boolean, opacity = 1) {
  const handlers = new Set<Handler>();
  return {
    loaded: fullyLoaded,
    opacity,
    getFullyLoaded() {
      return this.loaded;
    },
    getOpacity() {
      return this.opacity;
    },
    addHandler: (_: string, h: Handler) => handlers.add(h),
    removeHandler: (_: string, h: Handler) => handlers.delete(h),
    set(loaded: boolean) {
      this.loaded = loaded;
      handlers.forEach((h) => h());
    },
    setOpacity(o: number) {
      this.opacity = o;
      handlers.forEach((h) => h());
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

  it('ignores a hidden channel, which loads nothing by design, while the shown one is ready', () => {
    const shown = item(true);
    const hidden = item(false, 0); // opacity 0, not preloaded: never fully loaded
    const loading = new OsdTileLoading(viewer([shown, hidden]));
    expect(loading.text).toBe('');
    loading.destroy();
  });

  it('stops counting a channel hidden while loading, and counts it again when shown', () => {
    const channel = item(false);
    const loading = new OsdTileLoading(viewer([channel]));
    expect(loading.text).toBe('Image reloading…');
    channel.setOpacity(0);
    expect(loading.text).toBe('');
    channel.setOpacity(1); // shown again: it loads now
    expect(loading.text).toBe('Image reloading…');
    channel.set(true);
    expect(loading.text).toBe('');
    loading.destroy();
  });

  it('ignores a slice loading in the background (added hidden) until it is revealed', () => {
    const v = viewer([item(true)]);
    const loading = new OsdTileLoading(v);
    const background = item(false, 0);
    v.fire('add-item', background);
    expect(loading.text).toBe('');
    background.setOpacity(1); // scrubbed to it before its tiles are in
    expect(loading.text).toBe('Image reloading…');
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
