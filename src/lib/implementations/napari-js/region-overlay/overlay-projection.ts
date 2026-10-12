import { PIXEL_WORLD_QUANTUM, snapToWorldGrid } from '../../../spatial/world-grid';
import type { ToScreen } from '../../../region-overlay/region-geometry';
import { Affine, applyAffine } from '../../../region-overlay/svg-region-renderer';
import type { OverlayViewer } from '../napari-region-overlay';

/**
 * The region overlay's coordinate spaces: pointer CLIENT pixels, svg-LOCAL pixels and WORLD
 * units, through the viewer's own transforms (see {@link OverlayViewer}).
 *
 * World → svg-local is the viewer's camera affine (`canvasTransform`), which reads no layout, so
 * drawing and following the camera read none. Only a pointer, in client pixels, needs the svg's
 * client origin: read once per {@link withOrigin} block (a gesture event), as an uncached read
 * per vertex — interleaved with the elements a redraw appends — forced a synchronous layout per
 * vertex (review NAPARI-BOUNDARY-10).
 */
export class OverlayProjection {
  /**
   * How finely a drawn vertex may be placed, in world units.
   *
   * One by default, because for an image the world IS pixels and a region should align to
   * them. A dataset whose coordinates are not pixels sets it finer — seqFISH's whole
   * sample spans about 5 x 7 units, where whole-unit vertices leave roughly six by eight
   * placeable positions and no ROI can be drawn at all.
   */
  private worldQuantum = PIXEL_WORLD_QUANTUM;
  /** The svg's client origin and the camera affine, cached while a {@link withOrigin} block runs. */
  private origin: { left: number; top: number } | null = null;
  private camera: Affine | null = null;

  constructor(
    private readonly svg: SVGSVGElement,
    private readonly viewer: OverlayViewer,
  ) {}

  setWorldQuantum(quantum: number): void {
    this.worldQuantum = Number.isFinite(quantum) && quantum > 0 ? quantum : PIXEL_WORLD_QUANTUM;
  }

  /** Pointer client coords → world coords, snapped to the world quantum (for placing vertices). */
  toImage(clientX: number, clientY: number): [number, number] {
    const [wx, wy] = this.viewer.canvasToWorld(clientX, clientY);
    return [snapToWorldGrid(wx, this.worldQuantum), snapToWorldGrid(wy, this.worldQuantum)];
  }

  /** Pointer client coords → world coords, exact (for picking: snapping is for placing). */
  toWorld(clientX: number, clientY: number): [number, number] {
    return this.viewer.canvasToWorld(clientX, clientY);
  }

  /**
   * World units spanned by one screen pixel, measured through the viewer's own transform.
   *
   * Read from the transform rather than from the camera, so it holds for both the 2D and
   * the 3D screen-space adapters without either having to expose a zoom. Falls back to 1
   * if the transform gives nothing usable, which keeps the established pixel behaviour
   * rather than collapsing the threshold to zero and recording a point per event.
   */
  worldPerCanvasPixel(): number {
    const [x0] = this.viewer.canvasToWorld(0, 0);
    const [x1] = this.viewer.canvasToWorld(1, 0);
    const per = Math.abs(x1 - x0);
    return Number.isFinite(per) && per > 0 ? per : 1;
  }

  /** Run `fn` with the svg's client origin and the camera affine read once (nested calls reuse them). */
  withOrigin<T>(fn: () => T): T {
    if (this.origin) return fn();
    const r = this.svg.getBoundingClientRect();
    this.origin = { left: r.left, top: r.top };
    this.camera = this.viewer.canvasTransform();
    try {
      return fn();
    } finally {
      this.origin = null;
      this.camera = null;
    }
  }

  /** Client px → SVG-local px. */
  clientToLocal(clientX: number, clientY: number): [number, number] {
    const o = this.origin ?? this.svg.getBoundingClientRect();
    return [clientX - o.left, clientY - o.top];
  }

  /** World coords → SVG-local px, through the camera affine: no layout read. */
  toLocal(imgX: number, imgY: number): [number, number] {
    return applyAffine(this.affine(), imgX, imgY);
  }

  /** {@link toLocal} as the shared region geometry takes it. */
  readonly toScreen: ToScreen = (x, y) => this.toLocal(x, y);

  /** Screen distance (px) between a client point and a world point. */
  screenDist(clientX: number, clientY: number, imgX: number, imgY: number): number {
    const [lx, ly] = this.toLocal(imgX, imgY);
    const [px, py] = this.clientToLocal(clientX, clientY);
    return Math.hypot(px - lx, py - ly);
  }

  /**
   * The world → svg-local affine for the current camera: the viewer's `canvasTransform`, which
   * reads no layout. The svg and the canvas share an origin (see {@link OverlayViewer}).
   */
  affine(): Affine {
    return this.camera ?? this.viewer.canvasTransform();
  }
}
