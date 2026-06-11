import * as OpenSeadragon from 'openseadragon';

/**
 * Stack-slice cache for the OpenSeadragon backend (refactoring plan, Step 3 —
 * a pure move of the cache cluster out of the visualizer service).
 *
 * Scrubbing the z-slider used to viewer.open() a fresh tile source per slice,
 * which destroys the current tiled image (and its decoded+recolored tiles), so
 * revisiting a slice re-fetched everything. Instead we keep each visited slice
 * as its own tiled image in the world and just toggle opacity — a revisited
 * slice is instant (no network, no re-decode, no re-recolor). Bounded by an
 * LRU so deep stacks don't grow without limit. Multichannel slices cache one
 * TiledImage per channel (additively composited); composite slices cache one.
 * A background loader pre-fills the rest of the stack, one slice at a time,
 * yielding to the visible slice so on-screen tiles always win the connection.
 */

/** What the cache needs from the visualizer service. All accessors are live
 *  (called at use time, never captured) so the cache always sees the current
 *  viewer/descriptor/z — matching the field reads it replaced. */
export interface SliceCacheHost {
  /** The mounted viewer, or null. */
  viewer(): any | null;
  /** True when a viewer, descriptor and infoB64 are all present. */
  hasImage(): boolean;
  /** Stack depth (descriptor.z, 1 for single images). */
  sliceCount(): number;
  /** The currently displayed z-slice. */
  currentZ(): number;
  /** Per-channel rendering (multichannel fluorescence) vs composite. */
  isMultiChannel(): boolean;
  /** Channel count for a multichannel group add. */
  channelCount(): number;
  /** Channel visibility (drives group reveal opacity). */
  channelVisible(c: number): boolean;
  /** Tile source for slice z (optionally one channel). */
  buildTileSource(z: number, channel?: number): any;
  /** A composite slice landed in the world — the service samples its window. */
  onCompositeSliceAdded(z: number): void;
}

export class SliceCache {
  /** z-slice → its TiledImage in the viewer world (composite path). */
  private sliceItems = new Map<number, any>();
  /** Multichannel per-slice cache: z → the N channel TiledImages for that slice
   *  (additively composited by OSD; index = channel). Only the active slice's
   *  visible channels have opacity > 0. */
  private channelSliceItems = new Map<number, any[]>();
  /** Cached multichannel slices whose tiles were tinted before the latest
   *  display change; re-tinted lazily when next revealed by z-scrub. */
  private staleSlices = new Set<number>();
  /** Most-recently-shown z last; drives LRU eviction. */
  private sliceLru: number[] = [];
  /** z-slices whose tiled image is being added (dedupe rapid scrubbing). */
  private slicesLoading = new Set<number>();
  /** Bumped whenever the loaded image changes; in-flight background slice adds
   *  captured under an older token are dropped (cancelled image switch). */
  private sliceLoadToken = 0;
  /** The slice the background loader is currently waiting on (its tiles are
   *  still streaming): addTiledImage 'success' fires on add, not on tile load,
   *  so we gate the next slice on getFullyLoaded(). */
  private bgLoadingZ: number | null = null;
  /** When bgLoadingZ started loading — a fallback so a slow/stuck slice can't
   *  stall the whole background pass forever. */
  private bgLoadingSince = 0;
  /** Slices the background loader has already attempted (no tight retry loop). */
  private bgAttempted = new Set<number>();
  /** Max cached slice tiled images kept resident before LRU eviction. */
  private maxCachedSlices = 8;
  /** Upper bound on resident slices, regardless of stack depth (memory guard). */
  private readonly MAX_CACHED_SLICES_CAP = 64;
  /** Fit-view tile budget above which background preloading is skipped: a huge
   *  no-pyramid stack would preload every slice at full resolution and
   *  flood/timeout. Normal stacks stay below it and KEEP the flicker-free
   *  pre-cache. */
  private readonly MAX_PREFETCH_FIT_TILES = 256;
  /** True only for stacks too large to background-preload. */
  private skipSlicePrefetch = false;
  private prefetchTimer: any = null;

  constructor(private host: SliceCacheHost) {}

  // ── configuration (per image, from plot()) ────────────────────────────

  /** Size the cache for the loaded image: keep the whole stack resident
   *  (capped) so the background loader fills every slice without evicting
   *  itself; skip preloading entirely when even the coarsest level's tile
   *  grid is too large (its slices only exist at full resolution). */
  configure(stackDepth: number, coarseFitTiles: number): void {
    this.skipSlicePrefetch = coarseFitTiles > this.MAX_PREFETCH_FIT_TILES;
    this.maxCachedSlices =
      stackDepth > 1 ? Math.min(this.MAX_CACHED_SLICES_CAP, stackDepth) : 1;
  }

  /** Current LRU cap (the viewer sizes its tile cache from it). */
  maxSlices(): number {
    return this.maxCachedSlices;
  }

  /** Drop the per-channel groups (on a fresh plot). */
  clearChannelGroups(): void {
    this.channelSliceItems.clear();
  }

  /** Seed the cache with the just-opened composite slice (world item 0), so
   *  scrubbing back to it later is an instant opacity toggle, not a re-open. */
  seedComposite(z: number, item: any): void {
    this.sliceItems.set(z, item);
    this.touchSliceLru(z);
  }

  // ── slice display (setZIndex's cache work) ────────────────────────────

  /** Show slice z: reveal it instantly when cached (re-tinting a stale
   *  multichannel group), otherwise add it once. The current slice stays
   *  visible until the new one is in — no white-flicker. */
  showSlice(z: number): void {
    if (this.host.isMultiChannel()) {
      const group = this.channelSliceItems.get(z);
      if (group && group.length && group.some((it) => it && this.sliceInWorld(it))) {
        this.revealChannelSlice(z);
        // If a display change happened while this slice was cached, its tiles
        // hold a stale tint — re-apply now (it's the visible slice, so the
        // brief restore flash is acceptable, like a fresh load).
        if (this.staleSlices.delete(z)) this.invalidateSlice(z);
        this.touchSliceLru(z);
        this.schedulePrefetch();
      } else if (!this.slicesLoading.has(z)) {
        this.addChannelSlice(z);
      }
      return;
    }
    const cached = this.sliceItems.get(z);
    if (cached && this.sliceInWorld(cached)) {
      // Instant: reveal the cached slice, hide the others — no fetch/decode.
      this.showOnlySlice(z);
      this.touchSliceLru(z);
      this.schedulePrefetch();
      return;
    }
    if (this.slicesLoading.has(z)) return; // already being added; success reveals it
    this.addSlice(z);
  }

  /** Add a never-seen slice as a hidden tiled image, then reveal it once loaded
   *  (composite path; multichannel routes to addChannelSlice). */
  private addSlice(z: number): void {
    if (!this.host.hasImage()) return;
    if (this.host.isMultiChannel()) {
      this.addChannelSlice(z);
      return;
    }
    this.slicesLoading.add(z);
    // Tag this add to the current image; if the user switches images before it
    // resolves, the stale callback is dropped (the add belongs to the old stack).
    const token = this.sliceLoadToken;
    const ts = this.host.buildTileSource(z);
    try {
      // addTiledImage lives on the Viewer (it queues the add into the world).
      this.host.viewer().addTiledImage({
        tileSource: ts,
        x: 0,
        y: 0,
        width: 1, // match the primary image's normalized placement
        opacity: 0,
        // Load tiles even though it's hidden — this is what lets the background
        // loader fill every slice's cache so scrubbing gets progressively smoother.
        preload: true,
        success: (e: any) => {
          const item = e?.item;
          if (token !== this.sliceLoadToken) {
            // Image switched while this was adding — drop the orphan so it stops
            // loading instead of streaming tiles for the abandoned stack.
            if (item) {
              try { this.host.viewer()?.world?.removeItem(item); } catch { /* gone */ }
            }
            return;
          }
          this.slicesLoading.delete(z);
          if (!item) return;
          this.sliceItems.set(z, item);
          this.touchSliceLru(z);
          this.host.onCompositeSliceAdded(z);
          // Only reveal if the user is still on this slice (fast scrubbing may
          // have moved on — leave it cached/hidden for a later revisit).
          if (z === this.host.currentZ()) {
            this.showOnlySlice(z);
            this.schedulePrefetch();
          }
          this.evictSliceLru();
        },
        error: () => {
          if (token === this.sliceLoadToken) this.slicesLoading.delete(z);
        },
      });
    } catch (err) {
      this.slicesLoading.delete(z);
      console.warn('[OSD] failed to add z-slice', err);
    }
  }

  /**
   * Add slice z's channel group: one additively-composited ('lighter' = Fiji
   * "Composite") TiledImage per channel, hidden (opacity 0) until revealed.
   * Each is preloaded so the background loader can pre-fill every slice.
   * Cached so a revisit is an instant opacity toggle — no re-fetch, no
   * white-flicker. Mirrors addSlice for the composite path.
   */
  addChannelSlice(z: number): void {
    if (!this.host.hasImage()) return;
    if (this.channelSliceItems.has(z) || this.slicesLoading.has(z)) return;
    this.slicesLoading.add(z);
    const token = this.sliceLoadToken;
    const n = this.host.channelCount();
    const group: any[] = new Array(n);
    let settled = 0;
    const onSettled = () => {
      if (++settled < n) return;
      if (token !== this.sliceLoadToken) return; // image switched mid-add
      this.slicesLoading.delete(z);
      this.channelSliceItems.set(z, group);
      this.staleSlices.delete(z); // freshly tinted at the current display state
      this.touchSliceLru(z);
      if (z === this.host.currentZ()) {
        this.revealChannelSlice(z); // tiles may still be decoding; opacity is set now
        this.schedulePrefetch();
      }
      this.evictSliceLru();
    };
    for (let c = 0; c < n; c++) {
      try {
        this.host.viewer().addTiledImage({
          tileSource: this.host.buildTileSource(z, c),
          x: 0, y: 0, width: 1,
          opacity: 0, // revealed by revealChannelSlice once the group is in
          compositeOperation: 'lighter',
          preload: true,
          success: (e: any) => {
            const item = e?.item;
            if (token !== this.sliceLoadToken) {
              if (item) { try { this.host.viewer()?.world?.removeItem(item); } catch { /* gone */ } }
              return;
            }
            if (item) group[c] = item;
            onSettled();
          },
          error: () => onSettled(),
        });
      } catch (err) {
        console.warn('[OSD] failed to add channel slice image', z, c, err);
        onSettled();
      }
    }
  }

  /** Reveal slice z's channel group (each visible channel → opacity 1) and
   *  hide every other cached slice's group. Instant; no fetch/decode. */
  revealChannelSlice(z: number): void {
    for (const [zz, group] of this.channelSliceItems) {
      const active = zz === z;
      group.forEach((it, c) => {
        if (!it) return;
        const visible = this.host.channelVisible(c);
        try { it.setOpacity(active && visible ? 1 : 0); } catch { /* gone */ }
      });
    }
  }

  /** Show the given composite slice (opacity 1) and hide all other cached slices. */
  private showOnlySlice(z: number): void {
    for (const [zz, item] of this.sliceItems) {
      try { item.setOpacity(zz === z ? 1 : 0); } catch { /* item gone */ }
    }
  }

  // ── display invalidation (multichannel) ───────────────────────────────

  /** Re-tint after a display change: invalidate ONLY the visible slice's
   *  channel images — invalidating the whole world would re-process every
   *  hidden/preloaded slice's tiles (hundreds), flooding OSD and wasting work
   *  on tiles that aren't on screen. The other cached slices are marked stale
   *  and re-tinted lazily when revealed. */
  invalidateChannelDisplay(z: number): void {
    this.invalidateSlice(z);
    this.staleSlices.clear();
    for (const zz of this.channelSliceItems.keys()) {
      if (zz !== z) this.staleSlices.add(zz);
    }
  }

  /** Invalidate (restore + re-recolor) just the channel images of one cached
   *  slice. A shared timestamp batches the per-image invalidations into one
   *  processing pass (OSD dedupes tiles already stamped at >= tStamp). */
  private invalidateSlice(z: number): void {
    const group = this.channelSliceItems.get(z) ?? [];
    if (!group.length) return;
    const osd: any = OpenSeadragon;
    const tStamp = typeof osd.now === 'function' ? osd.now() : Date.now();
    for (const it of group) {
      if (it && typeof it.requestInvalidate === 'function') {
        try { it.requestInvalidate(true, false, tStamp); } catch { /* gone */ }
      }
    }
  }

  // ── background stack preloading ───────────────────────────────────────

  /** Debounce so a burst of viewport/slice events coalesces, then advance the
   *  background stack loader by one slice. */
  schedulePrefetch(): void {
    if (this.skipSlicePrefetch) return;
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    this.prefetchTimer = setTimeout(() => this.loadNextBackgroundSlice(), 200);
  }

  /**
   * Background-load the whole stack: add each not-yet-cached slice as a
   * hidden, preloaded tiled image, one at a time, working outward from the
   * current slice — and never blocking the visible slice (it yields while the
   * current view is still streaming tiles; only one slice is in flight at a
   * time so the on-screen tiles always win the connection).
   */
  private loadNextBackgroundSlice(): void {
    this.prefetchTimer = null;
    if (!this.host.hasImage()) return;
    const sliceCount = this.host.sliceCount();
    if (sliceCount <= 1) return; // not a stack — nothing to preload
    // Yield to the visible slice while it's still streaming tiles.
    if (this.sliceTilesLoading(this.host.currentZ())) {
      this.schedulePrefetch();
      return;
    }
    // Gate on the in-flight slice's TILES finishing — addTiledImage's success
    // fires on add, not on tile load, so without this we'd add the whole stack
    // at once and flood the connection. A time fallback prevents a stuck slice
    // from stalling the pass.
    if (this.bgLoadingZ != null) {
      const adding = this.slicesLoading.has(this.bgLoadingZ);
      const tilesLoading = this.sliceTilesLoading(this.bgLoadingZ);
      const timedOut = Date.now() - this.bgLoadingSince > 8000;
      if ((adding || tilesLoading) && !timedOut) {
        this.schedulePrefetch();
        return;
      }
      this.bgLoadingZ = null; // that slice's tiles are in (or gave up) — advance
    }
    const next = this.nearestUncachedSlice(sliceCount);
    if (next == null) return; // whole stack cached — done
    this.bgLoadingZ = next;
    this.bgLoadingSince = Date.now();
    this.bgAttempted.add(next);
    this.addSlice(next); // hidden + preload (added with opacity 0; not revealed)
    this.schedulePrefetch(); // poll until its tiles load, then advance
  }

  /** The not-yet-cached slice closest to the current one (load nearest first),
   *  skipping any already attempted so a failed/slow one isn't retried in a loop. */
  private nearestUncachedSlice(sliceCount: number): number | null {
    const cur = this.host.currentZ();
    for (let d = 0; d < sliceCount; d++) {
      const candidates = d === 0 ? [cur] : [cur - d, cur + d];
      for (const z of candidates) {
        if (
          z >= 0 && z < sliceCount &&
          !this.sliceCacheHas(z) && !this.slicesLoading.has(z) && !this.bgAttempted.has(z)
        ) {
          return z;
        }
      }
    }
    return null;
  }

  /**
   * Stop background stack preloading and invalidate any in-flight slice add.
   * Called when a different image is selected so the previous stack stops
   * loading immediately instead of finishing in the background.
   */
  cancelBackgroundLoad(): void {
    if (this.prefetchTimer) {
      clearTimeout(this.prefetchTimer);
      this.prefetchTimer = null;
    }
    this.slicesLoading.clear();
    this.bgLoadingZ = null;
    this.bgAttempted.clear();
    this.sliceLoadToken++; // drop pending addTiledImage callbacks from the old image
    // Abort in-flight background tiles immediately by dropping the hidden
    // preloaded slices (removeItem cancels their pending tile loads). Keep the
    // visible slice so the current view doesn't blank before the next plot.
    this.dropHiddenSlices();
  }

  /** Remove every cached slice except the currently displayed one, aborting
   *  their in-flight tile requests. */
  private dropHiddenSlices(): void {
    const v = this.host.viewer();
    if (!v) return;
    const cur = this.host.currentZ();
    for (const [z, item] of [...this.sliceItems]) {
      if (z === cur) continue;
      this.sliceItems.delete(z);
      try { v.world.removeItem(item); } catch { /* already gone */ }
    }
    for (const [z, group] of [...this.channelSliceItems]) {
      if (z === cur) continue;
      this.channelSliceItems.delete(z);
      for (const it of group) { if (it) { try { v.world.removeItem(it); } catch { /* gone */ } } }
    }
    this.sliceLru = this.sliceCacheHas(cur) ? [cur] : [];
  }

  // ── cache bookkeeping ─────────────────────────────────────────────────

  /** Whether slice z is in the active cache (composite single image, or the
   *  multichannel per-channel group). */
  private sliceCacheHas(z: number): boolean {
    return this.host.isMultiChannel() ? this.channelSliceItems.has(z) : this.sliceItems.has(z);
  }

  /** The cached TiledImage(s) for slice z (0–1 for composite, N for multichannel). */
  private sliceGroup(z: number): any[] {
    if (this.host.isMultiChannel()) return this.channelSliceItems.get(z) ?? [];
    const it = this.sliceItems.get(z);
    return it ? [it] : [];
  }

  /** Whether slice z's tiles are still streaming (any cached image not fully loaded). */
  private sliceTilesLoading(z: number): boolean {
    const g = this.sliceGroup(z);
    if (!g.length) return false;
    return g.some((it) => it && typeof it.getFullyLoaded === 'function' && !it.getFullyLoaded());
  }

  /** Remove slice z's cached image(s) from the world and the active cache. */
  private removeCachedSlice(z: number): void {
    const v = this.host.viewer();
    if (this.host.isMultiChannel()) {
      const group = this.channelSliceItems.get(z);
      this.channelSliceItems.delete(z);
      if (group && v) for (const it of group) { if (it) { try { v.world.removeItem(it); } catch { /* gone */ } } }
    } else {
      const item = this.sliceItems.get(z);
      this.sliceItems.delete(z);
      if (item && v) { try { v.world.removeItem(item); } catch { /* gone */ } }
    }
  }

  /** Is the tiled image still in the world (not evicted)? */
  private sliceInWorld(item: any): boolean {
    try {
      return this.host.viewer().world.getIndexOfItem(item) >= 0;
    } catch {
      return false;
    }
  }

  /** Mark z as most-recently-used. */
  private touchSliceLru(z: number): void {
    const i = this.sliceLru.indexOf(z);
    if (i >= 0) this.sliceLru.splice(i, 1);
    this.sliceLru.push(z);
  }

  /** Drop the least-recently-used cached slices beyond the cap (never the
   *  current one), removing their tiled images so memory stays bounded. */
  private evictSliceLru(): void {
    while (this.sliceLru.length > this.maxCachedSlices) {
      const cur = this.host.currentZ();
      const idx = this.sliceLru.findIndex((z) => z !== cur);
      if (idx < 0) break;
      const z = this.sliceLru.splice(idx, 1)[0];
      this.removeCachedSlice(z);
    }
  }

  /** Clear the cache (on teardown / image switch). */
  reset(): void {
    this.sliceItems.clear();
    this.channelSliceItems.clear();
    this.staleSlices.clear();
    this.sliceLru = [];
    this.slicesLoading.clear();
    this.bgLoadingZ = null;
    this.bgAttempted.clear();
  }
}
