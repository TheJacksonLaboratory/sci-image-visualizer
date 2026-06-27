/**
 * DOM text labels for the napari-js 3D axes gizmo (jit-ui#102). The {@link AxesLayer} draws the
 * axis lines/ticks/box in WebGPU; this overlay adds the crisp X/Y/Z + scale text on top, projected
 * with the 3D camera's view-projection so each label tracks its anchor as the volume orbits.
 * Mirrors the {@link NapariScaleBar} overlay pattern (absolute-positioned over the host, updated on
 * every `camera3d.changed`). Falls back to pixel/slice counts when no physical µm/pixel is known.
 */

/** One axis label: a world-space anchor (the axis end, in the volume's centred box), the text to
 *  show, and its colour (matching the WebGPU axis colour). */
export interface AxisLabelSpec {
  anchor: [number, number, number];
  text: string;
  color: string;
}

/** The slice of napari's Camera3D this overlay reads. `viewProjection` is column-major (gl-matrix). */
export interface AxesLabelCamera3D {
  viewProjection(vw: number, vh: number): ArrayLike<number>;
  readonly changed: { connect(listener: () => void): () => void };
}

/**
 * Project a world point through a column-major 4×4 MVP to CSS-pixel screen coordinates.
 * Returns `visible: false` when the point is at/behind the camera (w ≤ 0). Pure — unit-tested.
 */
export function projectPoint(
  mvp: ArrayLike<number>,
  p: [number, number, number],
  vw: number,
  vh: number,
): { x: number; y: number; visible: boolean } {
  const [x, y, z] = p;
  // Column-major: clip[r] = Σ_c M[c*4+r] * v[c].
  const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
  const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
  const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
  if (cw <= 0) return { x: 0, y: 0, visible: false };
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  return {
    x: (ndcX * 0.5 + 0.5) * vw,
    y: (0.5 - ndcY * 0.5) * vh,
    visible: true,
  };
}

export class NapariAxesLabels {
  private readonly els: HTMLSpanElement[] = [];
  private readonly disconnectCamera: () => void;
  private readonly resizeObserver?: ResizeObserver;
  private visible = true;

  constructor(
    private readonly host: HTMLElement,
    private readonly camera3d: AxesLabelCamera3D,
    private readonly labels: AxisLabelSpec[],
  ) {
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    for (const spec of labels) {
      const el = document.createElement('span');
      Object.assign(el.style, {
        position: 'absolute',
        zIndex: '30',
        pointerEvents: 'none',
        font: '11px sans-serif',
        fontWeight: '600',
        color: spec.color,
        textShadow: '0 0 3px #000, 0 0 3px #000',
        whiteSpace: 'nowrap',
        transform: 'translate(-50%, -50%)',
        userSelect: 'none',
      } as Partial<CSSStyleDeclaration>);
      el.textContent = spec.text;
      this.host.appendChild(el);
      this.els.push(el);
    }
    this.disconnectCamera = this.camera3d.changed.connect(() => this.update());
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.update());
      this.resizeObserver.observe(this.host);
    }
    this.update();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.update();
  }

  private update(): void {
    const vw = this.host.clientWidth;
    const vh = this.host.clientHeight;
    if (!this.visible || vw <= 0 || vh <= 0) {
      for (const el of this.els) el.style.display = 'none';
      return;
    }
    const mvp = this.camera3d.viewProjection(vw, vh);
    this.labels.forEach((spec, i) => {
      const el = this.els[i];
      const s = projectPoint(mvp, spec.anchor, vw, vh);
      if (!s.visible) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      el.style.left = `${s.x}px`;
      el.style.top = `${s.y}px`;
    });
  }

  destroy(): void {
    this.disconnectCamera();
    this.resizeObserver?.disconnect();
    for (const el of this.els) el.parentNode?.removeChild(el);
    this.els.length = 0;
  }
}
