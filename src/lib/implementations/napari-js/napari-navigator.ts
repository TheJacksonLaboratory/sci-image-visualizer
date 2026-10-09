import { worldViewport } from 'napari-js';

/**
 * Overview navigator (minimap) for the napari-js 2D views, mirroring the OSD backend's
 * built-in navigator: a thumbnail of the whole image in the bottom-right corner with the
 * current viewport drawn on it. Clicking re-centres the main view on that point at the
 * same zoom; dragging pans continuously — exactly OSD's behaviour.
 *
 * napari keeps layers at full-resolution pixel scale, so the camera's world units ARE
 * image pixels and the thumbnail maps onto `[0, width) × [0, height)` directly.
 */

/** The slice of the napari 2D camera the navigator reads and drives. */
export interface NavigatorCamera {
  center: readonly [number, number];
  readonly zoom: number;
  readonly changed: { connect(listener: () => void): () => void };
}

/** A world rectangle, as napari-js's `Rect`. */
export interface NavigatorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The viewer itself (napari-js `Viewer` satisfies it): its camera, plus the world rect it
 * shows. Preferred over a bare camera, because napari-js sizes that rect from the CANVAS,
 * which is what is actually on screen; from a bare camera the navigator can only use the
 * host's size, which is off when the host holds anything besides the canvas.
 */
export interface NavigatorView {
  readonly camera: NavigatorCamera;
  visibleWorldRect(): NavigatorRect;
}

/** Where the thumbnail sits inside the navigator box, in CSS px. */
export interface NavigatorLayout {
  /** Box size. */
  width: number;
  height: number;
  /** CSS px per world unit (image pixel). */
  scale: number;
}

/** Fraction of the host's width the navigator takes — OSD's `navigatorSizeRatio`. */
export const NAVIGATOR_SIZE_RATIO = 0.16;
const NAVIGATOR_MIN_PX = 110;
const NAVIGATOR_MAX_PX = 300;

/** Box size and scale for a `worldW × worldH` image in a host `hostW` wide. */
export function navigatorLayout(
  hostW: number, worldW: number, worldH: number, ratio = NAVIGATOR_SIZE_RATIO,
): NavigatorLayout | null {
  if (!(worldW > 0) || !(worldH > 0) || !(hostW > 0)) return null;
  const longest = Math.min(NAVIGATOR_MAX_PX, Math.max(NAVIGATOR_MIN_PX, hostW * ratio));
  const scale = longest / Math.max(worldW, worldH);
  return { width: worldW * scale, height: worldH * scale, scale };
}

/** A point in the navigator box → world coordinates, clamped to the image. */
export function navigatorToWorld(
  px: number, py: number, layout: NavigatorLayout, worldW: number, worldH: number,
): [number, number] {
  const x = Math.min(worldW, Math.max(0, px / layout.scale));
  const y = Math.min(worldH, Math.max(0, py / layout.scale));
  return [x, y];
}

export class NapariNavigator {
  private readonly box: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly region: HTMLDivElement;
  private readonly disconnectCamera: () => void;
  private readonly resizeObserver?: ResizeObserver;
  private readonly camera: NavigatorCamera;
  /** The world rect on screen: the viewer's own when given one, else from the host's size. */
  private readonly visibleRect: () => NavigatorRect;
  /** Aborted by destroy() to remove every DOM listener the box holds. */
  private readonly listeners = new AbortController();
  private layout: NavigatorLayout | null = null;
  private image: CanvasImageSource | null = null;
  private dragging = false;
  private visible = true;

  constructor(
    private readonly host: HTMLElement,
    view: NavigatorView | NavigatorCamera,
    private worldW: number,
    private worldH: number,
    /** Called when the pointer enters the navigator — e.g. to hide a hover tooltip that
     *  was describing the canvas underneath. */
    private readonly onEnter?: () => void,
  ) {
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    if ('visibleWorldRect' in view) {
      this.camera = view.camera;
      this.visibleRect = () => view.visibleWorldRect();
    } else {
      this.camera = view;
      this.visibleRect = () => worldViewport(
        view.center[0], view.center[1], view.zoom, host.clientWidth, host.clientHeight,
      );
    }

    this.box = document.createElement('div');
    this.box.className = 'napari-navigator';
    Object.assign(this.box.style, {
      position: 'absolute',
      right: '12px',
      bottom: '12px',
      background: 'rgba(0,0,0,0.5)',
      border: '1px solid rgba(255,255,255,0.35)',
      overflow: 'hidden',
      cursor: 'pointer',
      zIndex: '5',
      touchAction: 'none',
    } satisfies Partial<CSSStyleDeclaration>);

    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%' });

    // OSD's default display-region style.
    this.region = document.createElement('div');
    Object.assign(this.region.style, {
      position: 'absolute',
      border: '2px solid #900',
      boxSizing: 'border-box',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);

    this.box.append(this.canvas, this.region);
    host.appendChild(this.box);

    // The navigator's own gestures must not also reach the canvas underneath (pan/zoom,
    // region drawing), so every pointer/wheel event is consumed here.
    // One signal for all of them, so destroy() releases every listener at once.
    const signal = this.listeners.signal;
    this.box.addEventListener('pointerdown', this.onDown, { signal });
    this.box.addEventListener('pointermove', this.onMove, { signal });
    this.box.addEventListener('pointerup', this.onUp, { signal });
    this.box.addEventListener('pointercancel', this.onUp, { signal });
    this.box.addEventListener('pointerenter', () => this.onEnter?.(), { signal });
    for (const type of ['wheel', 'click', 'dblclick', 'contextmenu', 'mousedown'] as const) {
      this.box.addEventListener(type, stop, { passive: false, signal });
    }

    this.disconnectCamera = this.camera.changed.connect(() => this.updateRegion());
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.relayout());
      this.resizeObserver.observe(host);
    }
    this.relayout();
  }

  /** The thumbnail to draw: any image of the whole world (a coarse pyramid level). */
  setImage(image: CanvasImageSource | null): void {
    this.image = image;
    this.drawImage();
  }

  /** The image's world size changed (another image was loaded). */
  setWorld(width: number, height: number): void {
    this.worldW = width;
    this.worldH = height;
    this.relayout();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.box.style.display = visible && this.layout ? 'block' : 'none';
  }

  destroy(): void {
    this.listeners.abort();
    this.disconnectCamera();
    this.resizeObserver?.disconnect();
    this.box.remove();
  }

  private relayout(): void {
    this.layout = navigatorLayout(this.host.clientWidth, this.worldW, this.worldH);
    if (!this.layout) {
      this.box.style.display = 'none';
      return;
    }
    this.box.style.display = this.visible ? 'block' : 'none';
    this.box.style.width = `${this.layout.width}px`;
    this.box.style.height = `${this.layout.height}px`;
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    this.canvas.width = Math.max(1, Math.round(this.layout.width * dpr));
    this.canvas.height = Math.max(1, Math.round(this.layout.height * dpr));
    this.drawImage();
    this.updateRegion();
  }

  private drawImage(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.image) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.image, 0, 0, this.canvas.width, this.canvas.height);
    }
  }

  /** Draw the viewport rectangle, clipped to the box (as OSD does when zoomed out). */
  private updateRegion(): void {
    const l = this.layout;
    if (!l) return;
    const r = this.visibleRect();
    const left = Math.max(0, r.x * l.scale);
    const top = Math.max(0, r.y * l.scale);
    const right = Math.min(l.width, (r.x + r.width) * l.scale);
    const bottom = Math.min(l.height, (r.y + r.height) * l.scale);
    Object.assign(this.region.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.max(2, right - left)}px`,
      height: `${Math.max(2, bottom - top)}px`,
      display: right > left && bottom > top ? 'block' : 'none',
    });
  }

  /** Re-centre the main view on the navigator point under the pointer, keeping the zoom. */
  private panTo(e: PointerEvent): void {
    const l = this.layout;
    if (!l) return;
    const rect = this.box.getBoundingClientRect();
    this.camera.center = navigatorToWorld(
      e.clientX - rect.left, e.clientY - rect.top, l, this.worldW, this.worldH,
    );
  }

  private readonly onDown = (e: PointerEvent): void => {
    stop(e);
    if (e.button !== 0) return;
    this.dragging = true;
    this.box.setPointerCapture?.(e.pointerId);
    this.panTo(e);
  };

  private readonly onMove = (e: PointerEvent): void => {
    // Always consumed: a hover over the navigator is not a hover over the canvas.
    stop(e);
    if (this.dragging) this.panTo(e);
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    stop(e);
    this.dragging = false;
    this.box.releasePointerCapture?.(e.pointerId);
  };
}

function stop(e: Event): void {
  e.stopPropagation();
  if (e.cancelable) e.preventDefault();
}
