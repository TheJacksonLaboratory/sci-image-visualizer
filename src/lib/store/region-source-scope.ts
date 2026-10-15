import type { RegionSource } from '../region-source/region-source';

/** Opens a region source on demand (and again after it was closed to save memory). */
export type RegionSourceOpener = () => Promise<RegionSource>;

/** Which slices a source serves: one slice (plane `plane` of the source), or every slice z
 *  from the source's plane z (a z-indexed GeoJSON over a whole stack). */
export type RegionSourceSlices = { slice: number; plane?: number } | 'planes';

/** The region source behind one slice: the source and which of its planes the slice shows. */
export interface RegionSourceBinding {
  source: RegionSource;
  plane: number;
}

/** Sources held open, past which the least recently used one is closed (never the one shown). */
export const OPEN_REGION_SOURCES = 6;

interface Entry {
  open: RegionSourceOpener;
  /** The plane each slice shows; undefined = the slice's own index. */
  plane?: number;
  source: Promise<RegionSource> | null;
  /** The resolved source, once open. */
  ready: RegionSource | null;
}

interface ImageSources {
  /** The source over every slice (`'planes'`), if any. */
  planes: Entry | null;
  perSlice: Map<number, Entry>;
  /** Source feature ids taken into the working set (or deleted), per slice. */
  taken: Map<number, ReadonlySet<string>>;
}

const NONE: ReadonlySet<string> = new Set<string>();

/**
 * The region sources of every image the store has seen, per slice, and per slice the ids of
 * the source features taken out of the source (into the working set, or deleted) — those the
 * source no longer draws and an export leaves out.
 *
 * Sources open lazily, the first time their slice is shown or read, and at most
 * {@link OPEN_REGION_SOURCES} stay open: the least recently used are closed and re-opened from
 * their opener when used again (a source's ids are stable, so what was taken stays taken). The
 * source of the slice on screen ({@link show}) is never closed for another: a read across every
 * slice must not close the source the viewer draws and takes from.
 */
export class RegionSourceScope {
  private readonly images = new Map<string, ImageSources>();
  /** Open entries, least recently used first. */
  private readonly openOrder: Entry[] = [];
  /** The entry of the slice on screen: kept open. */
  private shown: Entry | null = null;

  /** Attach `open` to `image` for `slices`, replacing (and closing) what was there. */
  attach(image: string, open: RegionSourceOpener, slices: RegionSourceSlices): void {
    const sources = this.imageSources(image);
    const entry: Entry = { open, source: null, ready: null };
    if (slices === 'planes') {
      if (sources.planes) this.close(sources.planes);
      sources.planes = entry;
      sources.perSlice.forEach((e) => this.close(e));
      sources.perSlice.clear();
      sources.taken.clear();
    } else {
      const old = sources.perSlice.get(slices.slice);
      if (old) this.close(old);
      entry.plane = slices.plane ?? 0;
      sources.perSlice.set(slices.slice, entry);
      sources.taken.delete(slices.slice);
    }
  }

  /** Drop every source of `image` (closing the open ones) and what was taken from them. */
  detachImage(image: string): void {
    const sources = this.images.get(image);
    if (!sources) return;
    if (sources.planes) this.close(sources.planes);
    sources.perSlice.forEach((e) => this.close(e));
    this.images.delete(image);
  }

  /** Drop the source of one slice of `image`. */
  detachSlice(image: string, slice: number): void {
    const sources = this.images.get(image);
    const entry = sources?.perSlice.get(slice);
    if (!sources || !entry) return;
    this.close(entry);
    sources.perSlice.delete(slice);
    sources.taken.delete(slice);
  }

  /** The slice on screen (null: none): its source stays open while others are read. */
  show(image: string | undefined, slice: number | null): void {
    this.shown = image && slice !== null ? this.entry(image, slice) : null;
  }

  /** Whether `image` has a source for `slice`. */
  has(image: string | undefined, slice: number): boolean {
    return !!image && !!this.entry(image, slice);
  }

  /** Whether `slice` of `image` has a source of its own (not a `'planes'` source's plane). */
  hasOwnSource(image: string | undefined, slice: number): boolean {
    return !!image && !!this.images.get(image)?.perSlice.has(slice);
  }

  /** Every slice of `image` with a source of its own (not counting a `'planes'` source). */
  slicesWithSource(image: string | undefined): number[] {
    if (!image) return [];
    return Array.from(this.images.get(image)?.perSlice.keys() ?? []).sort((a, b) => a - b);
  }

  /** Whether `image` has one source over all its slices. */
  hasPlanesSource(image: string | undefined): boolean {
    return !!image && !!this.images.get(image)?.planes;
  }

  /**
   * The source behind `slice` of `image`, opening it if needed. Resolves null when there is
   * none, and rejects when it cannot be opened.
   */
  async binding(image: string | undefined, slice: number): Promise<RegionSourceBinding | null> {
    const entry = image ? this.entry(image, slice) : null;
    if (!entry) return null;
    const source = await this.openEntry(entry);
    return { source, plane: entry.plane ?? slice };
  }

  /** The ids taken from `slice`'s source. */
  taken(image: string | undefined, slice: number): ReadonlySet<string> {
    return (image && this.images.get(image)?.taken.get(slice)) || NONE;
  }

  /** Every id taken from any slice of `image` (a `'planes'` source's ids are unique across them). */
  allTaken(image: string | undefined): string[] {
    const taken = image ? this.images.get(image)?.taken : undefined;
    return taken ? Array.from(taken.values()).flatMap((ids) => Array.from(ids)) : [];
  }

  /** The slices of `image` with anything taken from their source. */
  slicesWithTaken(image: string | undefined): number[] {
    const taken = image ? this.images.get(image)?.taken : undefined;
    return taken ? Array.from(taken.keys()) : [];
  }

  /** Replace the ids taken from `slice`'s source (copy-on-write: `ids` is kept as given). */
  setTaken(image: string | undefined, slice: number, ids: ReadonlySet<string>): void {
    if (!image) return;
    const sources = this.images.get(image);
    if (!sources) return;
    if (ids.size) sources.taken.set(slice, ids);
    else sources.taken.delete(slice);
  }

  private entry(image: string, slice: number): Entry | null {
    const sources = this.images.get(image);
    return sources?.perSlice.get(slice) ?? sources?.planes ?? null;
  }

  private imageSources(image: string): ImageSources {
    let sources = this.images.get(image);
    if (!sources) {
      sources = { planes: null, perSlice: new Map(), taken: new Map() };
      this.images.set(image, sources);
    }
    return sources;
  }

  private openEntry(entry: Entry): Promise<RegionSource> {
    const at = this.openOrder.indexOf(entry);
    if (at >= 0) this.openOrder.splice(at, 1);
    this.openOrder.push(entry);
    if (!entry.source) {
      const opening = entry.open();
      entry.source = opening;
      opening.then(
        (source) => {
          if (entry.source === opening) entry.ready = source;
          else source.dispose(); // closed while it opened
        },
        () => {
          if (entry.source === opening) entry.source = null; // try again next time
        },
      );
    }
    while (this.openOrder.length > OPEN_REGION_SOURCES) {
      const [oldest] = this.openOrder.splice(
        this.openOrder.findIndex((e) => e !== this.shown),
        1,
      );
      this.closeSource(oldest);
    }
    return entry.source;
  }

  private close(entry: Entry): void {
    const at = this.openOrder.indexOf(entry);
    if (at >= 0) this.openOrder.splice(at, 1);
    this.closeSource(entry);
  }

  private closeSource(entry: Entry): void {
    entry.ready?.dispose();
    entry.ready = null;
    entry.source = null;
  }
}
