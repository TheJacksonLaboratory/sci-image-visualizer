// Write a tiled-TIFF pyramid + descriptor in the format lib/cog.mjs serves —
// the same layout scripts/make-cog.mjs produces from a whole-slide image, but
// from any image sharp can open and with no `vips` dependency.
//
// Used by scripts/make-pyramid.mjs (a PNG/TIFF on disk) and by
// scripts/make-spatial-demo.mjs (a synthetic raw buffer).

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export const DEFAULT_TILE_SIZE = 512;

/**
 * Write `L{res}.tif` for each pyramid level plus `descriptor.json`.
 *
 * `source` is a sharp instance; it is cloned per level, so the caller keeps
 * ownership. Levels halve until one fits in a single tile — the library has no
 * use for anything coarser.
 *
 * Returns the descriptor that was written.
 */
export async function writePyramid(outDir, source, opts) {
  const {
    width, height,
    tileSize = DEFAULT_TILE_SIZE,
    quality = 85,
    mppX = null,
    mppY = null,
    onLevel,
  } = opts;

  await mkdir(outDir, { recursive: true });

  const levels = [];
  for (let res = 0; res <= 20; res++) {
    const f = 2 ** res;
    const w = Math.round(width / f);
    const h = Math.round(height / f);
    if (w < 1 || h < 1) break;
    await source
      .clone()
      .resize(w, h, { fit: 'fill' })
      // JPEG-in-TIFF matches make-cog's brightfield output: these are 8-bit RGB
      // and the client never reads raw values back from them.
      .tiff({ tile: true, tileWidth: tileSize, tileHeight: tileSize, compression: 'jpeg', quality })
      .toFile(path.join(outDir, `L${res}.tif`));
    levels.push({ res, width: w, height: h });
    onLevel?.(res, w, h);
    if (w <= tileSize && h <= tileSize) break;
  }

  const descriptor = {
    width, height, tileSize,
    z: 1,
    channels: 3,
    multichannel: false,
    realLevels: levels.length,
    channelInfo: null,
    levels,
    ...(mppX ? { mppX } : {}),
    ...(mppY ? { mppY } : {}),
  };
  await writeFile(path.join(outDir, 'descriptor.json'), JSON.stringify(descriptor, null, 2));
  return descriptor;
}
