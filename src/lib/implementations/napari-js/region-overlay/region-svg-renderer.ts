import { Polygon, Rectangle, Region } from '../../../models/region';
import type { RegionStore } from '../../../store/region-store.service';
import { regionBBox, ringHandles, ringOf } from '../../../region-overlay/region-geometry';
import { Affine, ScreenLayer, SvgRegionRenderer, svgEl } from '../../../region-overlay/svg-region-renderer';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Rendered handle size (screen px). */
export const HANDLE_SIZE = 7;

/** An axis-aligned box from a drag's start to its current point (any order). */
export interface DragBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A region being drawn: a rectangle drag, or a freehand / click-placed path. */
export interface RegionDraft {
  rect: DragBox | null;
  path: Array<[number, number]> | null;
}

/**
 * What the napari region overlay draws, over the shared {@link SvgRegionRenderer}: the regions
 * in world coordinates (styled from the store's colours, labelled when labels are on), and in
 * screen space the selected regions' grab handles (corners, vertices, bézier control points),
 * the draft being drawn and the rubber-band marquee.
 */
export class NapariRegionSvgRenderer {
  private readonly renderer: SvgRegionRenderer;
  /** Dedicated marquee rect element, updated directly during the drag (no full region redraw). */
  private marqueeEl: SVGRectElement | null = null;

  constructor(
    private readonly svg: SVGSVGElement,
    private readonly store: RegionStore,
  ) {
    this.renderer = new SvgRegionRenderer(svg, {
      rectElement: 'rect',
      styleShape: (el, region, selected) => this.style(el, this.strokeOf(region), selected),
      decorate: (region, _i, _selected, layer) => this.drawLabel(region, layer),
      skip: (region) => !!region.isProfile?.(),
    });
  }

  /** Follow the camera: one transform attribute plus the screen-space elements. */
  setCamera(affine: Affine): void {
    this.renderer.setCamera(affine);
  }

  /** Rebuild the regions (world space) and their labels. */
  render(regions: readonly Region[], selected: readonly number[]): void {
    this.renderer.render(regions, selected);
  }

  /** Rebuild the screen-space overlay only: the selected regions' handles and the draft. */
  renderOverlay(regions: readonly Region[], selected: readonly number[], draft: RegionDraft): void {
    this.renderer.renderOverlay((layer) => {
      for (const i of selected) {
        const region = regions[i];
        if (region && !region.isProfile?.()) this.drawHandles(region, layer);
      }
      this.drawDraft(draft, layer);
    });
  }

  /** Show the marquee over svg-local corners `(lx, ly)`–`(rx, ry)`, creating it on first use. */
  showMarquee(lx: number, ly: number, rx: number, ry: number): void {
    if (!this.marqueeEl || !this.marqueeEl.parentNode) {
      this.marqueeEl = document.createElementNS(SVG_NS, 'rect');
      this.marqueeEl.setAttribute('stroke', '#4da3ff');
      this.marqueeEl.setAttribute('stroke-width', '1');
      this.marqueeEl.setAttribute('stroke-dasharray', '4 3');
      this.marqueeEl.setAttribute('fill', '#4da3ff');
      this.marqueeEl.setAttribute('fill-opacity', '0.12');
      this.marqueeEl.setAttribute('vector-effect', 'non-scaling-stroke');
      this.svg.appendChild(this.marqueeEl);
    }
    this.marqueeEl.setAttribute('x', `${lx}`);
    this.marqueeEl.setAttribute('y', `${ly}`);
    this.marqueeEl.setAttribute('width', `${Math.abs(rx - lx)}`);
    this.marqueeEl.setAttribute('height', `${Math.abs(ry - ly)}`);
  }

  /** Remove the marquee element from the SVG. */
  clearMarquee(): void {
    if (this.marqueeEl?.parentNode) this.marqueeEl.parentNode.removeChild(this.marqueeEl);
    this.marqueeEl = null;
  }

  /** A region's outline colour. */
  private strokeOf(region: Region): string {
    return region.color || this.store.getShapeColor() || '#00ffff';
  }

  /** Draw a region's classification label at its top-left, when labels are enabled (matches OSD). */
  private drawLabel(region: Region, layer: ScreenLayer): void {
    if (!this.store.getShowShapeLabel() || region.isProfile?.()) return;
    const label = region.label;
    const bb = label ? regionBBox(region) : null;
    if (!label || !bb) return;
    const text = svgEl('text');
    text.setAttribute('fill', '#fff');
    text.setAttribute('stroke', '#000');
    text.setAttribute('stroke-width', '3');
    text.setAttribute('paint-order', 'stroke');
    text.setAttribute('font', '12px sans-serif');
    text.setAttribute('pointer-events', 'none');
    text.textContent = label;
    layer.at(text, bb.x0, bb.y0, { dy: -4 });
  }

  /** Draw grab handles for a selected region: rectangle corners or polygon vertices. */
  private drawHandles(region: Region, layer: ScreenLayer): void {
    const b = region.bounds;
    if (!b) return;
    const stroke = this.strokeOf(region);
    const handle = (imgX: number, imgY: number): void => {
      const el = svgEl('rect');
      el.setAttribute('width', `${HANDLE_SIZE}`);
      el.setAttribute('height', `${HANDLE_SIZE}`);
      el.setAttribute('fill', '#fff');
      el.setAttribute('stroke', stroke);
      el.setAttribute('stroke-width', '1.5');
      layer.at(el, imgX, imgY, { dx: -HANDLE_SIZE / 2, dy: -HANDLE_SIZE / 2 });
    };
    if (b instanceof Rectangle) {
      handle(b.x, b.y);
      handle(b.x + b.width, b.y);
      handle(b.x, b.y + b.height);
      handle(b.x + b.width, b.y + b.height);
    } else if (b instanceof Polygon) {
      for (let i = 0; i < b.npoints; i++) handle(b.xpoints[i], b.ypoints[i]);
      for (const ring of b.holes ?? []) for (const [hx, hy] of ring) handle(hx, hy);
      // Bezier regions also expose their tangent control points (circles) joined to the anchor
      // by a thin line, matching the OSD overlay's editable bezier handles. Stored handles when
      // present, else the Catmull-Rom default the curve is drawn with.
      if (b.bezier) {
        for (let ring = -1; ring < (b.holes?.length ?? 0); ring++) {
          const { xs, ys } = ringOf(b, ring);
          ringHandles(b, ring).forEach((h, i) => {
            if (h.hasOut) this.drawBezierHandle(xs[i], ys[i], h.out, stroke, layer);
            if (h.hasIn) this.drawBezierHandle(xs[i], ys[i], h.in, stroke, layer);
          });
        }
      }
    }
  }

  /** Draw one bezier control point as a small circle connected to its anchor by a tangent line.
   *  `handle` is the control point's absolute position in image space. */
  private drawBezierHandle(
    ax: number,
    ay: number,
    handle: [number, number],
    stroke: string,
    layer: ScreenLayer,
  ): void {
    if (handle[0] === ax && handle[1] === ay) return;
    const line = layer.line(ax, ay, handle[0], handle[1]);
    line.setAttribute('stroke', stroke);
    line.setAttribute('stroke-width', '1');
    line.setAttribute('stroke-opacity', '0.7');
    const dot = svgEl('circle');
    dot.setAttribute('r', `${HANDLE_SIZE / 2}`);
    dot.setAttribute('fill', stroke);
    dot.setAttribute('stroke', '#fff');
    dot.setAttribute('stroke-width', '1');
    layer.at(dot, handle[0], handle[1], { x: 'cx', y: 'cy' });
  }

  private style(el: SVGElement, stroke: string, isSelected: boolean): void {
    el.setAttribute('stroke', stroke);
    el.setAttribute('stroke-width', isSelected ? '4' : '2');
    el.setAttribute('fill', isSelected ? stroke : 'none');
    el.setAttribute('fill-opacity', isSelected ? '0.35' : '0');
  }

  /** Draw the in-progress rectangle / path preview. */
  private drawDraft(draft: RegionDraft, layer: ScreenLayer): void {
    if (draft.rect) {
      const { x0, y0, x1, y1 } = draft.rect;
      const el = svgEl('rect');
      layer.place(el, (e, project) => {
        const [lx, ly] = project(Math.min(x0, x1), Math.min(y0, y1));
        const [rx, ry] = project(Math.max(x0, x1), Math.max(y0, y1));
        e.setAttribute('x', `${lx}`);
        e.setAttribute('y', `${ly}`);
        e.setAttribute('width', `${Math.abs(rx - lx)}`);
        e.setAttribute('height', `${Math.abs(ry - ly)}`);
      });
      this.styleDraft(el);
    }
    if (draft.path && draft.path.length) {
      this.styleDraft(
        layer.poly(
          'polyline',
          draft.path.map(([x, y]) => ({ x, y })),
        ),
      );
    }
  }

  private styleDraft(el: SVGElement): void {
    el.setAttribute('stroke', this.store.getShapeColor() || '#00ffff');
    el.setAttribute('stroke-width', '2');
    el.setAttribute('stroke-dasharray', '4 3');
    el.setAttribute('fill', 'none');
    el.setAttribute('vector-effect', 'non-scaling-stroke');
  }
}
