/**
 * Cursor tooltip naming the observation under the pointer, for the spatial-omics
 * views — the same overlay-in-the-host pattern as {@link NapariScaleBar}.
 *
 * A 34-entry legend cannot be read back from a dot: several classes get similar
 * colours, and matching one to a swatch by eye is the job a tooltip removes. It
 * shows what the cloud is CURRENTLY coloured by, so it always agrees with the
 * legend beside it.
 *
 * Deliberately not PrimeNG's `pTooltip`: that binds to an element, and these
 * points are pixels in a WebGPU canvas with no DOM of their own.
 */
export class NapariSpatialTooltip {
  private readonly el: HTMLDivElement;
  private readonly primary: HTMLSpanElement;
  private readonly secondary: HTMLSpanElement;
  /** Gap between the cursor and the box, so the box never sits under the arrow. */
  private static readonly OFFSET = 14;

  constructor(private readonly host: HTMLElement) {
    // Absolutely positioned within the host, so the host must establish a
    // containing block (the plot host is often statically positioned). Tested for
    // what it must NOT be rather than for 'static': a computed position can also
    // come back empty, and treating that as already-positioned would leave the box
    // anchored to some ancestor instead.
    const positioned = ['relative', 'absolute', 'fixed', 'sticky'];
    if (!positioned.includes(getComputedStyle(host).position)) {
      host.style.position = 'relative';
    }

    this.el = document.createElement('div');
    Object.assign(this.el.style, {
      position: 'absolute',
      display: 'none',
      // Above the canvas and the region overlay, below any dialog.
      zIndex: '6',
      // The pointer has to reach the canvas underneath: a tooltip that ate
      // pointer events would kill orbiting the moment it appeared.
      pointerEvents: 'none',
      padding: '4px 8px',
      borderRadius: '4px',
      background: 'rgba(17, 17, 20, 0.88)',
      color: '#fff',
      font: '12px/1.35 system-ui, sans-serif',
      whiteSpace: 'nowrap',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.35)',
      maxWidth: '22rem',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    } as Partial<CSSStyleDeclaration>);

    this.primary = document.createElement('span');
    Object.assign(this.primary.style, { display: 'block', fontWeight: '600' });
    this.secondary = document.createElement('span');
    Object.assign(this.secondary.style, {
      display: 'block',
      opacity: '0.7',
      fontSize: '11px',
    } as Partial<CSSStyleDeclaration>);

    this.el.append(this.primary, this.secondary);
    host.appendChild(this.el);
  }

  /**
   * Show `lines` at a point given in HOST-relative pixels.
   *
   * Flips to the other side of the cursor near an edge rather than being clipped
   * by the host — a tooltip half outside the plot is worse than one on the left.
   */
  show(lines: readonly string[], hostX: number, hostY: number): void {
    if (lines.length === 0) {
      this.hide();
      return;
    }
    this.primary.textContent = lines[0];
    this.secondary.textContent = lines[1] ?? '';
    this.secondary.style.display = lines[1] ? 'block' : 'none';
    // Measured while visible: offsetWidth is 0 on a `display: none` element, so
    // the flip below would always think the box fits.
    this.el.style.display = 'block';

    const gap = NapariSpatialTooltip.OFFSET;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const hostW = this.host.clientWidth;
    const hostH = this.host.clientHeight;
    const left = hostX + gap + w > hostW ? Math.max(0, hostX - gap - w) : hostX + gap;
    const top = hostY + gap + h > hostH ? Math.max(0, hostY - gap - h) : hostY + gap;
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  /** True while the box is on screen — for tests, and to skip redundant hides. */
  get visible(): boolean {
    return this.el.style.display !== 'none';
  }

  dispose(): void {
    this.el.remove();
  }
}
