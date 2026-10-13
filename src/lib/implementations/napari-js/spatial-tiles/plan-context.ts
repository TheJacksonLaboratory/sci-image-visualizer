/**
 * Loads in flight, per layer label ("Transcripts", "Cells"…), for the canvas loading badge.
 * Shared by every plan: a label stays reported while any plan still loads it.
 */
export class LoadTracker {
  private readonly loading = new Map<string, number>();

  constructor(private readonly changed: (labels: string[]) => void) {}

  /** Report `label` loading while `work` is in flight. */
  async track<T>(label: string, work: Promise<T>): Promise<T> {
    this.loading.set(label, (this.loading.get(label) ?? 0) + 1);
    this.changed([...this.loading.keys()]);
    try {
      return await work;
    } finally {
      const n = (this.loading.get(label) ?? 1) - 1;
      if (n > 0) this.loading.set(label, n);
      else this.loading.delete(label);
      this.changed([...this.loading.keys()]);
    }
  }

  /** Forget every load (the viewer went away) and report none. */
  clear(): void {
    this.loading.clear();
    this.changed([]);
  }
}

/**
 * One run of `NapariSpatialTileLayers.plan()`. Completeness belongs to the run that did the
 * fetching: on the instance, a superseded run's failed tile marked the CURRENT run incomplete,
 * which then skipped caching its keys and retried for nothing (review NAPARI-BOUNDARY-9).
 */
export class PlanContext {
  private failed = false;

  /** `isStale` turns true once a newer plan started or the viewer changed. */
  constructor(
    private readonly isStale: () => boolean,
    private readonly loads: LoadTracker,
  ) {}

  /** True once a newer plan started or the viewer changed. */
  stale(): boolean {
    return this.isStale();
  }

  /** Set when a fetch of this run failed (see fetchAll): don't cache it as done; retry. */
  get incomplete(): boolean {
    return this.failed;
  }

  /** A request of this run failed: what it drew must not be cached as done. */
  markIncomplete(): void {
    this.failed = true;
  }

  /** Report `label` loading while `work` is in flight. */
  track<T>(label: string, work: Promise<T>): Promise<T> {
    return this.loads.track(label, work);
  }

  /**
   * Fetch every tile, drawing what arrived. A failure does not fail the view, but it marks this
   * run incomplete: the caller must not cache it as done, and `plan()` retries it.
   */
  async fetchAll<K, T>(keys: K[], load: (k: K) => Promise<T>): Promise<T[]> {
    const settled = await Promise.allSettled(keys.map(load));
    const out: T[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') out.push(s.value);
      else console.warn('[napari-js] spatial tile failed', s.reason);
    }
    if (out.length < keys.length) this.markIncomplete();
    return out;
  }
}
