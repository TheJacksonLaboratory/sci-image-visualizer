import { IImageInfo } from '../contracts/image.contract';
import { Region } from '../models/region';
import { withRegionZ } from '../models/region-clone';

/** How a stack's regions round-trip to disk (jit-ui#93): `combined` writes one
 *  z-indexed geojson (single-file z-stack, QuPath schema); `per-slice-file`
 *  writes one geojson per slice-file (a folder of numbered images). */
export type StackSaveLayout = 'combined' | 'per-slice-file';

/**
 * Where the region store's *live* set comes from and goes back to: a per-image
 * cache (keyed by the image's first URL, else its file name) and, while a
 * z-stack is loaded, a per-slice map for the current image (jit-ui#93).
 *
 * The owner holds the live array; every method that can change scope takes
 * the current live array (to capture its edits) and returns the incoming
 * live set, or null when nothing changes. It never changes a region: slice
 * tags are applied to copies ({@link withRegionZ}).
 */
export class RegionScopeCache {
  private byImage = new Map<string, Region[]>();
  private imageKey: string | undefined;

  private bySlice = new Map<number, Region[]>();
  private stack = false;
  private sliceZ = 0;
  private layout: StackSaveLayout = 'combined';
  /** Slices loaded with regions: a per-slice-file save re-writes them even when
   *  now empty, so clearing a slice and saving removes its geojson. */
  private initialNonEmpty = new Set<number>();

  /** The cache key for an image: its first URL, else its file name. */
  static imageKey(imageInfo: IImageInfo | undefined): string | undefined {
    if (!imageInfo) return undefined;
    if (imageInfo.urls && imageInfo.urls.length > 0 && imageInfo.urls[0]) {
      return imageInfo.urls[0];
    }
    return imageInfo.fileName || undefined;
  }

  /** True while a z-stack is loaded and regions are held per slice. */
  get stackMode(): boolean {
    return this.stack;
  }

  /** The current display slice (zero-based; 0 outside stack mode unless set). */
  get displaySlice(): number {
    return this.sliceZ;
  }

  /** How the current stack persists; meaningless outside stack mode. */
  get saveLayout(): StackSaveLayout {
    return this.layout;
  }

  /** Record `live` as the current image's regions. */
  sync(live: Region[]): void {
    if (this.imageKey) this.byImage.set(this.imageKey, live.slice());
  }

  /**
   * Make `key` the active image: ends stack mode, caches `live` under the
   * outgoing image, and returns the incoming image's regions (or []). Null when
   * `key` already is the active image (repeated replots keep their regions).
   */
  switchImage(key: string | undefined, live: Region[]): Region[] | null {
    if (this.imageKey === key) return null;
    // The loader re-enters stack mode afterwards if the new image is a z-stack.
    this.exitStack();
    if (this.imageKey) this.byImage.set(this.imageKey, live.slice());
    this.imageKey = key;
    const cached = key ? this.byImage.get(key) : undefined;
    return cached ? cached.slice() : [];
  }

  /**
   * Enter per-slice mode with `slices` (already admitted by the store, each
   * region tagged with its slice) and return `initialZ`'s slice as the live set.
   */
  enterStack(slices: Map<number, Region[]>, initialZ: number, layout: StackSaveLayout): Region[] {
    this.stack = true;
    this.layout = layout;
    this.sliceZ = initialZ || 0;
    this.bySlice = new Map<number, Region[]>();
    this.initialNonEmpty = new Set<number>();
    for (const [z, regs] of slices) {
      this.bySlice.set(z, regs);
      if (regs.length) this.initialNonEmpty.add(z);
    }
    return (this.bySlice.get(this.sliceZ) ?? []).slice();
  }

  /** Leave stack mode; a no-op outside it. */
  exitStack(): void {
    if (!this.stack) return;
    this.stack = false;
    this.sliceZ = 0;
    this.bySlice = new Map<number, Region[]>();
    this.initialNonEmpty = new Set<number>();
  }

  /**
   * Show slice `z`: capture `live` into the current slice and return slice
   * `z`'s regions. Null when nothing swaps — the same slice, or outside stack
   * mode (where the index is only recorded).
   */
  showSlice(z: number, live: Region[]): Region[] | null {
    const next = z || 0;
    if (!this.stack) {
      this.sliceZ = next;
      return null;
    }
    if (this.sliceZ === next) return null;
    this.bySlice.set(this.sliceZ, live.slice());
    this.sliceZ = next;
    return (this.bySlice.get(next) ?? []).slice();
  }

  /** Every slice's regions (current one from `live`), each tagged with its z,
   *  in slice order; `live` itself outside stack mode. */
  sliceRegions(live: Region[]): Region[] {
    if (!this.stack) return live.slice();
    this.bySlice.set(this.sliceZ, live.slice());
    const out: Region[] = [];
    const zs = Array.from(this.bySlice.keys()).sort((a, b) => a - b);
    for (const z of zs) {
      for (const r of this.bySlice.get(z) as Region[]) out.push(withRegionZ(r, z));
    }
    return out;
  }

  /** Slices to write on a per-slice-file save: every slice with regions plus
   *  every slice loaded non-empty (re-written empty when cleared). Empty
   *  outside stack mode. */
  stackSaveSlices(live: Region[]): Map<number, Region[]> {
    const out = new Map<number, Region[]>();
    if (!this.stack) return out;
    this.bySlice.set(this.sliceZ, live.slice());
    const zs = new Set<number>(this.initialNonEmpty);
    for (const [z, regs] of this.bySlice) if (regs.length) zs.add(z);
    for (const z of Array.from(zs).sort((a, b) => a - b)) {
      out.set(
        z,
        (this.bySlice.get(z) ?? []).map((r) => withRegionZ(r, z)),
      );
    }
    return out;
  }
}
