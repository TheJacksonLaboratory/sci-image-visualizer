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
//
// MULTICHANNEL (fluorescence) sources — a multi-page TIFF where each page is one
// single-band channel, e.g. an ImageJ hyperstack with `channels=N`:
//
//   node scripts/make-cog.mjs <input> <imageId> --channels auto
//
// builds a SEPARATE pyramid per channel (L{res}_c{c}.tif) and marks the
// descriptor `multichannel: true`, so the library splits the image into one
// per-channel pseudo-colour layer and the Channels pane can window/tint/hide
// each band. Channel pyramids are deflate-compressed (lossless) because the
// client windows the raw single-band values — JPEG would shift them.
//
//   --multichannel false
//
// builds the same per-channel pyramids but advertises `multichannel: false`,
// which is what a server reports for a fluorescence stack with no embedded
// per-channel LUT. Useful for reproducing the "only one channel renders and the
// Channels pane does nothing" behaviour against an otherwise identical image.

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { openSync, readSync, closeSync } from 'node:fs';
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
 *  per-format metadata fields (openslide.*, aperio.*, tiff.*). The raw text is
 *  kept too: an ImageJ ImageDescription spills onto continuation lines that
 *  carry no `key:` prefix (`unit=micron`, `spacing=…`), so it is unparseable as
 *  key/value but still the only place the physical unit is stated. */
function readHeaders(input) {
  const raw = vips('vipsheader', ['-a', input]);
  const map = { __raw: raw };
  for (const line of raw.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return map;
}

/** µm per unit for an ImageJ `unit=` string, or null when it isn't a length we
 *  recognise (ImageJ also writes "pixel"/"inch"/arbitrary labels). */
function umPerUnit(unit) {
  const u = String(unit || '').trim().toLowerCase();
  if (!u) return null;
  if (/^(micron|microns|um|µm|µm)$/.test(u)) return 1;
  if (/^(nm|nanometer|nanometre)s?$/.test(u)) return 1e-3;
  if (/^(mm|millimeter|millimetre)s?$/.test(u)) return 1e3;
  if (/^(cm|centimeter|centimetre)s?$/.test(u)) return 1e4;
  if (/^(m|meter|metre)s?$/.test(u)) return 1e6;
  if (/^(inch|inches|in)$/.test(u)) return 25400;
  return null; // "pixel" and friends carry no physical scale
}

/** µm/pixel from whatever field the format exposes. */
function mppFrom(h, axis /* 'x' | 'y' */) {
  const cands = [
    h[`openslide.mpp-${axis}`],
    h['aperio.MPP'],
    (() => {
      // ImageJ: XResolution is in pixels per the unit named in the
      // ImageDescription (`unit=micron`), and ResolutionUnit is usually absent
      // or "none" — so the TIFF-standard branch below can't see the scale.
      const r = Number(h[axis === 'x' ? 'xres' : 'yres']);
      if (!Number.isFinite(r) || r <= 0) return null;
      const um = umPerUnit(/(?:^|\n)unit=(.+)/.exec(h.__raw ?? '')?.[1]);
      return um === null ? null : um / r;
    })(),
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

/** µm between z-slices, from ImageJ's `spacing=` (already in `unit=`). 0 when
 *  the source doesn't state one. Informational: it preserves the source's z
 *  scale in the COG so a stack's depth isn't silently lost. */
function mppZFrom(h) {
  const spacing = Number(/(?:^|\n)spacing=([-\d.eE]+)/.exec(h.__raw ?? '')?.[1]);
  if (!Number.isFinite(spacing) || spacing <= 0) return 0;
  const um = umPerUnit(/(?:^|\n)unit=(.+)/.exec(h.__raw ?? '')?.[1]);
  return um === null ? 0 : Math.abs(spacing) * um;
}

/** Fiji's Merge Channels palette — matches the library's own fallback tints. */
const CHANNEL_COLORS = ['#FF0000', '#00FF00', '#0000FF', '#FFFFFF', '#00FFFF', '#FF00FF', '#FFFF00'];

/**
 * ImageJ writes large hyperstacks as a "fake" TIFF: ONE IFD describing plane 0,
 * with every remaining plane's pixels appended contiguously and no IFD of its
 * own. Only ImageJ's own reader (and Bio-Formats) knows to walk them via the
 * ImageDescription, so `vipsheader` reports `n-pages: 1` and every generic TIFF
 * reader sees a single plane.
 *
 * Returns the geometry needed to address plane p at
 * `dataOffset + p * planeBytes`, or null when the file is a normal (multi-IFD)
 * TIFF that vips can page through itself.
 */
function readImageJHyperstack(input) {
  const fd = openSync(input, 'r');
  try {
    const head = Buffer.alloc(65536);
    readSync(fd, head, 0, 65536, 0);
    const order = head.toString('ascii', 0, 2);
    if (order !== 'II' && order !== 'MM') return null;
    const le = order === 'II';
    const u16 = (o) => (le ? head.readUInt16LE(o) : head.readUInt16BE(o));
    const u32 = (o) => (le ? head.readUInt32LE(o) : head.readUInt32BE(o));
    if (u16(2) !== 42) return null; // BigTIFF (43) uses a different layout

    const ifd0 = u32(4);
    const count = u16(ifd0);
    const tags = {};
    for (let i = 0; i < count; i++) {
      const e = ifd0 + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      if (type === 3 && n === 1) tags[tag] = u16(e + 8);
      else if (type === 4 && n === 1) tags[tag] = u32(e + 8);
      else if (type === 2) {
        const at = n > 4 ? u32(e + 8) : e + 8;
        tags[tag] = head.toString('latin1', at, at + n).replace(/\0+$/, '');
      }
    }
    // A second IFD means vips can page through it normally — not the fake layout.
    if (u32(ifd0 + 2 + count * 12) !== 0) return null;

    const desc = String(tags[270] ?? '');
    if (!/(^|\n)ImageJ=/.test(desc)) return null;
    const intOf = (k) => {
      const m = new RegExp(`(?:^|\\n)${k}=(\\d+)`).exec(desc);
      return m ? parseInt(m[1], 10) : undefined;
    };
    const images = intOf('images') ?? 1;
    if (images <= 1) return null; // single plane: nothing special to do

    const width = tags[256];
    const height = tags[257];
    const spp = tags[277] ?? 1;
    const bps = tags[258] ?? 8;
    const dataOffset = tags[273]; // StripOffsets — one strip per plane here
    if (!width || !height || !dataOffset) return null;
    if (tags[259] !== 1) throw new Error('ImageJ hyperstack must be uncompressed to address planes by offset');

    return {
      width,
      height,
      bands: spp,
      bps,
      dataOffset,
      planeBytes: width * height * spp * (bps / 8),
      images,
      channels: intOf('channels') ?? 1,
      slices: intOf('slices') ?? 1,
      // Photometric 3 = palette: the file carries an embedded LUT (ColorMap).
      palette: tags[262] === 3,
    };
  } finally {
    closeSync(fd);
  }
}

/** Extract one contiguous plane to a temp .raw, then encode it as the tiled,
 *  lossless full-res level. `vips rawload --offset` can't be used: the CLI parses
 *  the offset into 32 bits, so anything past 4 GB silently reads plane 0. */
function planeToLevel0(hs, input, rawPath, outSpec, planeIndex) {
  const start = hs.dataOffset + planeIndex * hs.planeBytes;
  // tail -c +N seeks; dd's byte-granular skip flags are GNU-only.
  execFileSync('/bin/sh', [
    '-c',
    `tail -c +${start + 1} ${JSON.stringify(input)} | head -c ${hs.planeBytes} > ${JSON.stringify(rawPath)}`,
  ]);
  vipsRun('vips', ['rawload', rawPath, outSpec, String(hs.width), String(hs.height), String(hs.bands)]);
}

async function main() {
  const [input, imageId, ...rest] = process.argv.slice(2);
  if (!input || !imageId) {
    console.error(
      'usage: make-cog.mjs <input> <imageId> [--out cogs] [--tile 512] [--q 85]\n' +
        '                   [--channels auto|N] [--multichannel true|false]',
    );
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
  const mppZ = mppZFrom(h);

  // An ImageJ "fake" TIFF (one IFD + contiguous planes) needs offset addressing;
  // a normal multi-IFD TIFF is paged by vips itself.
  const hs = opt.channels === undefined ? null : readImageJHyperstack(input);
  // One single-band pyramid per channel when asked. `auto` reads the channel
  // count from the hyperstack metadata, else the page count (channel c of slice
  // z lives at page z*C+c, so with a single slice pages == channels).
  const channels = resolveChannels(opt.channels, h, hs);
  const multi = channels > 1;
  // Which z planes to build. `--slices auto` builds the whole stack (the file's
  // real shape); `--slices N` the first N; otherwise a single slice — `--slice Z`
  // or, by default, the middle one (usually the most in-focus).
  const zList = resolveSlices(opt, hs);
  if (hs) {
    console.log(
      `[make-cog] ImageJ hyperstack: ${hs.images} planes = ${hs.channels}ch x ${hs.slices}z, ` +
        `${hs.planeBytes} B/plane from offset ${hs.dataOffset}` +
        `${hs.palette ? ', palette/LUT embedded' : ''} — building z=[${
          zList.length > 6 ? `${zList[0]}..${zList[zList.length - 1]}` : zList.join(',')
        }] (${zList.length} slice${zList.length === 1 ? '' : 's'})`,
    );
  }
  // A stack keys its level files by z as well; a single slice keeps the flat
  // per-channel naming so existing single-slice COGs stay readable.
  const stack = zList.length > 1;
  const levelName = (res, c, zi) => (stack ? `L${res}_z${zi}_c${c}.tif` : `L${res}_c${c}.tif`);
  console.log(
    `[make-cog] ${input}  ${fullW}x${fullH}px  mpp=${mppX || 'n/a'}  ` +
      `channels=${channels}${multi ? ' (per-channel pyramids)' : ''}  -> ${outDir}`,
  );

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
  // Channel pyramids stay LOSSLESS (deflate): the client windows the raw
  // single-band values per channel, and JPEG would shift them.
  const t0 = Date.now();
  // Rewrite descriptor.json against the level files already on disk — for
  // re-deriving metadata (e.g. a corrected physical scale) without spending
  // another pyramid build.
  const descriptorOnly = !!opt.descriptorOnly;
  if (descriptorOnly) console.log('[make-cog] --descriptor-only: reusing existing level files');
  const save = (file, lossless) =>
    `${file}[${lossless ? 'compression=deflate' : `compression=jpeg,Q=${q}`}` +
    `,tile,tile-width=${tile},tile-height=${tile},bigtiff]`;
  // Contiguous-plane hyperstack: cut each channel's full-res plane out by offset
  // first (L0), then derive the coarser levels from that — vips can't page it.
  if (hs && multi && !descriptorOnly) {
    for (let zi = 0; zi < zList.length; zi++) {
      const z = zList[zi];
      for (let c = 0; c < channels; c++) {
        const l0 = path.join(outDir, levelName(0, c, zi));
        const raw = path.join(outDir, `.plane_z${zi}_c${c}.raw`);
        const plane = z * hs.channels + c; // channels vary fastest (XYCZT)
        console.log(
          `[make-cog]  [${zi + 1}/${zList.length}] L0 z${zi} c${c}: plane ${plane} (source z=${z}) ` +
            `-> ${hs.width}x${hs.height} ...`,
        );
        planeToLevel0(hs, input, raw, save(l0, true), plane);
        await rm(raw, { force: true });
        for (const { res, targetW } of [...plan].reverse()) {
          if (res === 0) continue; // L0 already written from the raw plane
          vipsRun('vipsthumbnail', [l0, '--size', `${targetW}x100000000`, '-o', save(path.join(outDir, levelName(res, c, zi)), true)]);
        }
      }
    }
  }
  for (const { res, targetW } of [...plan].reverse()) {
    if (descriptorOnly) break;
    if (hs && multi) break; // handled above
    if (multi) {
      for (let c = 0; c < channels; c++) {
        const outFile = path.join(outDir, `L${res}_c${c}.tif`);
        console.log(`[make-cog]  L${res} c${c}: target width ${targetW} ...`);
        vipsRun('vipsthumbnail', [`${input}[page=${c}]`, '--size', `${targetW}x100000000`, '-o', save(outFile, true)]);
      }
    } else {
      const outFile = path.join(outDir, `L${res}.tif`);
      console.log(`[make-cog]  L${res}: target width ${targetW} ...`);
      vipsRun('vipsthumbnail', [input, '--size', `${targetW}x100000000`, '-o', save(outFile, false)]);
    }
  }

  // Read back ACTUAL level dims so the descriptor's tile grid matches byte-for-byte.
  const levels = [];
  for (const { res } of plan) {
    const f = path.join(outDir, multi ? levelName(res, 0, 0) : `L${res}.tif`);
    const meta = await sharp(f, { limitInputPixels: false }).metadata();
    levels.push({ res, width: meta.width, height: meta.height });
  }
  levels.sort((a, b) => a.res - b.res);

  const bitDepth = 8; // every level is written as 8-bit by vipsthumbnail
  const descriptor = {
    width: levels[0].width,
    height: levels[0].height,
    tileSize: tile,
    z: zList.length,
    channels: multi ? channels : 3,
    // `--multichannel false` keeps the per-channel tiles on disk but advertises a
    // flat composite, mirroring a server that won't flag a LUT-less fluorescence
    // stack as multichannel.
    multichannel: multi ? opt.multichannel !== false : false,
    realLevels: levels.length,
    channelInfo: multi
      ? Array.from({ length: channels }, (_, c) => ({
          name: `Channel ${c + 1}`,
          color: CHANNEL_COLORS[c % CHANNEL_COLORS.length],
          bitDepth,
          minAllowed: 0,
          maxAllowed: (1 << bitDepth) - 1,
        }))
      : null,
    levels,
    mppX,
    mppY,
    // Slice spacing in µm. The library reads only mppX/mppY today, but keeping
    // the z scale means the COG still describes the same physical volume as the
    // source rather than losing depth on conversion.
    ...(mppZ > 0 ? { mppZ } : {}),
  };
  await writeFile(path.join(outDir, 'descriptor.json'), JSON.stringify(descriptor, null, 2));
  console.log(
    `[make-cog] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${levels.length} levels` +
      `${multi ? ` x ${channels} channels (multichannel=${descriptor.multichannel})` : ''}, ` +
      `res0 ${levels[0].width}x${levels[0].height}, mpp ${mppX || 'n/a'}`,
  );
}

/** Which source z planes to build, as source-slice indices in output order.
 *  `--slices auto` = the whole stack; `--slices N` = the first N; otherwise a
 *  single slice (`--slice Z`, default the middle one). */
function resolveSlices(opt, hs) {
  const total = hs?.slices ?? 1;
  if (opt.slices !== undefined) {
    const n = opt.slices === 'auto' ? total : Number(opt.slices);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--slices must be a positive integer or "auto", got ${opt.slices}`);
    return Array.from({ length: Math.min(n, total) }, (_, i) => i);
  }
  const z = opt.slice ?? (total > 1 ? Math.floor(total / 2) : 0);
  if (z < 0 || z >= total) throw new Error(`--slice ${z} out of range 0..${total - 1}`);
  return [z];
}

/** Channel count: explicit `--channels N`, or `auto` — the hyperstack's declared
 *  channel count when the source is an ImageJ fake TIFF, else the page count. */
function resolveChannels(spec, headers, hs) {
  if (spec === undefined) return 1;
  if (spec !== 'auto') {
    const n = Number(spec);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--channels must be a positive integer or "auto", got ${spec}`);
    return n;
  }
  if (hs) return hs.channels;
  const pages = Number(headers['n-pages'] ?? headers['tiff.n-pages'] ?? 1);
  return Number.isFinite(pages) && pages >= 1 ? pages : 1;
}

function parseOpts(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') o.out = args[++i];
    else if (args[i] === '--tile') o.tile = Number(args[++i]);
    else if (args[i] === '--q') o.q = Number(args[++i]);
    else if (args[i] === '--channels') o.channels = args[++i];
    else if (args[i] === '--multichannel') o.multichannel = args[++i] !== 'false';
    else if (args[i] === '--slice') o.slice = Number(args[++i]);
    else if (args[i] === '--slices') o.slices = args[++i];
    else if (args[i] === '--descriptor-only') o.descriptorOnly = true;
  }
  return o;
}

main().catch((err) => {
  console.error('[make-cog] FAILED:', err?.message || err);
  process.exit(1);
});
