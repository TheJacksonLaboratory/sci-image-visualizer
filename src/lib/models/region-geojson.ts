/**
 * GeoJSON I/O for the region model (review CORE-25, OSD-PLOTLY-35).
 *
 * Pure functions between {@link Region}s and a QuPath-compatible GeoJSON
 * FeatureCollection string, plus {@link downloadGeoJson} (the one DOM-touching
 * helper, a file download). `RegionStore` calls these directly; the
 * `PlotUtilities` methods of the same purpose delegate here for compatibility.
 *
 * Mapping:
 *  - `Rectangle` ⇄ a five-point Polygon ring (a single axis-aligned ring with
 *    no holes reads back as a Rectangle);
 *  - closed `Polygon` ⇄ `Polygon` (extra rings are holes);
 *  - open `Polygon` ⇄ `LineString`;
 *  - `MultiPolygon` ⇄ `MultiPolygon`;
 *  - a bézier region's geometry is its flattened curve, with the editable
 *    anchors, handles and hole handles in `properties`;
 *  - a non-default slice travels as `geometry.plane.z` (QuPath's schema);
 *  - intensity-profile lines are never exported.
 */
import { saveAs } from 'file-saver';

import { MultiPolygon, Polygon, Rectangle, Region } from './region';
import { bezierCurveFromHandles, resolveHandles } from './bezier';
import { hexToRgb, rgbToHex } from '../contracts/color';

/**
 * Parse a GeoJSON FeatureCollection string (QuPath-compatible) into regions.
 * Throws on invalid JSON, a missing `features` key, or a feature without
 * coordinates.
 */
export function regionsFromGeoJson(geoJsonStr: string): Region[] {
  const regions: Region[] = [];
  let geoJson: any;
  try {
    geoJson = JSON.parse(geoJsonStr);
  } catch (error) {
    throw new Error('Error parsing json string: ' + error);
  }
  if (!geoJson.features) {
    throw new Error("Invalid GeoJson file: must contain the 'features' key.");
  }
  let idx = 0;
  for (const feature of geoJson.features) {
    regions.push(regionFromFeature(feature, idx));
    idx++;
  }
  return regions;
}

/** A feature's `classification`: QuPath's `{name, color}`, or a bare name. */
type Classification = string | { name?: string; color?: number[] };

/** The parts of a GeoJSON feature the reader looks at, JIT's bezier extras
 *  included. Parsed from a file, so nothing here is guaranteed. */
interface GeoJsonFeature {
  geometry: { type?: string; coordinates?: unknown; plane?: { z?: number } };
  properties?: {
    classification?: Classification;
    isBezier?: boolean;
    bezierAnchors?: number[][];
    bezierHandlesIn?: number[][];
    bezierHandlesOut?: number[][];
    holes?: number[][][];
    holeHandlesIn?: number[][][];
    holeHandlesOut?: number[][][];
  };
}

/** One GeoJSON feature as the region `shape<idx>`. */
function regionFromFeature(feature: GeoJsonFeature, idx: number): Region {
  const region = new Region();
  region.name = `shape${idx}`;
  // QuPath stores the image plane INSIDE the geometry (a sibling of
  // type/coordinates), not in properties: `geometry.plane = {c,z,t}`, all
  // zero-based, and the key is omitted for the default plane (z=0,t=0). A
  // missing plane therefore reads back as z=0 (jit-ui#93).
  region.z = feature.geometry?.plane?.z ?? 0;
  readClassification(region, feature.properties?.classification);
  region.bounds = boundsFromFeature(feature);
  return region;
}

/** The region's label (and colour) from a feature's `classification`. */
function readClassification(region: Region, classification: Classification | undefined): void {
  if (!classification) {
    // No classification metadata — use a default label and color.
    region.label = 'Cell';
  } else if (typeof classification === 'string' || !classification.name) {
    // assume classification is a string
    region.label = classification as string;
  } else {
    // if classification is an object with a name / check color as well
    region.label = classification.name;
    if (classification.color) {
      const [r, g, b] = classification.color;
      region.color = rgbToHex([r, g, b]);
    }
  }
}

/** A feature's geometry as region bounds. */
function boundsFromFeature(feature: GeoJsonFeature): Rectangle | Polygon | MultiPolygon {
  // JIT bezier region: the editable anchors + flag travel in properties
  // (the geometry holds the flattened curve for viewers without bezier
  // support). Reconstruct the editable bezier from the anchors.
  if (feature.properties && feature.properties.isBezier && feature.properties.bezierAnchors) {
    return bezierFromProperties(
      feature.properties.bezierAnchors,
      feature.properties,
      feature.geometry?.type !== 'LineString',
    );
  }
  const coordinates = feature.geometry.coordinates;
  if (!coordinates) {
    throw new Error("Invalid GeoJson file: must contain the 'coordinates' key.");
  }
  // Multi-part region: GeoJSON MultiPolygon → one Polygon per part, each
  // with its own holes (jit-ui#85).
  if (feature.geometry.type === 'MultiPolygon') {
    const mp = new MultiPolygon();
    mp.polygons = (coordinates as number[][][][])
      .map((rings) => polygonFromRings(rings))
      .filter((p) => p.xpoints.length >= 3);
    return mp;
  }
  // Open polyline: LineString geometry
  if (feature.geometry.type === 'LineString') return polylineFromLineString(coordinates as number[][]);
  // Polygon: check if it encodes a rectangle (single ring only — a polygon
  // with holes must never be collapsed to a rectangle).
  const rings = coordinates as number[][][];
  if (isRectangleRing(rings)) {
    const rectangle = new Rectangle();
    rectangle.x = rings[0][0][0];
    rectangle.y = rings[0][0][1];
    rectangle.width = rings[0][2][0] - rings[0][0][0];
    rectangle.height = rings[0][2][1] - rings[0][0][1];
    return rectangle;
  }
  return polygonFromPolygonRings(rings);
}

/** The editable bezier region on `anchors`, its handles and holes from `properties`. */
function bezierFromProperties(
  anchors: number[][],
  properties: NonNullable<GeoJsonFeature['properties']>,
  closed: boolean,
): Polygon {
  const polygon = new Polygon();
  polygon.bezier = true;
  polygon.closed = closed;
  polygon.npoints = anchors.length;
  polygon.xpoints = anchors.map((a) => a[0]);
  polygon.ypoints = anchors.map((a) => a[1]);
  polygon.coordinates = anchors.map((a) => [a[0], a[1]]);
  // Restore the edited control handles when present (else they'll fall back
  // to the smooth Catmull-Rom default at render time).
  if (properties.bezierHandlesIn) polygon.handlesIn = properties.bezierHandlesIn;
  if (properties.bezierHandlesOut) polygon.handlesOut = properties.bezierHandlesOut;
  // Restore donut holes + their editable bezier handles (jit-ui#102).
  if (properties.holes) polygon.holes = properties.holes;
  if (properties.holeHandlesIn) polygon.holeHandlesIn = properties.holeHandlesIn;
  if (properties.holeHandlesOut) polygon.holeHandlesOut = properties.holeHandlesOut;
  return polygon;
}

/** An open polyline from a LineString's points. */
function polylineFromLineString(coordinates: number[][]): Polygon {
  const polygon = new Polygon();
  polygon.closed = false;
  polygon.npoints = coordinates.length;
  polygon.xpoints = [];
  polygon.ypoints = [];
  polygon.coordinates = [];
  for (let i = 0; i < coordinates.length; i++) {
    polygon.xpoints.push(coordinates[i][0]);
    polygon.ypoints.push(coordinates[i][1]);
    polygon.coordinates.push([coordinates[i][0], coordinates[i][1]]);
  }
  return polygon;
}

/** Whether Polygon `coordinates` are one closed, axis-aligned four-corner ring. */
function isRectangleRing(coordinates: number[][][]): boolean {
  return (
    coordinates.length === 1 &&
    coordinates[0].length === 5 &&
    JSON.stringify(coordinates[0][0]) === JSON.stringify(coordinates[0][4]) &&
    coordinates[0][0][0] === coordinates[0][3][0] &&
    coordinates[0][0][1] === coordinates[0][1][1] &&
    coordinates[0][1][0] === coordinates[0][2][0] &&
    coordinates[0][2][1] === coordinates[0][3][1]
  );
}

/** A freeform closed polygon from Polygon `coordinates` (the exterior's
 *  closing point dropped; extra rings are holes). */
function polygonFromPolygonRings(coordinates: number[][][]): Polygon {
  const polygon = new Polygon();
  polygon.npoints = coordinates[0].length - 1;
  polygon.xpoints = [];
  polygon.ypoints = [];
  polygon.coordinates = [];
  for (let i = 0; i < coordinates[0].length - 1; i++) {
    polygon.xpoints.push(coordinates[0][i][0]);
    polygon.ypoints.push(coordinates[0][i][1]);
    polygon.coordinates.push([coordinates[0][i][0], coordinates[0][i][1]]);
  }
  // Extra rings are interior holes (GeoJSON Polygon convention) — jit-ui#85.
  const holes = ringsToHoles(coordinates.slice(1));
  if (holes.length) polygon.holes = holes;
  return polygon;
}

/**
 * Serialise regions as a GeoJSON FeatureCollection string (QuPath-compatible),
 * leaving out intensity-profile lines.
 */
export function regionsToGeoJson(rois: readonly Region[]): string {
  const features: object[] = [];
  for (const roi of rois.filter((r) => r.kind !== 'profile')) {
    const feature = featureFromRegion(roi);
    if (feature) features.push(feature);
  }
  const geoJsonData = {
    features: features,
    type: 'FeatureCollection',
  };

  return JSON.stringify(geoJsonData);
}

/** A region as a GeoJSON feature; null for a region without bounds. */
function featureFromRegion(roi: Region): object | null {
  const classification = {
    name: roi.label ? roi.label : roi.name,
    color: hexToRgb(roi?.color) ?? [0, 0, 0],
  };
  // QuPath places the image plane inside the geometry (sibling of
  // type/coordinates), zero-based, and omits it for the default plane
  // (z=0,t=0). Emit `plane: {c,z,t}` only for a non-default slice so a
  // single-plane image round-trips byte-identically to QuPath (jit-ui#93).
  const planeProp = (roi.z ?? 0) !== 0 ? { plane: { c: -1, z: roi.z, t: 0 } } : {};
  if (roi.bounds instanceof Rectangle) {
    const { x, y, width, height } = roi.bounds;
    const ring = [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height],
      [x, y],
    ];
    return {
      type: 'Feature',
      properties: { classification },
      geometry: { type: 'Polygon', coordinates: [ring], ...planeProp },
    };
  }
  if (roi.bounds instanceof Polygon) return polygonFeature(roi.bounds, classification, planeProp);
  if (roi.bounds instanceof MultiPolygon) {
    // Multi-part region → GeoJSON MultiPolygon: one ring-set per part
    // (exterior + holes), each ring closed (jit-ui#85).
    const coordinates = roi.bounds.polygons
      .filter((part) => part.xpoints.length >= 3)
      .map((part) => {
        const ext = part.xpoints.map((x, i) => [x, part.ypoints[i]]);
        const rings: number[][][] = [[...ext, ext[0]]];
        if (part.holes) {
          for (const hole of part.holes) {
            if (hole.length >= 3) rings.push([...hole, hole[0]]);
          }
        }
        return rings;
      });
    return {
      type: 'Feature',
      properties: { classification },
      geometry: { type: 'MultiPolygon', coordinates, ...planeProp },
    };
  }
  return null;
}

/** A closed polygon (with its holes) as a Polygon feature, an open one as a LineString. */
function polygonFeature(polygon: Polygon, classification: object, planeProp: object): object {
  const closed = polygon.closed !== false;
  const isBezier = polygon.bezier === true;
  // For a bezier region the geometry is the flattened smooth curve,
  // so a viewer without bezier support (QuPath) still renders the curve;
  // the editable anchors + flag ride along in properties for JIT.
  const geomCoords = isBezier
    ? flattenBezier(polygon.xpoints, polygon.ypoints, closed, polygon.handlesIn, polygon.handlesOut)
    : polygon.coordinates;
  const properties: Record<string, unknown> = { classification };
  if (isBezier) {
    properties.isBezier = true;
    properties.bezierAnchors = polygon.coordinates;
    // The editable control handles (relative offsets) travel along so JIT
    // round-trips a hand-edited curve, not just the smooth default.
    if (polygon.handlesIn) properties.bezierHandlesIn = polygon.handlesIn;
    if (polygon.handlesOut) properties.bezierHandlesOut = polygon.handlesOut;
    // Donut bezier: the hole anchors + their editable handles round-trip too (jit-ui#102).
    if (polygon.holes) properties.holes = polygon.holes;
    if (polygon.holeHandlesIn) properties.holeHandlesIn = polygon.holeHandlesIn;
    if (polygon.holeHandlesOut) properties.holeHandlesOut = polygon.holeHandlesOut;
  }
  if (!closed) {
    return {
      type: 'Feature',
      properties,
      geometry: { type: 'LineString', coordinates: geomCoords, ...planeProp },
    };
  }
  // Close the ring. The flattened bezier curve already returns to its
  // start, so only the straight-polygon path needs the first point
  // repeated.
  const ring = isBezier ? geomCoords : [...geomCoords, geomCoords[0]];
  // Interior rings (holes) follow the exterior as extra GeoJSON rings —
  // standard Polygon-with-holes, which QuPath round-trips (jit-ui#85). For a bezier donut,
  // the hole geometry is the flattened smooth curve too (jit-ui#102).
  const rings: number[][][] = [ring];
  if (polygon.holes) {
    polygon.holes.forEach((hole, hi) => {
      if (hole.length < 3) return;
      if (isBezier) {
        const hxs = hole.map((p) => p[0]);
        const hys = hole.map((p) => p[1]);
        rings.push(flattenBezier(hxs, hys, true, polygon.holeHandlesIn?.[hi], polygon.holeHandlesOut?.[hi]));
      } else {
        rings.push([...hole, hole[0]]);
      }
    });
  }
  return { type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: rings, ...planeProp } };
}

/** The flattened bezier curve through anchors `xs`/`ys` with the given handle offsets, as points. */
function flattenBezier(
  xs: number[],
  ys: number[],
  closed: boolean,
  handlesIn?: number[][],
  handlesOut?: number[][],
): number[][] {
  const c = bezierCurveFromHandles(xs, ys, resolveHandles(xs, ys, closed, handlesIn, handlesOut), closed);
  return c.xs.map((x, i) => [x, c.ys[i]]);
}

/**
 * Build a closed {@link Polygon} from a GeoJSON ring set: `rings[0]` is the
 * exterior (closing point dropped), `rings[1..]` are interior holes. jit-ui#85.
 */
function polygonFromRings(rings: number[][][]): Polygon {
  const poly = new Polygon();
  const ext = rings?.[0] ?? [];
  const last = ext.length - 1;
  const closed = ext.length > 1 && ext[0][0] === ext[last][0] && ext[0][1] === ext[last][1];
  const n = closed ? last : ext.length;
  poly.xpoints = [];
  poly.ypoints = [];
  poly.coordinates = [];
  for (let i = 0; i < n; i++) {
    poly.xpoints.push(ext[i][0]);
    poly.ypoints.push(ext[i][1]);
    poly.coordinates.push([ext[i][0], ext[i][1]]);
  }
  poly.npoints = poly.xpoints.length;
  poly.closed = true;
  const holes = ringsToHoles(rings.slice(1));
  if (holes.length) poly.holes = holes;
  return poly;
}

/**
 * Convert GeoJSON interior rings into the neutral hole representation
 * (`number[][]` per ring, no repeated closing point). Degenerate rings (< 3
 * distinct points) are dropped. jit-ui#85.
 */
function ringsToHoles(rings: number[][][]): number[][][] {
  const holes: number[][][] = [];
  for (const ringIn of rings || []) {
    if (!ringIn || ringIn.length < 3) continue;
    const last = ringIn.length - 1;
    const closed = ringIn[0][0] === ringIn[last][0] && ringIn[0][1] === ringIn[last][1];
    const n = closed ? last : ringIn.length;
    const ring: number[][] = [];
    for (let i = 0; i < n; i++) ring.push([ringIn[i][0], ringIn[i][1]]);
    if (ring.length >= 3) holes.push(ring);
  }
  return holes;
}

/**
 * Download a GeoJSON string as `<baseName without extension>.geojson`
 * (`rois.geojson` without a base name).
 */
export function downloadGeoJson(jsonString: string, baseName?: string): void {
  const blob = new Blob([jsonString], { type: 'application/json' });
  const stem = (baseName ?? '').replace(/\.[^/.]+$/, '').trim() || 'rois';
  saveAs(blob, `${stem}.geojson`);
}
