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
    const region = new Region();
    region.name = `shape${idx}`;
    idx++;
    // QuPath stores the image plane INSIDE the geometry (a sibling of
    // type/coordinates), not in properties: `geometry.plane = {c,z,t}`, all
    // zero-based, and the key is omitted for the default plane (z=0,t=0). A
    // missing plane therefore reads back as z=0 (jit-ui#93).
    region.z = feature.geometry?.plane?.z ?? 0;
    if (!feature.properties || !feature.properties.classification) {
      // No classification metadata — use a default label and color.
      region.label = 'Cell';
    } else if (!feature.properties.classification.name) {
      // assume classification is a string
      region.label = feature.properties.classification;
    } else {
      // if classification is an object with a name / check color as well
      region.label = feature.properties.classification.name;
      if (feature.properties.classification.color) {
        const [r, g, b] = feature.properties.classification.color;
        region.color = rgbToHex([r, g, b]);
      }
    }

    // JIT bezier region: the editable anchors + flag travel in properties
    // (the geometry holds the flattened curve for viewers without bezier
    // support). Reconstruct the editable bezier from the anchors.
    if (feature.properties && feature.properties.isBezier && feature.properties.bezierAnchors) {
      const anchors: number[][] = feature.properties.bezierAnchors;
      const polygon = new Polygon();
      polygon.bezier = true;
      polygon.closed = feature.geometry?.type !== 'LineString';
      polygon.npoints = anchors.length;
      polygon.xpoints = anchors.map((a) => a[0]);
      polygon.ypoints = anchors.map((a) => a[1]);
      polygon.coordinates = anchors.map((a) => [a[0], a[1]]);
      // Restore the edited control handles when present (else they'll fall back
      // to the smooth Catmull-Rom default at render time).
      if (feature.properties.bezierHandlesIn) polygon.handlesIn = feature.properties.bezierHandlesIn;
      if (feature.properties.bezierHandlesOut) polygon.handlesOut = feature.properties.bezierHandlesOut;
      // Restore donut holes + their editable bezier handles (jit-ui#102).
      if (feature.properties.holes) polygon.holes = feature.properties.holes;
      if (feature.properties.holeHandlesIn) polygon.holeHandlesIn = feature.properties.holeHandlesIn;
      if (feature.properties.holeHandlesOut) polygon.holeHandlesOut = feature.properties.holeHandlesOut;
      region.bounds = polygon;
      regions.push(region);
      continue;
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
      region.bounds = mp;
      regions.push(region);
      continue;
    }
    // Open polyline: LineString geometry
    if (feature.geometry.type === 'LineString') {
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
      region.bounds = polygon;
      // Polygon: check if it encodes a rectangle (single ring only — a polygon
      // with holes must never be collapsed to a rectangle).
    } else if (
      coordinates.length === 1 &&
      coordinates[0].length === 5 &&
      JSON.stringify(coordinates[0][0]) === JSON.stringify(coordinates[0][4]) &&
      coordinates[0][0][0] === coordinates[0][3][0] &&
      coordinates[0][0][1] === coordinates[0][1][1] &&
      coordinates[0][1][0] === coordinates[0][2][0] &&
      coordinates[0][2][1] === coordinates[0][3][1]
    ) {
      const rectangle = new Rectangle();
      rectangle.x = coordinates[0][0][0];
      rectangle.y = coordinates[0][0][1];
      rectangle.width = coordinates[0][2][0] - coordinates[0][0][0];
      rectangle.height = coordinates[0][2][1] - coordinates[0][0][1];
      region.bounds = rectangle;
    } else {
      // polygon is a freeform closed polygon
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
      region.bounds = polygon;
    }
    regions.push(region);
  }
  return regions;
}

/**
 * Serialise regions as a GeoJSON FeatureCollection string (QuPath-compatible),
 * leaving out intensity-profile lines.
 */
export function regionsToGeoJson(rois: readonly Region[]): string {
  const features: object[] = [];
  for (const roi of rois.filter((r) => r.kind !== 'profile')) {
    const colorRgb = hexToRgb(roi?.color) ?? [0, 0, 0];
    // QuPath places the image plane inside the geometry (sibling of
    // type/coordinates), zero-based, and omits it for the default plane
    // (z=0,t=0). Emit `plane: {c,z,t}` only for a non-default slice so a
    // single-plane image round-trips byte-identically to QuPath (jit-ui#93).
    const planeProp = (roi.z ?? 0) !== 0 ? { plane: { c: -1, z: roi.z, t: 0 } } : {};
    if (roi.bounds instanceof Rectangle) {
      const rectangle = {
        type: 'Feature',
        properties: {
          classification: {
            name: roi.label ? roi.label : roi.name,
            color: colorRgb,
          },
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [roi.bounds.x, roi.bounds.y],
              [roi.bounds.x + roi.bounds.width, roi.bounds.y],
              [roi.bounds.x + roi.bounds.width, roi.bounds.y + roi.bounds.height],
              [roi.bounds.x, roi.bounds.y + roi.bounds.height],
              [roi.bounds.x, roi.bounds.y],
            ],
          ],
          ...planeProp,
        },
      };
      features.push(rectangle);
    } else if (roi.bounds instanceof Polygon) {
      const closed = roi.bounds.closed !== false;
      const isBezier = roi.bounds.bezier === true;
      // For a bezier region the geometry is the flattened smooth curve,
      // so a viewer without bezier support (QuPath) still renders the curve;
      // the editable anchors + flag ride along in properties for JIT.
      const geomCoords = isBezier
        ? (() => {
            const handles = resolveHandles(
              roi.bounds.xpoints,
              roi.bounds.ypoints,
              closed,
              roi.bounds.handlesIn,
              roi.bounds.handlesOut,
            );
            const c = bezierCurveFromHandles(roi.bounds.xpoints, roi.bounds.ypoints, handles, closed);
            return c.xs.map((x, i) => [x, c.ys[i]]);
          })()
        : roi.bounds.coordinates;
      const properties: Record<string, unknown> = {
        classification: {
          name: roi.label ? roi.label : roi.name,
          color: colorRgb,
        },
      };
      if (isBezier) {
        properties.isBezier = true;
        properties.bezierAnchors = roi.bounds.coordinates;
        // The editable control handles (relative offsets) travel along so JIT
        // round-trips a hand-edited curve, not just the smooth default.
        if (roi.bounds.handlesIn) properties.bezierHandlesIn = roi.bounds.handlesIn;
        if (roi.bounds.handlesOut) properties.bezierHandlesOut = roi.bounds.handlesOut;
        // Donut bezier: the hole anchors + their editable handles round-trip too (jit-ui#102).
        if (roi.bounds.holes) properties.holes = roi.bounds.holes;
        if (roi.bounds.holeHandlesIn) properties.holeHandlesIn = roi.bounds.holeHandlesIn;
        if (roi.bounds.holeHandlesOut) properties.holeHandlesOut = roi.bounds.holeHandlesOut;
      }
      if (closed) {
        // Close the ring. The flattened bezier curve already returns to its
        // start, so only the straight-polygon path needs the first point
        // repeated.
        const ring = isBezier ? geomCoords : [...geomCoords, geomCoords[0]];
        // Interior rings (holes) follow the exterior as extra GeoJSON rings —
        // standard Polygon-with-holes, which QuPath round-trips (jit-ui#85). For a bezier donut,
        // the hole geometry is the flattened smooth curve too (jit-ui#102).
        const rings: number[][][] = [ring];
        if (roi.bounds.holes) {
          roi.bounds.holes.forEach((hole, hi) => {
            if (hole.length < 3) return;
            if (isBezier) {
              const hxs = hole.map((p) => p[0]);
              const hys = hole.map((p) => p[1]);
              const hh = resolveHandles(
                hxs,
                hys,
                true,
                (roi.bounds as Polygon).holeHandlesIn?.[hi],
                (roi.bounds as Polygon).holeHandlesOut?.[hi],
              );
              const c = bezierCurveFromHandles(hxs, hys, hh, true);
              rings.push(c.xs.map((x, i) => [x, c.ys[i]]));
            } else {
              rings.push([...hole, hole[0]]);
            }
          });
        }
        features.push({
          type: 'Feature',
          properties,
          geometry: { type: 'Polygon', coordinates: rings, ...planeProp },
        });
      } else {
        features.push({
          type: 'Feature',
          properties,
          geometry: { type: 'LineString', coordinates: geomCoords, ...planeProp },
        });
      }
    } else if (roi.bounds instanceof MultiPolygon) {
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
      features.push({
        type: 'Feature',
        properties: { classification: { name: roi.label ? roi.label : roi.name, color: colorRgb } },
        geometry: { type: 'MultiPolygon', coordinates, ...planeProp },
      });
    }
  }
  const geoJsonData = {
    features: features,
    type: 'FeatureCollection',
  };

  return JSON.stringify(geoJsonData);
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
