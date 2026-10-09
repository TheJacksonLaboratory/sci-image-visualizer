/**
 * "Transcripts reloading…" at the bottom of the canvas while a layer's data is in flight: one
 * line naming every layer still loading, on a semi-opaque backing so it reads over any tissue.
 *
 * Shown only once something has been loading for {@link SHOW_AFTER_MS}, so a redraw served from
 * cache does not flash it.
 */
export const SHOW_AFTER_MS = 150;

export class NapariLoadingBadge {
  private readonly el: HTMLDivElement;
  private names: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: HTMLElement) {
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    this.el = document.createElement('div');
    this.el.className = 'napari-loading-badge';
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-live', 'polite');
    Object.assign(this.el.style, {
      position: 'absolute',
      left: '50%',
      bottom: '12px',
      transform: 'translateX(-50%)',
      padding: '4px 12px',
      borderRadius: '12px',
      background: 'rgba(0, 0, 0, 0.6)',
      color: '#fff',
      font: '12px/1.4 system-ui, sans-serif',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      zIndex: '5',
      display: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    host.appendChild(this.el);
  }

  /** The layers loading now; empty hides the badge. */
  set(names: readonly string[]): void {
    this.names = [...new Set(names)];
    if (!this.names.length) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.el.style.display = 'none';
      return;
    }
    this.el.textContent = `${listOf(this.names)} reloading…`;
    if (this.el.style.display === 'block' || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.names.length) this.el.style.display = 'block';
    }, SHOW_AFTER_MS);
  }

  /** The text currently set (shown or about to be). */
  get text(): string {
    return this.names.length ? this.el.textContent ?? '' : '';
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.el.remove();
  }
}

/** "A", "A and b", "A, b and c": the first as given, the rest with a lower-cased initial. */
function listOf(names: string[]): string {
  const [first, ...rest] = names;
  const lower = rest.map((n) => n.charAt(0).toLowerCase() + n.slice(1));
  const all = [first, ...lower];
  return all.length === 1 ? all[0] : `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
}
