import type { RegionMesh3D } from './napari-volume-region-meshes';

export interface RegionMeshPointerOptions {
  /** The surface under canvas point (`x`, `y`) (CSS px), or null. */
  pickAt(x: number, y: number): RegionMesh3D | null;
  /** Whether a click picks (the selection tool armed, surfaces shown); otherwise clicks are left alone. */
  active(): boolean;
  /** Whether hovering names the surface under the pointer (surfaces shown, whatever the tool). */
  hoverable(): boolean;
  /** A click on a surface (its key), or on none (null); `additive` with Shift / Ctrl / ⌘. */
  onPick(key: string | null, additive: boolean): void;
}

/** A press that moves farther than this (px) is an orbit drag, not a click. */
const CLICK_SLOP_PX = 5;
/** Hover picking waits for the pointer to rest this long (ms): a ray cast per move is wasted. */
const HOVER_DELAY_MS = 60;

/**
 * Clicks and hover on the region surfaces of a volume view: a click (a press that does not orbit)
 * picks the surface under it, or none; resting over a surface shows its name in a tooltip (and a
 * pointer cursor when a click would pick it). Listens on the canvas without stopping events, so the
 * camera still orbits.
 */
export class RegionMeshPointer {
  private readonly tip: HTMLDivElement;
  private down: { x: number; y: number } | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly canvas: HTMLElement,
    host: HTMLElement,
    private readonly opts: RegionMeshPointerOptions,
  ) {
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    this.tip = document.createElement('div');
    this.tip.className = 'napari-region-mesh-tip';
    Object.assign(this.tip.style, {
      position: 'absolute',
      padding: '2px 8px',
      borderRadius: '4px',
      background: 'rgba(0, 0, 0, 0.75)',
      color: '#fff',
      font: '12px/1.4 system-ui, sans-serif',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      zIndex: '6',
      display: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    host.appendChild(this.tip);
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerleave', this.onLeave);
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.onLeave();
    this.tip.remove();
  }

  private local(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private readonly onDown = (e: PointerEvent): void => {
    this.down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  };

  private readonly onUp = (e: PointerEvent): void => {
    const down = this.down;
    this.down = null;
    if (!down || e.button !== 0 || !this.opts.active()) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
    const [x, y] = this.local(e);
    const hit = this.opts.pickAt(x, y);
    this.opts.onPick(hit?.key ?? null, e.shiftKey || e.ctrlKey || e.metaKey);
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    // Dragging orbits the camera: no hover while a button is down.
    if (e.buttons || !this.opts.hoverable()) {
      this.hide();
      return;
    }
    const [x, y] = this.local(e);
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      const hit = this.opts.pickAt(x, y);
      if (!hit) {
        this.hide();
        return;
      }
      this.canvas.style.cursor = this.opts.active() ? 'pointer' : '';
      this.tip.textContent = hit.label ?? hit.key;
      this.tip.style.left = `${x + 14}px`;
      this.tip.style.top = `${y + 14}px`;
      this.tip.style.display = 'block';
    }, HOVER_DELAY_MS);
  };

  private readonly onLeave = (): void => {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    this.hide();
  };

  private hide(): void {
    this.tip.style.display = 'none';
    this.canvas.style.cursor = '';
  }
}
