// Core tile reader for the example tile server.
//
// Each gigapixel image is stored as a small pyramid of TILED TIFFs on disk
// (one file per resolution level), produced offline by scripts/make-cog.mjs:
//
//   cogs/<imageId>/descriptor.json   the TileDescriptor the library polls for
//   cogs/<imageId>/L0.tif            full resolution, JPEG-tiled (res 0 = finest)
//   cogs/<imageId>/L1.tif            half resolution
//   ...                              down to a level that fits in ~1 tile
//
// Because every level is itself a *tiled* TIFF, sharp/libvips reads only the
// tiles overlapping the requested region — so serving one 512px tile touches a
// few KB of a multi-GB level, which is the whole point of the pyramid.

import sharp from 'sharp';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// Decode failures are cheap; descriptors are tiny and immutable per build, so
// cache them in memory to avoid a JSON read on every tile request.
const descCache = new Map();

export async function loadDescriptor(cogDir, imageId) {
  const key = `${cogDir}::${imageId}`;
  const hit = descCache.get(key);
  if (hit) return hit;
  const p = path.join(cogDir, safeId(imageId), 'descriptor.json');
  const desc = JSON.parse(await readFile(p, 'utf8'));
  descCache.set(key, desc);
  return desc;
}

export async function listImages(cogDir) {
  try {
    const entries = await readdir(cogDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** One tileSize×tileSize (or smaller, at the right/bottom edge) RGB PNG tile at
 *  pyramid level `res`, tile grid cell (col,row). Mirrors the library's
 *  `ceil(levelW/tileSize) × ceil(levelH/tileSize)` grid exactly. */
export async function readTile(cogDir, imageId, res, col, row, tileSize) {
  const desc = await loadDescriptor(cogDir, imageId);
  const level = desc.levels.find((l) => l.res === res);
  if (!level) throw new RangeError(`no pyramid level res=${res}`);
  const left = col * tileSize;
  const top = row * tileSize;
  if (left < 0 || top < 0 || left >= level.width || top >= level.height) {
    throw new RangeError(`tile ${res}/${col}/${row} out of range`);
  }
  const width = Math.min(tileSize, level.width - left);
  const height = Math.min(tileSize, level.height - top);
  return sharp(levelFile(cogDir, imageId, res), { limitInputPixels: false })
    .extract({ left, top, width, height })
    .flatten({ background: '#ffffff' }) // brightfield: composite over white, drop alpha
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/** Re-render an arbitrary region (full-res pixel coords) at ~screen resolution —
 *  backs the Plotly heatmap box-zoom (TileAccessPort.zoomOnRegion → POST
 *  /zoom/region). Picks the coarsest pyramid level that still has enough detail
 *  for the requested output size, so a box-zoom never reads full res needlessly. */
export async function readRegion(cogDir, imageId, roi, screen) {
  const desc = await loadDescriptor(cogDir, imageId);
  const full = desc.levels.find((l) => l.res === 0) ?? desc.levels[0];
  const outW = clampInt(Math.min(screen?.width || roi.width, roi.width), 1, 4096);
  const outH = clampInt(Math.min(screen?.height || roi.height, roi.height), 1, 4096);

  // levels are ordered finest→coarsest; keep the coarsest whose ROI still spans
  // at least the output width (i.e. no upscaling of missing detail).
  let chosen = full;
  for (const l of desc.levels) {
    const scale = l.width / full.width;
    if (roi.width * scale >= outW) chosen = l;
    else break;
  }
  const scale = chosen.width / full.width;
  const left = clampInt(roi.x * scale, 0, chosen.width - 1);
  const top = clampInt(roi.y * scale, 0, chosen.height - 1);
  const width = clampInt(roi.width * scale, 1, chosen.width - left);
  const height = clampInt(roi.height * scale, 1, chosen.height - top);

  return sharp(levelFile(cogDir, imageId, chosen.res), { limitInputPixels: false })
    .extract({ left, top, width, height })
    .resize(outW, outH, { fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
}

/** A flat, downsampled whole-plane PNG — the Plotly heatmap's source (the host
 *  puts this URL in IImageInfo.urls[0]; OSD ignores urls and uses the tile grid).
 *  Rendered from the coarsest pyramid level whose longest side still covers the
 *  target size, so it never reads full resolution. tier=small -> a ~128px thumb. */
export async function readPreview(cogDir, imageId, tier) {
  const desc = await loadDescriptor(cogDir, imageId);
  const target = tier === 'small' ? 128 : 1600;
  let chosen = desc.levels[0];
  for (const l of desc.levels) {
    if (Math.max(l.width, l.height) >= target) chosen = l;
    else break;
  }
  const scale = Math.min(1, target / Math.max(chosen.width, chosen.height));
  const outW = Math.max(1, Math.round(chosen.width * scale));
  const outH = Math.max(1, Math.round(chosen.height * scale));
  return sharp(levelFile(cogDir, imageId, chosen.res), { limitInputPixels: false })
    .resize(outW, outH, { fit: 'inside' })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
}

function levelFile(cogDir, imageId, res) {
  return path.join(cogDir, safeId(imageId), `L${res}.tif`);
}

// The imageId comes from the client's opaque info token; never let it escape the
// COG dir.
function safeId(imageId) {
  const id = String(imageId || '');
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`bad image id: ${id}`);
  return id;
}

function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
