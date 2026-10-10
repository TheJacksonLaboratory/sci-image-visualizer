import { Region, Rectangle, Polygon } from '../../models/region';
import { parseCssColor } from '../../contracts/color';
import { regionBBox, ringHandles, ringOf } from '../../region-overlay/region-geometry';
import { ScreenLayer, svgEl } from '../../region-overlay/svg-region-renderer';

/**
 * The OpenSeadragon region overlay's look: region stroke/fill, labels, the
 * selected region's handles, the marquee and the in-progress drawing. Pure SVG
 * builders over the shared {@link ScreenLayer} (image points in, screen-space
 * elements out), so the overlay itself keeps only lifecycle and gestures.
 */

type Pt = { x: number; y: number };

/** `color` with `alpha`; a colour that doesn't parse (a named one) is used as-is. */
export function rgba(color: string, alpha: number): string {
  const rgb = parseCssColor(color);
  return rgb ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})` : color;
}

/** Stroke/fill for a region shape (drawn in image coordinates by the renderer). */
export function styleRegionShape(el: SVGElement, region: Region, selected: boolean, shapeColor: string): void {
  const color = region.color || shapeColor;
  el.setAttribute('fill', selected ? rgba(color, 0.35) : 'none');
  el.setAttribute('stroke', color);
  el.setAttribute('stroke-width', selected ? '4' : '2');
}

/**
 * The class label (legend) just above the region's top-left — mirrors Plotly's
 * per-shape label, drawn in the region's colour. region.label is restored from
 * the shape's legend in getRegion().
 */
export function drawRegionLabel(layer: ScreenLayer, region: Region, shapeColor: string): void {
  const label = region.label;
  if (label == null || `${label}`.length === 0) return;
  // The loop-based bbox, not Math.min(...spread): spreading a large imported
  // annotation's vertices as arguments throws RangeError (OSD-PLOTLY-34).
  const bb = regionBBox(region);
  if (!bb) return;
  const text = svgEl('text');
  text.setAttribute('fill', region.color || shapeColor);
  text.setAttribute('font-size', '13');
  text.setAttribute('font-family', 'sans-serif');
  // Dark halo so the label stays legible over both bright and dark tiles.
  text.setAttribute('paint-order', 'stroke');
  text.setAttribute('stroke', 'rgba(0,0,0,0.65)');
  text.setAttribute('stroke-width', '2');
  text.textContent = `${label}`;
  layer.at(text, bb.x0, bb.y0, { dy: -4 });
}

/** A small vertex handle (filled when emphasised, hollow otherwise) at an image point. */
export function vertexMarker(layer: ScreenLayer, x: number, y: number, emphasised: boolean, color: string): void {
  const c = svgEl('circle');
  c.setAttribute('r', emphasised ? '5' : '4');
  c.setAttribute('fill', emphasised ? color : '#ffffff');
  c.setAttribute('stroke', color);
  c.setAttribute('stroke-width', '2');
  layer.at(c, x, y, { x: 'cx', y: 'cy' });
}

/**
 * The selected region's handles, in its own colour: every vertex of every ring
 * of a polygon (so a donut's inner outline shows its vertices — jit-ui#85), the
 * bezier anchors and control handles of a curved one, or a rectangle's corners.
 */
export function drawSelectionHandles(layer: ScreenLayer, region: Region, color: string): void {
  const b = region.bounds;
  if (b instanceof Polygon) {
    if (b.bezier) {
      drawBezierHandles(layer, b, color);
      return;
    }
    for (let ring = -1; ring < (b.holes?.length ?? 0); ring++) {
      const { xs, ys } = ringOf(b, ring);
      for (let i = 0; i < xs.length; i++) vertexMarker(layer, xs[i], ys[i], false, color);
    }
  } else if (b instanceof Rectangle) {
    // The four corners as grab/resize handles.
    const corners: [number, number][] = [
      [b.x, b.y], [b.x + b.width, b.y],
      [b.x + b.width, b.y + b.height], [b.x, b.y + b.height],
    ];
    for (const [cx, cy] of corners) vertexMarker(layer, cx, cy, false, color);
  }
}

/**
 * The bezier editing handles, paper.js-style: each anchor as a small square,
 * with tangent lines out to its two control points (drawn as small circles).
 * The exterior, then each donut hole ring (jit-ui#102): stored handles, or the
 * Catmull-Rom default the curve is drawn with — the ones hitHandle grabs.
 */
function drawBezierHandles(layer: ScreenLayer, poly: Polygon, color: string): void {
  for (let ring = -1; ring < (poly.holes?.length ?? 0); ring++) {
    const { xs, ys } = ringOf(poly, ring);
    const h = ringHandles(poly, ring);
    for (let i = 0; i < xs.length; i++) {
      if (h[i].hasIn) drawHandle(layer, xs[i], ys[i], h[i].in, color);
      if (h[i].hasOut) drawHandle(layer, xs[i], ys[i], h[i].out, color);
      anchorSquare(layer, xs[i], ys[i], color);
    }
  }
}

/** A tangent line from an anchor to a control point, with a circle at the end. */
function drawHandle(layer: ScreenLayer, ax: number, ay: number, ctrl: [number, number], color: string): void {
  const line = layer.line(ax, ay, ctrl[0], ctrl[1]);
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '1');
  const c = svgEl('circle');
  c.setAttribute('r', '3');
  c.setAttribute('fill', color);
  layer.at(c, ctrl[0], ctrl[1], { x: 'cx', y: 'cy' });
}

/** A filled-white anchor square (the editable vertex). */
function anchorSquare(layer: ScreenLayer, x: number, y: number, color: string): void {
  const r = 3.5;
  const rect = svgEl('rect');
  rect.setAttribute('width', `${2 * r}`); rect.setAttribute('height', `${2 * r}`);
  rect.setAttribute('fill', '#ffffff');
  rect.setAttribute('stroke', color);
  rect.setAttribute('stroke-width', '2');
  layer.at(rect, x, y, { dx: -r, dy: -r });
}

/** Marquee rectangle for rubber-band multi-select (dashed outline + faint fill). */
export function drawSelectionBand(layer: ScreenLayer, a: Pt, b: Pt): void {
  const el = layer.poly('polygon', [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }]);
  el.setAttribute('fill', 'rgba(120,170,255,0.15)');
  el.setAttribute('stroke', '#4a90e2');
  el.setAttribute('stroke-dasharray', '4 3');
  el.setAttribute('stroke-width', '1');
}

/** The rectangle being dragged out ('drawrect'). */
export function drawDraftRect(layer: ScreenLayer, a: Pt, b: Pt, color: string): void {
  styleDraft(layer.poly('polygon', [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }]),
    color);
}

/** The path traced or placed so far (freehand, polyline, click-to-place polygon). */
export function drawDraftPath(layer: ScreenLayer, pts: Pt[], color: string): void {
  styleDraft(layer.poly('polyline', pts.slice()), color);
}

function styleDraft(el: SVGElement, color: string): void {
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', color);
  el.setAttribute('stroke-dasharray', '4 3');
  el.setAttribute('stroke-width', '2');
}
