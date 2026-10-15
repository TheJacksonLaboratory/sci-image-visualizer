import { projectPoint, tintColormap } from 'napari-js';
import type { SurfaceLayer, Viewer } from 'napari-js';

import { screenRay } from './napari-mesh-pick';
import { VolumeFrame, toWorld } from './napari-volume-region-meshes';
import type { ZHandleCamera3D } from './napari-volume-z-handle';

/** A plane across the volume: x = const, y = const (image px) or z = const (a slice). */
export type PlaneAxis = 'x' | 'y' | 'z';

/** Where each plane is (image px for x and y, the slice for z); null: not shown. */
export type SlicePlanes = Record<PlaneAxis, number | null>;

/** Each plane's colour: its axis's, as the axes gizmo draws them. */
export const SLICE_PLANE_COLORS: Readonly<Record<PlaneAxis, string>> = {
  x: '#ff5c5c',
  y: '#4cd964',
  z: '#668cff',
};
/** A plane's opacity: enough to read where it is, not to hide the volume behind it … */
export const SLICE_PLANE_OPACITY = 0.22;
/** … and while it is dragged. */
export const SLICE_PLANE_DRAG_OPACITY = 0.4;

const AXES: readonly PlaneAxis[] = ['x', 'y', 'z'];
const AXIS_INDEX: Readonly<Record<PlaneAxis, number>> = { x: 0, y: 1, z: 2 };

export interface SlicePlanesOptions {
  /** A plane dragged to `value` along its axis (image px, or a fractional slice). */
  onMove(axis: PlaneAxis, value: number): void;
}

/**
 * The planes of the sections shown beside a volume view, drawn in the volume as translucent quads
 * in their axis's colour, each with a grip (a DOM handle at one of its edges, tracking the camera
 * like the Z-height handle) that drags it along its axis. Grips, not the planes themselves, take
 * the pointer: a plane facing the camera covers the whole volume, which must still orbit.
 */
export class VolumeSlicePlanes {
  private readonly layers = new Map<PlaneAxis, SurfaceLayer>();
  private readonly grips = new Map<PlaneAxis, HTMLDivElement>();
  private frame: VolumeFrame | null = null;
  private planes: SlicePlanes = { x: null, y: null, z: null };
  private drag: { axis: PlaneAxis; start: number; t0: number; pointer: number } | null = null;
  private readonly disconnectCamera: () => void;
  private readonly resizeObserver?: ResizeObserver;

  constructor(
    private readonly viewer: Viewer,
    private readonly host: HTMLElement,
    private readonly camera3d: ZHandleCamera3D,
    private readonly opts: SlicePlanesOptions,
  ) {
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    this.disconnectCamera = camera3d.changed.connect(() => this.placeGrips());
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.placeGrips());
      this.resizeObserver.observe(host);
    }
  }

  /** Follow the volume's frame (it opened, or its Z was stretched). */
  setFrame(frame: VolumeFrame): void {
    this.frame = frame;
    for (const axis of AXES) this.draw(axis);
    this.placeGrips();
  }

  /** Show the planes where they are now (null: hide one). */
  set(planes: SlicePlanes): void {
    const before = this.planes;
    this.planes = { ...planes };
    for (const axis of AXES) if (before[axis] !== planes[axis]) this.draw(axis);
    this.placeGrips();
  }

  clear(): void {
    for (const axis of AXES) this.remove(axis);
    for (const grip of this.grips.values()) grip.remove();
    this.grips.clear();
    this.planes = { x: null, y: null, z: null };
  }

  destroy(): void {
    this.clear();
    this.disconnectCamera();
    this.resizeObserver?.disconnect();
  }

  /** The image-space corners of the plane `axis = at` (z: slice k, centred like its voxels). */
  private corners(axis: PlaneAxis, at: number): Float32Array {
    const [w, h, d] = this.frame!.size;
    const z0 = -0.5,
      z1 = d - 0.5;
    if (axis === 'z') return Float32Array.of(0, 0, at, w, 0, at, w, h, at, 0, h, at);
    if (axis === 'x') return Float32Array.of(at, 0, z0, at, h, z0, at, h, z1, at, 0, z1);
    return Float32Array.of(0, at, z0, w, at, z0, w, at, z1, 0, at, z1);
  }

  private draw(axis: PlaneAxis): void {
    this.remove(axis);
    const at = this.planes[axis];
    if (!this.frame || at === null) return;
    const layer = this.viewer.addSurface(
      toWorld(this.corners(axis, at), this.frame),
      Uint32Array.of(0, 1, 2, 0, 2, 3),
      new Float32Array(4).fill(1),
      {
        name: `${axis} plane`,
        colormap: tintColormap(SLICE_PLANE_COLORS[axis]),
        contrastLimits: [0, 1],
        opacity: this.drag?.axis === axis ? SLICE_PLANE_DRAG_OPACITY : SLICE_PLANE_OPACITY,
        blending: 'translucent',
        fit: 'never',
      },
    );
    this.layers.set(axis, layer);
    this.viewer.requestRender();
  }

  private remove(axis: PlaneAxis): void {
    const layer = this.layers.get(axis);
    if (!layer) return;
    this.viewer.layers.remove(layer);
    this.layers.delete(axis);
    this.viewer.requestRender();
  }

  /** The world point a plane's grip sits on: the middle of one of its edges, a different one per axis. */
  private anchor(axis: PlaneAxis, at: number): [number, number, number] {
    const [w, h, d] = this.frame!.size;
    const mid = (d - 1) / 2;
    const p = axis === 'z' ? [w, h / 2, at] : axis === 'x' ? [at, 0, mid] : [0, at, mid];
    return Array.from(toWorld(Float32Array.from(p), this.frame!)) as [number, number, number];
  }

  private placeGrips(): void {
    const vw = this.host.clientWidth;
    const vh = this.host.clientHeight;
    for (const axis of AXES) {
      const at = this.planes[axis];
      if (!this.frame || at === null) {
        this.grips.get(axis)?.remove();
        this.grips.delete(axis);
        continue;
      }
      const grip = this.grips.get(axis) ?? this.makeGrip(axis);
      const s =
        vw > 0 && vh > 0
          ? projectPoint(this.camera3d.viewProjection(vw, vh), this.anchor(axis, at), vw, vh)
          : null;
      grip.style.display = s?.visible ? '' : 'none';
      if (s?.visible) {
        grip.style.left = `${s.x}px`;
        grip.style.top = `${s.y}px`;
      }
      grip.title = `Drag to move the ${axis.toUpperCase()} plane (${axis === 'z' ? 'slice ' : ''}${Math.round(at)}${axis === 'z' ? '' : ' px'})`;
    }
  }

  private makeGrip(axis: PlaneAxis): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'napari-slice-plane-grip';
    el.dataset['axis'] = axis;
    Object.assign(el.style, {
      position: 'absolute',
      zIndex: '31',
      width: '20px',
      height: '20px',
      marginLeft: '-10px',
      marginTop: '-10px',
      borderRadius: '50%',
      background: SLICE_PLANE_COLORS[axis],
      border: '1.5px solid #fff',
      boxShadow: '0 0 4px rgba(0,0,0,0.6)',
      color: '#fff',
      font: 'bold 11px/17px sans-serif',
      textAlign: 'center',
      cursor: 'grab',
      touchAction: 'none',
      userSelect: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    el.textContent = axis.toUpperCase();
    el.addEventListener('pointerdown', (e) => this.onDown(axis, e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', (e) => this.onUp(e));
    this.host.appendChild(el);
    this.grips.set(axis, el);
    return el;
  }

  private onDown(axis: PlaneAxis, e: PointerEvent): void {
    const at = this.planes[axis];
    if (at === null || !this.frame) return;
    e.preventDefault();
    e.stopPropagation(); // not an orbit
    const t0 = this.axisParam(axis, at, e);
    if (t0 === null) return;
    this.drag = { axis, start: at, t0, pointer: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    (e.currentTarget as HTMLElement).style.cursor = 'grabbing';
    this.draw(axis);
  }

  private onMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointer || !this.frame) return;
    e.preventDefault();
    e.stopPropagation();
    const t = this.axisParam(drag.axis, drag.start, e);
    if (t === null) return;
    const a = AXIS_INDEX[drag.axis];
    // World units along the axis → image px (or slices) along it.
    const perUnit = this.frame.world[a] / this.frame.size[a];
    const max = drag.axis === 'z' ? this.frame.size[2] - 1 : this.frame.size[a] - 1;
    this.opts.onMove(drag.axis, Math.min(max, Math.max(0, drag.start + (t - drag.t0) / perUnit)));
  }

  private onUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointer) return;
    this.drag = null;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture?.(e.pointerId);
    el.style.cursor = 'grab';
    this.draw(drag.axis);
  }

  /**
   * Where the pointer is along the plane's axis: the parameter (world units, from the plane's centre
   * at `at`) of the point of the axis line nearest the pointer's ray. Null when the ray runs along it.
   */
  private axisParam(axis: PlaneAxis, at: number, e: PointerEvent): number | null {
    const box = this.host.getBoundingClientRect();
    const vw = this.host.clientWidth;
    const vh = this.host.clientHeight;
    if (vw <= 0 || vh <= 0) return null;
    const ray = screenRay(this.camera3d.viewProjection(vw, vh), e.clientX - box.left, e.clientY - box.top, vw, vh);
    if (!ray) return null;
    const [w, h, d] = this.frame!.size;
    const centre = [w / 2, h / 2, (d - 1) / 2];
    centre[AXIS_INDEX[axis]] = at;
    const p = toWorld(Float32Array.from(centre), this.frame!);
    const dir = [0, 0, 0];
    dir[AXIS_INDEX[axis]] = 1;
    // The nearest points of the line p + t·dir and the ray o + s·r.
    const w0 = [p[0] - ray.origin[0], p[1] - ray.origin[1], p[2] - ray.origin[2]];
    const r = ray.dir;
    const b = dir[0] * r[0] + dir[1] * r[1] + dir[2] * r[2];
    const c = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    const dd = dir[0] * w0[0] + dir[1] * w0[1] + dir[2] * w0[2];
    const ee = r[0] * w0[0] + r[1] * w0[1] + r[2] * w0[2];
    const denom = c - b * b; // |dir| = 1
    if (Math.abs(denom) < 1e-9 * c) return null;
    return (b * ee - c * dd) / denom;
  }
}
