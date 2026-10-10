/**
 * World-space SVG region renderer shared by the OpenSeadragon and napari
 * overlays (review NAPARI-BOUNDARY-10, OSD-PLOTLY-11).
 *
 * The overlays used to delete and rebuild every region element on every camera
 * frame, projecting every vertex to screen pixels (napari also read the layout
 * once per vertex). Here region geometry is drawn ONCE, in world coordinates,
 * inside a single `<g transform="matrix(a b c d e f)">`, with
 * `vector-effect: non-scaling-stroke` so strokes keep their pixel width. A
 * camera change rewrites that one attribute and re-positions the few
 * screen-sized elements (labels, the selected region's handles, a draft) —
 * nothing is created or removed. Region nodes are rebuilt only when the
 * regions or the selection change ({@link render}).
 *
 * Layers, bottom to top, each attached only while it has content:
 *  1. world   — region shapes, in world coordinates (transformed group);
 *  2. labels  — screen-space text pinned to world anchors, rebuilt with the regions;
 *  3. overlay — screen-space handles/drafts, rebuilt by the overlay on demand
 *     ({@link renderOverlay}).
 */
import { MultiPolygon, Polygon, Rectangle, Region } from '../models/region';
import { WORLD, boundsKind, regionHasHoles, regionPathD } from './region-geometry';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An SVG affine `matrix(a b c d e f)`: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = readonly [number, number, number, number, number, number];

/** World → svg-local pixel projection. */
export type Project = (x: number, y: number) => [number, number];

export const IDENTITY_AFFINE: Affine = [1, 0, 0, 1, 0, 0];

/**
 * The affine of a projection that is affine (pan/zoom/rotate/flip), read from
 * where it sends (0,0), (1,0) and (0,1). Both overlays' world → screen
 * projections are: OSD's viewport transform, and napari-js's
 * `worldToCanvas` (camera centre/zoom plus the canvas rect), so this is how
 * either gets its matrix without depending on viewer internals.
 */
export function affineFromProjection(project: (x: number, y: number) => readonly [number, number]): Affine {
  const [ox, oy] = project(0, 0);
  const [ux, uy] = project(1, 0);
  const [vx, vy] = project(0, 1);
  return [ux - ox, uy - oy, vx - ox, vy - oy, ox, oy];
}

/** Apply an affine to a point. */
export function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** How a placed screen element is (re)positioned for the current camera. */
export type Placement<T extends SVGElement> = (el: T, project: Project) => void;

/** Options for {@link SvgRegionRenderer}. */
export interface SvgRegionRendererOptions {
  /** Draw a {@link Rectangle} as a `<rect>` or as a four-point `<polygon>`. Default polygon. */
  rectElement?: 'rect' | 'polygon';
  /** Stroke and fill for one region's shape element. */
  styleShape(el: SVGElement, region: Region, selected: boolean): void;
  /** Add a region's screen-space decorations (its label) — once per {@link render}. */
  decorate?(region: Region, index: number, selected: boolean, layer: ScreenLayer): void;
  /** Leave a region out entirely (it keeps its index). */
  skip?(region: Region): boolean;
}

/**
 * A screen-space layer: elements positioned from world anchors through the
 * current camera, re-positioned (not rebuilt) on every camera change.
 */
export class ScreenLayer {
  private readonly placed: Array<{ el: SVGElement; place: Placement<SVGElement> }> = [];

  constructor(readonly group: SVGGElement, private readonly project: Project) {}

  /** Append `el`, positioned by `place` now and after every camera change. */
  place<T extends SVGElement>(el: T, place: Placement<T>): T {
    place(el, this.project);
    this.group.appendChild(el);
    this.placed.push({ el, place: place as Placement<SVGElement> });
    return el;
  }

  /** Append `el` with attributes `x`/`y` (e.g. `'cx'`/`'cy'`) at a world point, offset in pixels. */
  at<T extends SVGElement>(el: T, wx: number, wy: number,
                           attrs: { x?: string; y?: string; dx?: number; dy?: number } = {}): T {
    const { x = 'x', y = 'y', dx = 0, dy = 0 } = attrs;
    return this.place(el, (e, project) => {
      const [sx, sy] = project(wx, wy);
      e.setAttribute(x, `${sx + dx}`);
      e.setAttribute(y, `${sy + dy}`);
    });
  }

  /** A `<line>` between two world points. */
  line(ax: number, ay: number, bx: number, by: number): SVGLineElement {
    return this.place(svgEl('line'), (e, project) => {
      const [x1, y1] = project(ax, ay);
      const [x2, y2] = project(bx, by);
      e.setAttribute('x1', `${x1}`);
      e.setAttribute('y1', `${y1}`);
      e.setAttribute('x2', `${x2}`);
      e.setAttribute('y2', `${y2}`);
    });
  }

  /** A `<polygon>` / `<polyline>` through world points. */
  poly(tag: 'polygon' | 'polyline', pts: ReadonlyArray<{ x: number; y: number }>): SVGElement {
    return this.place(svgEl(tag), (e, project) => {
      e.setAttribute('points', pts.map((p) => project(p.x, p.y).join(',')).join(' '));
    });
  }

  /** Re-position every element for the current camera. */
  reproject(): void {
    for (const { el, place } of this.placed) place(el, this.project);
  }

  get isEmpty(): boolean {
    return !this.group.firstChild;
  }

  clear(): void {
    this.placed.length = 0;
    while (this.group.firstChild) this.group.removeChild(this.group.firstChild);
  }
}

/** Create an SVG element. */
export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

export class SvgRegionRenderer {
  private camera: Affine = IDENTITY_AFFINE;
  private readonly world = svgEl('g');
  private readonly labels: ScreenLayer;
  private readonly overlay: ScreenLayer;

  /** World → svg-local pixels through the current camera. */
  readonly project: Project = (x, y) => applyAffine(this.camera, x, y);

  constructor(private readonly svg: SVGSVGElement, private readonly opts: SvgRegionRendererOptions) {
    this.world.setAttribute('data-layer', 'regions');
    this.labels = new ScreenLayer(svgEl('g'), this.project);
    this.labels.group.setAttribute('data-layer', 'labels');
    this.overlay = new ScreenLayer(svgEl('g'), this.project);
    this.overlay.group.setAttribute('data-layer', 'overlay');
    this.applyCamera();
  }

  /** The current world → svg-local affine. */
  get affine(): Affine {
    return this.camera;
  }

  /**
   * Move the camera: rewrite the world group's transform and re-position the
   * screen-space elements. No element is created or removed. Returns false
   * (and touches nothing) when the affine did not change.
   */
  setCamera(affine: Affine): boolean {
    if (!affine.every(Number.isFinite)) return false;
    if (affine.every((v, i) => v === this.camera[i])) return false;
    this.camera = affine;
    this.applyCamera();
    this.labels.reproject();
    this.overlay.reproject();
    return true;
  }

  /** Rebuild the region shapes (world space) and their decorations. */
  render(regions: ReadonlyArray<Region>, selected: ReadonlyArray<number>): void {
    const shapes = document.createDocumentFragment();
    this.labels.clear();
    const sel = new Set(selected);
    regions.forEach((region, i) => {
      if (this.opts.skip?.(region)) return;
      const isSel = sel.has(i);
      const el = this.shapeOf(region);
      if (el) {
        el.setAttribute('vector-effect', 'non-scaling-stroke');
        this.opts.styleShape(el, region, isSel);
        shapes.appendChild(el);
      }
      this.opts.decorate?.(region, i, isSel, this.labels);
    });
    while (this.world.firstChild) this.world.removeChild(this.world.firstChild);
    this.world.appendChild(shapes);
    this.sync();
  }

  /** Rebuild the overlay layer (the selected region's handles, drafts). */
  renderOverlay(build: (layer: ScreenLayer) => void): void {
    this.overlay.clear();
    build(this.overlay);
    this.sync();
  }

  /** Remove every layer from the svg. */
  destroy(): void {
    for (const g of [this.world, this.labels.group, this.overlay.group]) g.parentNode?.removeChild(g);
  }

  private applyCamera(): void {
    this.world.setAttribute('transform', `matrix(${this.camera.join(' ')})`);
  }

  /** Attach the layers that have content (in order) and detach the empty ones. */
  private sync(): void {
    const layers: Array<[SVGGElement, boolean]> = [
      [this.world, !!this.world.firstChild],
      [this.labels.group, !this.labels.isEmpty],
      [this.overlay.group, !this.overlay.isEmpty],
    ];
    let before: ChildNode | null = null;
    for (let i = layers.length - 1; i >= 0; i--) {
      const [g, show] = layers[i];
      if (!show) {
        g.parentNode?.removeChild(g);
        continue;
      }
      if (g.parentNode !== this.svg || g.nextSibling !== before) {
        if (before) this.svg.insertBefore(g, before);
        else if (g.parentNode !== this.svg) this.svg.appendChild(g);
      }
      before = g;
    }
  }

  /** The world-space element for a region's geometry, or null when it has none. */
  private shapeOf(region: Region): SVGElement | null {
    const b = region.bounds;
    switch (boundsKind(b)) {
      case 'rect': {
        const r = b as Rectangle;
        const x0 = Math.min(r.x, r.x + r.width), y0 = Math.min(r.y, r.y + r.height);
        const w = Math.abs(r.width), h = Math.abs(r.height);
        if (this.opts.rectElement === 'rect') {
          const el = svgEl('rect');
          el.setAttribute('x', `${x0}`);
          el.setAttribute('y', `${y0}`);
          el.setAttribute('width', `${w}`);
          el.setAttribute('height', `${h}`);
          return el;
        }
        const el = svgEl('polygon');
        el.setAttribute('points', `${x0},${y0} ${x0 + w},${y0} ${x0 + w},${y0 + h} ${x0},${y0 + h}`);
        return el;
      }
      case 'poly': {
        const p = b as Polygon;
        const n = p.xpoints?.length ?? 0;
        if (n === 0) return null;
        const holes = regionHasHoles(region);
        if ((p.bezier && n >= 2) || holes) return pathEl(regionPathD(region, WORLD), holes);
        const el = svgEl(p.closed === false ? 'polyline' : 'polygon');
        let pts = '';
        for (let i = 0; i < n; i++) pts += `${i ? ' ' : ''}${p.xpoints[i]},${p.ypoints[i]}`;
        el.setAttribute('points', pts);
        return el;
      }
      case 'multi': {
        const parts = (b as MultiPolygon).polygons;
        if (!parts.some((p) => (p.xpoints?.length ?? 0) >= 3)) return null;
        return pathEl(regionPathD(region, WORLD), true);
      }
      default:
        return null;
    }
  }
}

function pathEl(d: string, evenOdd: boolean): SVGPathElement {
  const el = svgEl('path');
  el.setAttribute('d', d);
  if (evenOdd) el.setAttribute('fill-rule', 'evenodd');
  return el;
}
