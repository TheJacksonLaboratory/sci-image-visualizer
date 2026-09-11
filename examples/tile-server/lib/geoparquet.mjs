// Read a SpatialData `shapes.parquet` — GeoParquet with WKB geometry — into the
// flat ring layout the spatial wire format uses, plus per-shape centroids and
// areas.
//
// Needed because a SEGMENTATION-based store (Visium HD cell/nucleus
// segmentations, Xenium) keeps its geometry only here: its AnnData `obsm` is
// empty, so there is no centroid array to read from Zarr. Circle-based stores
// (plain Visium) put spot centres in `obsm/spatial` and never need this.
//
// hyparquet does the Parquet decoding (pure JS, no native deps); WKB is parsed
// here because it is a dozen lines and pulling in a geometry stack for it would
// be disproportionate.

import { open } from 'node:fs/promises';
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';

/** WKB geometry type codes, for the raw-bytes fallback. */
const WKB_POLYGON = 3;
const WKB_MULTIPOLYGON = 6;

/**
 * Exterior rings of one shape.
 *
 * hyparquet decodes Parquet's GEOMETRY logical type straight to GeoJSON, which
 * is the path this store takes. The raw-WKB branch is kept for a file (or a
 * hyparquet version) that hands back bytes instead.
 *
 * Only EXTERIOR rings are kept: the viewer draws cell outlines, and a
 * segmentation's interior rings — rare, usually artefacts — would cost a second
 * offsets array to represent for no visual gain.
 */
function ringsOf(value) {
  if (value && typeof value === 'object' && Array.isArray(value.coordinates)) {
    const polygons = value.type === 'MultiPolygon' ? value.coordinates : [value.coordinates];
    const rings = [];
    for (const polygon of polygons) {
      const exterior = polygon?.[0];
      if (!exterior || exterior.length < 3) continue;
      const n = exterior.length;
      const xs = new Float64Array(n);
      const ys = new Float64Array(n);
      for (let i = 0; i < n; i++) { xs[i] = exterior[i][0]; ys[i] = exterior[i][1]; }
      rings.push({ xs, ys });
    }
    return rings;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return parseWkbRings(value instanceof Uint8Array ? value : new Uint8Array(value));
  }
  throw new Error(
    `[geoparquet] unrecognised geometry value (${value?.type ?? typeof value}) — `
    + 'expected GeoJSON or WKB bytes',
  );
}

/** Parse WKB Polygon / MultiPolygon bytes into exterior rings. */
function parseWkbRings(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const little = dv.getUint8(o) === 1;
  o += 1;
  const u32 = () => { const v = dv.getUint32(o, little); o += 4; return v; };
  const f64 = () => { const v = dv.getFloat64(o, little); o += 8; return v; };
  const type = u32() & 0xff;
  const rings = [];
  const readPolygon = () => {
    const ringCount = u32();
    for (let r = 0; r < ringCount; r++) {
      const n = u32();
      if (r === 0) {
        const xs = new Float64Array(n);
        const ys = new Float64Array(n);
        for (let i = 0; i < n; i++) { xs[i] = f64(); ys[i] = f64(); }
        rings.push({ xs, ys });
      } else {
        o += n * 16;
      }
    }
  };
  if (type === WKB_POLYGON) readPolygon();
  else if (type === WKB_MULTIPOLYGON) {
    const parts = u32();
    for (let p = 0; p < parts; p++) { o += 1; u32(); readPolygon(); }
  } else throw new Error(`[geoparquet] unsupported WKB geometry type ${type}`);
  return rings;
}

/** Signed area (shoelace) and the area-weighted centroid of one ring. */
function ringStats(xs, ys) {
  const n = xs.length;
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const cross = xs[j] * ys[i] - xs[i] * ys[j];
    a2 += cross;
    cx += (xs[j] + xs[i]) * cross;
    cy += (ys[j] + ys[i]) * cross;
  }
  if (a2 === 0) {
    // Degenerate ring: fall back to the vertex mean so it still gets a position.
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    return { area: 0, cx: mx / n, cy: my / n };
  }
  return { area: Math.abs(a2) / 2, cx: cx / (3 * a2), cy: cy / (3 * a2) };
}

/** hyparquet needs a random-access byte source; wrap a file handle as one. */
async function asyncBufferFor(filePath) {
  const fh = await open(filePath);
  const { size } = await fh.stat();
  return {
    byteLength: size,
    async slice(start, end) {
      const len = (end ?? size) - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + len);
    },
    close: () => fh.close(),
  };
}

/**
 * Read every shape.
 *
 * Returns flat `coords`/`offsets` in the wire layout, plus per-shape centroids,
 * equivalent-circle radii (`sqrt(area / π)` — a meaningful size for an irregular
 * cell, unlike a fixed spot radius) and ids for joining to the table.
 */
export async function readShapes(filePath, { idColumn = 'cell_id' } = {}) {
  const src = await asyncBufferFor(filePath);
  try {
    const metadata = await parquetMetadataAsync(src);
    const names = metadata.schema.map((s) => s.name);
    const columns = ['geometry', ...(names.includes(idColumn) ? [idColumn] : [])];
    const rows = await parquetReadObjects({ file: src, metadata, columns });

    const count = rows.length;
    const offsets = new Uint32Array(count + 1);
    const cx = new Float32Array(count);
    const cy = new Float32Array(count);
    const radius = new Float32Array(count);
    const ids = new Array(count);
    const parts = new Array(count);

    let vertices = 0;
    for (let i = 0; i < count; i++) {
      const rings = ringsOf(rows[i].geometry);
      // One outline per shape: the largest part, so a stray speck in a
      // MultiPolygon does not become the cell's outline.
      let best = rings[0];
      let bestArea = -1;
      let area = 0;
      let wx = 0;
      let wy = 0;
      for (const ring of rings) {
        const st = ringStats(ring.xs, ring.ys);
        area += st.area;
        wx += st.cx * (st.area || 1);
        wy += st.cy * (st.area || 1);
        if (st.area > bestArea) { bestArea = st.area; best = ring; }
      }
      const norm = area || rings.length;
      cx[i] = wx / norm;
      cy[i] = wy / norm;
      radius[i] = Math.sqrt(Math.max(area, 0) / Math.PI);
      ids[i] = rows[i][idColumn] != null ? String(rows[i][idColumn]) : String(i);
      parts[i] = best;
      offsets[i] = vertices;
      vertices += best.xs.length;
    }
    offsets[count] = vertices;

    const coords = new Float32Array(vertices * 2);
    let at = 0;
    for (let i = 0; i < count; i++) {
      const { xs, ys } = parts[i];
      for (let v = 0; v < xs.length; v++) {
        coords[at++] = xs[v];
        coords[at++] = ys[v];
      }
    }

    return { count, coords, offsets, cx, cy, radius, ids };
  } finally {
    await src.close();
  }
}
