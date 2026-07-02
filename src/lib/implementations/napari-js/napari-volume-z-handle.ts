/**
 * Draggable Z-height handle for the napari-js WebGPU volume (jit-ui#102). A small DOM grip is drawn
 * over the 3D canvas at the projected top-face centre of the volume box (reusing the axes-label
 * {@link projectPoint} projection, so it tracks the box as the volume orbits). Dragging it up makes
 * the volume taller, down makes it flatter — the host maps the drag to a Z-scale factor and
 * restretches the volume + axes live (only the model matrix changes; the voxel texture is untouched).
 *
 * Direct-manipulation counterpart of {@link NapariAxesLabels}: both are absolute-positioned overlays
 * updated on every `camera3d.changed`, but this one accepts pointer input.
 */
import { AxesLabelCamera3D, projectPoint } from './napari-axes-labels';

export interface VolumeZHandleOptions {
  /** Current top-face-centre world point (the box is centred at the origin, so `[0, 0, +halfZ]`). */
  topAnchor: () => [number, number, number];
  /** The current Z-scale factor (1 = the volume's default proportions). */
  getScale: () => number;
  /** Apply a new Z-scale factor — the host restretches the volume + axes and repositions overlays. */
  setScale: (scale: number) => void;
  /** Vertical drag (px) for one doubling/halving of the Z height. Larger = less sensitive. */
  pixelsPerDouble?: number;
  /** Clamp for the Z-scale factor. */
  minScale?: number;
  maxScale?: number;
}

const DEFAULTS = { pixelsPerDouble: 180, minScale: 0.1, maxScale: 10 };

export class NapariVolumeZHandle {
  private readonly el: HTMLDivElement;
  private readonly disconnectCamera: () => void;
  private readonly resizeObserver?: ResizeObserver;
  private readonly opts: Required<VolumeZHandleOptions>;
  private visible = true;
  private dragging = false;
  private startY = 0;
  private startScale = 1;

  constructor(
    private readonly host: HTMLElement,
    private readonly camera3d: AxesLabelCamera3D,
    opts: VolumeZHandleOptions,
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

    this.el = document.createElement('div');
    Object.assign(this.el.style, {
      position: 'absolute',
      zIndex: '31',
      width: '22px',
      height: '22px',
      marginLeft: '-11px',
      marginTop: '-11px',
      borderRadius: '50%',
      background: 'rgba(102,140,255,0.85)', // matches the Z axis colour (#668cff)
      border: '1.5px solid #fff',
      boxShadow: '0 0 4px rgba(0,0,0,0.6)',
      color: '#fff',
      font: '13px sans-serif',
      lineHeight: '20px',
      textAlign: 'center',
      cursor: 'ns-resize',
      touchAction: 'none',
      userSelect: 'none',
    } as Partial<CSSStyleDeclaration>);
    this.el.textContent = '↕';
    this.el.title = 'Drag to change the volume height (Z). Double-click to reset.';
    this.host.appendChild(this.el);

    this.el.addEventListener('pointerdown', this.onPointerDown);
    this.el.addEventListener('pointermove', this.onPointerMove);
    this.el.addEventListener('pointerup', this.onPointerUp);
    this.el.addEventListener('pointercancel', this.onPointerUp);
    this.el.addEventListener('dblclick', this.onDoubleClick);

    this.disconnectCamera = this.camera3d.changed.connect(() => this.reposition());
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.reposition());
      this.resizeObserver.observe(this.host);
    }
    this.reposition();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.reposition();
  }

  /** Reproject the handle to the current top-face anchor. Called on camera move, resize, and after
   *  the host applies a new scale (so the grip follows the growing/shrinking box). */
  reposition(): void {
    const vw = this.host.clientWidth;
    const vh = this.host.clientHeight;
    if (!this.visible || vw <= 0 || vh <= 0) {
      this.el.style.display = 'none';
      return;
    }
    const mvp = this.camera3d.viewProjection(vw, vh);
    const s = projectPoint(mvp, this.opts.topAnchor(), vw, vh);
    if (!s.visible) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = '';
    this.el.style.left = `${s.x}px`;
    this.el.style.top = `${s.y}px`;
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    this.dragging = true;
    this.startY = e.clientY;
    this.startScale = this.opts.getScale();
    this.el.setPointerCapture?.(e.pointerId);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    // Up (negative dy) → taller. Exponential so each `pixelsPerDouble` px doubles/halves the height.
    const dy = e.clientY - this.startY;
    const factor = Math.pow(2, -dy / this.opts.pixelsPerDouble);
    const next = Math.min(
      this.opts.maxScale,
      Math.max(this.opts.minScale, this.startScale * factor),
    );
    this.opts.setScale(next);
    this.reposition();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.el.hasPointerCapture?.(e.pointerId)) this.el.releasePointerCapture?.(e.pointerId);
  };

  private readonly onDoubleClick = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    this.opts.setScale(1);
    this.reposition();
  };

  destroy(): void {
    this.disconnectCamera();
    this.resizeObserver?.disconnect();
    this.el.removeEventListener('pointerdown', this.onPointerDown);
    this.el.removeEventListener('pointermove', this.onPointerMove);
    this.el.removeEventListener('pointerup', this.onPointerUp);
    this.el.removeEventListener('pointercancel', this.onPointerUp);
    this.el.removeEventListener('dblclick', this.onDoubleClick);
    this.el.parentNode?.removeChild(this.el);
  }
}
