// Offline converter: a whole-slide image (SVS / NDPI / OME-TIFF / …) -> a small
// pyramid of TILED TIFFs the tile server serves. Uses `vips`/`vipsthumbnail`
// (with OpenSlide) to read the proprietary WSI formats; the output is plain
// JPEG-tiled TIFF that sharp (no OpenSlide) can serve.
//
//   node scripts/make-cog.mjs <input> <imageId> [--out cogs] [--tile 512] [--q 85]
//   npm run make-cog -- .cache/CMU-1.svs cmu-1
//
// Produces cogs/<imageId>/L{0..N}.tif (res 0 = full res, each level halves) and
// cogs/<imageId>/descriptor.json (the TileDescriptor the library polls for).

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

// IMPORTANT: do NOT spread process.env. This script imports `sharp`, which sets
// VIPSHOME to its OWN bundled libvips; leaking that to the spawned homebrew vips
// makes it load sharp's libvips (no NDPI support, drops the openslide.* metadata)
// instead of the OpenSlide-enabled homebrew build. Pass a clean, minimal env so
// `vips`/`vipsthumbnail` resolve to homebrew's OpenSlide-enabled libvips.
const VIPS_ENV = {
  PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR || '/tmp',
  LANG: process.env.LANG || 'en_US.UTF-8',
};

function vips(bin, args) {
  return execFileSync(bin, args, { env: VIPS_ENV, maxBuffer: 64 * 1024 * 1024 }).toString();
}
function vipsRun(bin, args) {
  execFileSync(bin, args, { env: VIPS_ENV, stdio: 'inherit' });
}

/** Parse `vipsheader -a` once into a { field: value } map — robust across the
 *  per-format metadata fields (openslide.*, aperio.*, tiff.*). */
function readHeaders(input) {
  const map = {};
  for (const line of vips('vipsheader', ['-a', input]).split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return map;
}

/** µm/pixel from whatever field the format exposes. */
function mppFrom(h, axis /* 'x' | 'y' */) {
  const cands = [
    h[`openslide.mpp-${axis}`],
    h['aperio.MPP'],
    (() => {
      const r = Number(h[axis === 'x' ? 'xres' : 'yres']);
      const unit = (h['resolution-unit'] || h['tiff.ResolutionUnit'] || '').toLowerCase();
      if (!Number.isFinite(r) || r <= 0) return null;
      if (unit.includes('cm')) return 10000 / r; // px/cm -> µm/px
      if (unit.includes('inch')) return 25400 / r; // px/inch -> µm/px
      return null;
    })(),
  ];
  for (const c of cands) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

async function main() {
  const [input, imageId, ...rest] = process.argv.slice(2);
  if (!input || !imageId) {
    console.error('usage: make-cog.mjs <input> <imageId> [--out cogs] [--tile 512] [--q 85]');
    process.exit(1);
  }
  const opt = parseOpts(rest);
  const tile = opt.tile ?? 512;
  const q = opt.q ?? 85;
  const outDir = path.resolve(opt.out ?? 'cogs', imageId);
  await mkdir(outDir, { recursive: true });

  const h = readHeaders(input);
  const fullW = Number(h.width);
  const fullH = Number(h.height);
  if (!fullW || !fullH) throw new Error(`could not read dimensions of ${input}`);
  const mppX = mppFrom(h, 'x');
  const mppY = mppFrom(h, 'y');
  console.log(`[make-cog] ${input}  ${fullW}x${fullH}px  mpp=${mppX || 'n/a'}  -> ${outDir}`);

  // Plan pyramid levels: res 0 = full, halve until the coarsest fits in ~1 tile.
  const plan = [];
  for (let res = 0; res <= 20; res++) {
    const f = 2 ** res;
    const w = Math.round(fullW / f);
    const hh = Math.round(fullH / f);
    plan.push({ res, targetW: w });
    if (Math.max(w, hh) <= tile) break;
  }

  // Generate coarsest -> finest so cheap levels land first (full-res L0 last).
  const t0 = Date.now();
  for (const { res, targetW } of [...plan].reverse()) {
    const outFile = path.join(outDir, `L${res}.tif`);
    const save = `${outFile}[compression=jpeg,Q=${q},tile,tile-width=${tile},tile-height=${tile},bigtiff]`;
    console.log(`[make-cog]  L${res}: target width ${targetW} ...`);
    vipsRun('vipsthumbnail', [input, '--size', `${targetW}x100000000`, '-o', save]);
  }

  // Read back ACTUAL level dims so the descriptor's tile grid matches byte-for-byte.
  const levels = [];
  for (const { res } of plan) {
    const meta = await sharp(path.join(outDir, `L${res}.tif`), { limitInputPixels: false }).metadata();
    levels.push({ res, width: meta.width, height: meta.height });
  }
  levels.sort((a, b) => a.res - b.res);

  const descriptor = {
    width: levels[0].width,
    height: levels[0].height,
    tileSize: tile,
    z: 1,
    channels: 3,
    multichannel: false,
    realLevels: levels.length,
    channelInfo: null,
    levels,
    mppX,
    mppY,
  };
  await writeFile(path.join(outDir, 'descriptor.json'), JSON.stringify(descriptor, null, 2));
  console.log(
    `[make-cog] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${levels.length} levels, ` +
      `res0 ${levels[0].width}x${levels[0].height}, mpp ${mppX || 'n/a'}`,
  );
}

function parseOpts(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') o.out = args[++i];
    else if (args[i] === '--tile') o.tile = Number(args[++i]);
    else if (args[i] === '--q') o.q = Number(args[++i]);
  }
  return o;
}

main().catch((err) => {
  console.error('[make-cog] FAILED:', err?.message || err);
  process.exit(1);
});
