// Turn any image sharp can open (PNG, JPEG, TIFF, WebP) into the tiled pyramid
// the tile server serves — the no-vips counterpart to make-cog.mjs, for images
// that are already plain rasters rather than whole-slide formats.
//
//   node scripts/make-pyramid.mjs <input> <imageId> [--out cogs] [--tile 512]
//                                 [--q 85] [--mpp <µm-per-pixel>]
//
// Produces <out>/<imageId>/{L0.tif … Ln.tif, descriptor.json}.

import path from 'node:path';
import sharp from 'sharp';

import { writePyramid, DEFAULT_TILE_SIZE } from '../lib/pyramid.mjs';

const args = process.argv.slice(2);
const [input, imageId] = args.filter((a) => !a.startsWith('--'));
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

if (!input || !imageId) {
  console.error('usage: node scripts/make-pyramid.mjs <input> <imageId> [--out cogs] [--tile 512] [--q 85] [--mpp N]');
  process.exit(2);
}

const outRoot = argOf('--out', new URL('../cogs', import.meta.url).pathname);
const tileSize = Number(argOf('--tile', DEFAULT_TILE_SIZE));
const quality = Number(argOf('--q', 85));
const mpp = argOf('--mpp', null);

// limitInputPixels: a whole-slide-derived PNG can exceed sharp's default guard.
const source = sharp(input, { limitInputPixels: false });
const meta = await source.metadata();
const outDir = path.join(outRoot, imageId);

console.log(`[make-pyramid] ${input} -> ${outDir}  (${meta.width}x${meta.height})`);
const descriptor = await writePyramid(outDir, source, {
  width: meta.width,
  height: meta.height,
  tileSize,
  quality,
  mppX: mpp ? Number(mpp) : null,
  mppY: mpp ? Number(mpp) : null,
  onLevel: (res, w, h) => console.log(`  L${res}  ${w}x${h}`),
});
console.log(`[make-pyramid] ${descriptor.realLevels} levels, tileSize ${descriptor.tileSize}`);
