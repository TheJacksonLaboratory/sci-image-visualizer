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

/** One tileSize×tileSize (or smaller, at the right/bottom edge) PNG tile at
 *  pyramid level `res`, tile grid cell (col,row). Mirrors the library's
 *  `ceil(levelW/tileSize) × ceil(levelH/tileSize)` grid exactly.
 *
 *  `channel` selects one band of a multichannel pyramid, returning that band as
 *  a single-band grayscale PNG — the library tints/windows it client-side per
 *  the Channels pane. Omit it for the flat composite. */
export async function readTile(cogDir, imageId, res, col, row, tileSize, channel, z) {
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
  const perChannel = channelOf(desc, channel);
  const img = sharp(levelFile(cogDir, imageId, res, perChannel, sliceOf(desc, z)), { limitInputPixels: false })
    .extract({ left, top, width, height });
  // Fluorescence bands must NOT be flattened onto white — that would invert the
  // meaning of a mostly-black channel. Only the brightfield composite gets it.
  return (perChannel === null ? img.flatten({ background: '#ffffff' }) : img)
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/** Re-render an arbitrary region (full-res pixel coords) at ~screen resolution —
 *  backs the Plotly heatmap box-zoom (TileAccessPort.zoomOnRegion → POST
 *  /zoom/region). Picks the coarsest pyramid level that still has enough detail
 *  for the requested output size, so a box-zoom never reads full res needlessly. */
export async function readRegion(cogDir, imageId, roi, screen, z) {
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

  return sharp(levelFile(cogDir, imageId, chosen.res, channelOf(desc), sliceOf(desc, z)), { limitInputPixels: false })
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
export async function readPreview(cogDir, imageId, tier, z) {
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
  // The host asks for a specific slice (one preview URL per z, which is also how
  // the component learns the stack depth). Without `z` — a thumbnail, or a
  // single-slice image — fall back to the MIDDLE slice, the usual most-in-focus
  // plane, so a stack's thumbnail isn't a blurry end of the stack.
  const which = Number.isInteger(Number(z)) ? z : desc.z > 1 ? Math.floor(desc.z / 2) : undefined;
  return sharp(levelFile(cogDir, imageId, chosen.res, channelOf(desc), sliceOf(desc, which)), { limitInputPixels: false })
    .resize(outW, outH, { fit: 'inside' })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
}

/** Which per-channel pyramid a request maps to, or null for the flat file.
 *
 *  A multichannel COG has no flat `L{res}.tif` — only `L{res}_c{c}.tif`. So when
 *  no channel is requested (the preview, a box-zoom region, or a descriptor that
 *  advertises `multichannel: false`), fall back to channel 0. That is what the
 *  viewer then shows for the whole image: exactly the "only the first channel
 *  renders" behaviour a server produces when it won't flag the stack as
 *  multichannel. */
function channelOf(desc, channel) {
  const n = Number(desc?.channelInfo?.length ?? 0);
  if (n < 2) return null; // single-band or brightfield: flat file
  const c = Number(channel);
  if (!Number.isInteger(c) || c < 0 || c >= n) return 0;
  return c;
}

/** Slice index for a request, clamped into the stack. `null` for a single-slice
 *  image, whose level files carry no `_z` key. */
function sliceOf(desc, z) {
  const n = Number(desc?.z ?? 1);
  if (!Number.isFinite(n) || n < 2) return null;
  const v = Number(z);
  if (!Number.isInteger(v) || v < 0 || v >= n) return 0;
  return v;
}

function levelFile(cogDir, imageId, res, channel, z) {
  const zKey = z === null || z === undefined ? '' : `_z${z}`;
  const cKey = channel === null || channel === undefined ? '' : `_c${channel}`;
  // A flat brightfield COG is plain `L{res}.tif`; per-channel adds `_c`, a stack
  // adds `_z` — matching make-cog's naming.
  return path.join(cogDir, safeId(imageId), `L${res}${zKey}${cKey}.tif`);
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
