/**
 * How regions are drawn, shared by the OpenSeadragon and napari overlays and the region-source
 * layer, so a feature looks the same before and after it is taken into the regions.
 *
 * Two looks: **outlines** (the default — each region stroked in its colour, filled only while
 * selected) and **filled**, an atlas's look (each region filled in its colour, with thin outlines,
 * the selection in a highlight colour, labels centred inside each part).
 */
import { MultiPolygon, Polygon, Rectangle, Region } from '../models/region';
import { polylabel } from '../geometry/polylabel';
import type { Project, ScreenLayer } from './svg-region-renderer';
import { svgEl } from './svg-region-renderer';

/** The region look (see the module doc). */
export interface RegionStyle {
  /** Fill each region at this opacity; 0 draws outlines only. */
  fillOpacity: number;
  /** Outline colour of a filled region; null: its own colour. */
  stroke: string | null;
  /** Outline width of a filled region, screen px; null: 1. */
  strokeWidth: number | null;
  /** Fill colour of a selected filled region; null: {@link DEFAULT_HIGHLIGHT}. */
  highlight: string | null;
}

export const DEFAULT_REGION_STYLE: RegionStyle = {
  fillOpacity: 0,
  stroke: null,
  strokeWidth: null,
  highlight: null,
};

/** A selected region's fill in the filled look, unless the style names one (the Allen atlas's). */
export const DEFAULT_HIGHLIGHT = '#a020f0';

/** Whether `style` is the filled look. */
export function isFilled(style: RegionStyle): boolean {
  return style.fillOpacity > 0;
}

/** The paint of one region shape. */
export interface ShapePaint {
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeWidth: number;
}

/** The paint of a region of colour `color`, selected or not, in `style`. */
export function shapePaint(
  color: string,
  selected: boolean,
  style: RegionStyle = DEFAULT_REGION_STYLE,
): ShapePaint {
  if (!isFilled(style)) {
    return selected
      ? { fill: color, fillOpacity: 0.35, stroke: color, strokeWidth: 4 }
      : { fill: 'none', fillOpacity: 0, stroke: color, strokeWidth: 2 };
  }
  const width = style.strokeWidth ?? 1;
  return selected
    ? {
        fill: style.highlight ?? DEFAULT_HIGHLIGHT,
        fillOpacity: Math.max(style.fillOpacity, 0.85),
        stroke: style.stroke ?? color,
        strokeWidth: width + 1,
      }
    : { fill: color, fillOpacity: style.fillOpacity, stroke: style.stroke ?? color, strokeWidth: width };
}

/** Set `paint` on an SVG shape. */
export function applyPaint(el: SVGElement, paint: ShapePaint): void {
  el.setAttribute('fill', paint.fill);
  el.setAttribute('fill-opacity', `${paint.fillOpacity}`);
  el.setAttribute('stroke', paint.stroke);
  el.setAttribute('stroke-width', `${paint.strokeWidth}`);
}

/** A point to label a part at, and the room around it (image px). */
export interface LabelSpot {
  x: number;
  y: number;
  room: number;
}

/** Where to label `region`: each part's pole of inaccessibility (a rectangle's centre). */
export function regionLabelSpots(region: Region): LabelSpot[] {
  const b = region.bounds;
  if (b instanceof Rectangle) {
    const room = Math.min(Math.abs(b.width), Math.abs(b.height)) / 2;
    return [{ x: b.x + b.width / 2, y: b.y + b.height / 2, room }];
  }
  const parts = b instanceof MultiPolygon ? b.polygons : b instanceof Polygon && b.closed !== false ? [b] : [];
  const spots: LabelSpot[] = [];
  for (const p of parts) {
    const rings: Float64Array[] = [Float64Array.from(p.xpoints.flatMap((x, i) => [x, p.ypoints[i]]))];
    for (const hole of p.holes ?? []) rings.push(Float64Array.from(hole.flat()));
    const pole = polylabel(rings);
    if (pole && pole.distance > 0) spots.push({ x: pole.x, y: pole.y, room: pole.distance });
  }
  return spots;
}

/** Font size of a centred label, px. */
const INSIDE_LABEL_PX = 10;

/**
 * A class label centred at `spot`, shown only while it fits: the room around the spot, on screen,
 * at least half the text's width (and a few pixels). Re-checked on every camera move.
 */
export function placeInsideLabel(
  layer: ScreenLayer,
  text: string,
  spot: LabelSpot,
  color = '#111',
): SVGTextElement {
  const el = svgEl('text');
  el.setAttribute('fill', color);
  el.setAttribute('font-size', `${INSIDE_LABEL_PX}`);
  el.setAttribute('font-family', 'sans-serif');
  el.setAttribute('text-anchor', 'middle');
  el.setAttribute('dominant-baseline', 'central');
  el.setAttribute('pointer-events', 'none');
  el.textContent = text;
  const halfWidth = (text.length * INSIDE_LABEL_PX * 0.6) / 2;
  return layer.place(el, (e, project) => {
    const [sx, sy] = project(spot.x, spot.y);
    e.setAttribute('x', `${sx}`);
    e.setAttribute('y', `${sy}`);
    e.style.display = labelFits(project, spot, halfWidth) ? '' : 'none';
  });
}

/** Whether a label `halfWidth` px wide fits around `spot` through `project`. */
export function labelFits(project: Project, spot: LabelSpot, halfWidth: number): boolean {
  const [ax, ay] = project(spot.x, spot.y);
  const [bx, by] = project(spot.x + spot.room, spot.y);
  const roomPx = Math.hypot(bx - ax, by - ay);
  return roomPx >= Math.max(halfWidth * 0.8, INSIDE_LABEL_PX * 0.6);
}
