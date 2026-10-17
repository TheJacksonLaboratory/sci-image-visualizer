import { LoadingBadgeState } from '../napari-js/napari-loading-state';

/** What {@link OsdTileLoading} needs of a world item: OSD's `TiledImage`. */
interface LoadingItem {
  getFullyLoaded(): boolean;
  /** 0 for an item that is not shown: a hidden channel, a cached or background-loading slice. */
  getOpacity(): number;
  addHandler(event: 'fully-loaded-change' | 'opacity-change', handler: () => void): unknown;
  removeHandler(event: 'fully-loaded-change' | 'opacity-change', handler: () => void): unknown;
}

/** What it needs of the viewer. */
interface LoadingViewer {
  element: HTMLElement;
  world: {
    getItemCount(): number;
    getItemAt(i: number): unknown;
    addHandler(event: 'add-item' | 'remove-item', handler: (e: { item: unknown }) => void): unknown;
    removeHandler(event: 'add-item' | 'remove-item', handler: (e: { item: unknown }) => void): unknown;
  };
}

/**
 * "Image reloading…" over the OpenSeadragon view while it fetches the tiles of what it shows, as
 * napari's views show it for their image, cells and transcripts (the same badge). Driven by each
 * world item's own `fully-loaded-change` (an image, a stack slice, a channel), so it covers every
 * tile source alike, and shown only after a short delay, so tiles served from cache never flash it.
 *
 * Only items on screen count (opacity above 0): a hidden channel loads nothing by design (it is
 * not preloaded), so it never becomes fully loaded, and a slice cached or loading in the
 * background is not what the view shows. An item is weighed again when its opacity changes.
 */
export class OsdTileLoading {
  private readonly state = new LoadingBadgeState();
  /** Each item still loading, with the function that un-counts it. */
  private readonly loading = new Map<LoadingItem, () => void>();
  private readonly watched = new Map<LoadingItem, () => void>();

  private readonly onAdd = (e: { item: unknown }) => this.watch(e.item as LoadingItem);
  private readonly onRemove = (e: { item: unknown }) => this.unwatch(e.item as LoadingItem);

  constructor(private readonly viewer: LoadingViewer) {
    this.state.attach(viewer.element);
    viewer.world.addHandler('add-item', this.onAdd);
    viewer.world.addHandler('remove-item', this.onRemove);
    for (let i = 0; i < viewer.world.getItemCount(); i++) this.watch(viewer.world.getItemAt(i) as LoadingItem);
  }

  /** The badge's text (shown, or about to be). */
  get text(): string {
    return this.state.text;
  }

  destroy(): void {
    this.viewer.world.removeHandler('add-item', this.onAdd);
    this.viewer.world.removeHandler('remove-item', this.onRemove);
    for (const item of [...this.watched.keys()]) this.unwatch(item);
    this.state.reset();
  }

  private watch(item: LoadingItem | undefined): void {
    if (!item || this.watched.has(item)) return;
    const handler = () => this.set(item, this.isLoading(item));
    this.watched.set(item, handler);
    item.addHandler('fully-loaded-change', handler);
    item.addHandler('opacity-change', handler);
    handler();
  }

  private unwatch(item: LoadingItem): void {
    const handler = this.watched.get(item);
    if (handler) {
      item.removeHandler('fully-loaded-change', handler);
      item.removeHandler('opacity-change', handler);
    }
    this.watched.delete(item);
    this.set(item, false);
  }

  /** Whether the item is on screen and still fetching its tiles. */
  private isLoading(item: LoadingItem): boolean {
    const opacity = typeof item.getOpacity === 'function' ? item.getOpacity() : 1;
    return opacity > 0 && !item.getFullyLoaded();
  }

  private set(item: LoadingItem, loading: boolean): void {
    const end = this.loading.get(item);
    if (loading && !end) this.loading.set(item, this.state.begin('Image'));
    else if (!loading && end) {
      end();
      this.loading.delete(item);
    }
  }
}
