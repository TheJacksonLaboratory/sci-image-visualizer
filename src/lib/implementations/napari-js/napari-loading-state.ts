import { NapariLoadingBadge } from './napari-loading-badge';

/** What the service itself counts on the badge; the spatial tile layers report their own names. */
export type LoadingSource = 'Image' | 'Observations';

/**
 * "x reloading…" at the bottom of the canvas, aggregated over everything that loads into one
 * scene: image tiles (the tile client), observation colourings (the spatial scenes) and the
 * spatial tile layers' own loads (which report a list of layer names).
 *
 * Each load is a {@link begin} that hands back its own `end`. {@link reset} starts a new scene
 * and drops the counts.
 */
export class LoadingBadgeState {
  private host: HTMLElement | null = null;
  private badge: NapariLoadingBadge | null = null;
  private readonly counts = new Map<LoadingSource, number>();
  private tileLayers: readonly string[] = [];

  /** The element the badge is drawn into (the plot host); set per plot. */
  attach(host: HTMLElement): void {
    this.host = host;
  }

  /** One load of `source` started; call the returned function once it settles. */
  begin(source: LoadingSource): () => void {
    this.counts.set(source, (this.counts.get(source) ?? 0) + 1);
    this.show();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.counts.set(source, (this.counts.get(source) ?? 0) - 1);
      this.show();
    };
  }

  /** The spatial tile layers still loading (their own names, in their order). */
  setTileLayers(layers: readonly string[]): void {
    this.tileLayers = layers;
    this.show();
  }

  /** The text the badge has set (shown, or about to be once the show delay passes). */
  get text(): string {
    return this.badge?.text ?? '';
  }

  /** A new scene: forget every count and remove the badge. */
  reset(): void {
    this.counts.clear();
    this.tileLayers = [];
    this.badge?.destroy();
    this.badge = null;
  }

  private show(): void {
    if (!this.host) return;
    this.badge ??= new NapariLoadingBadge(this.host);
    this.badge.set([
      ...((this.counts.get('Image') ?? 0) > 0 ? ['Image'] : []),
      ...((this.counts.get('Observations') ?? 0) > 0 ? ['Observations'] : []),
      ...this.tileLayers,
    ]);
  }
}
