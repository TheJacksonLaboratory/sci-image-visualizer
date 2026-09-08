// Extract a Visium tissue image from an AnnData `.h5ad` and derive its registration.
//
//   node scripts/visium-image.mjs --h5ad visium_hne_adata.h5ad --out visium-hne.png
//
// A Visium `.h5ad` carries the H&E image inside `uns/spatial/<library>/images/<tier>`, at
// a DOWNSCALE of the resolution the spot coordinates are recorded in — `obsm/spatial` is
// in full-resolution pixels, while what ships in the file is the 2000 px `hires` tier (or
// the 600 px `lowres`). That ratio is the whole reason this script exists: the numbers
// relating the two are in the file, and typing them by hand is where alignment quietly
// breaks.
//
// Writes the PNG and prints the registration for `make-pyramid.mjs` and
// `h5ad-to-spatial.mjs`. Nothing here touches a bundle: the image goes through the same
// pyramid path as a real slide, so the server serves it identically.
//
// ## The physical scale is MEASURED, not read out of scalefactors
//
// The obvious source for µm/px is `scalefactors/spot_diameter_fullres` against the 55 µm
// Visium spot. It is wrong, and quietly: on the squidpy H&E dataset that field is
// 89.44 px, which against a measured lattice works out at 65.0 µm rather than 55 µm — an
// 18% error in every distance on screen, with nothing to give it away because the picture
// still looks entirely plausible.
//
// What is dependable is the SPOT PITCH. Visium spots sit on a regular hexagonal lattice
// 100 µm centre-to-centre, a property of the slide rather than of the sample or of
// whichever spaceranger version wrote the file. `array_row`/`array_col` say where each
// spot sits on that lattice, so fitting coordinates against them recovers the pitch in
// pixels to a fraction of a pixel — and the hex regularity is then a CHECK on the whole
// assumption rather than something to hope for.
//
//     µm per full-res px = SPOT_PITCH_UM / pitch measured in full-res px
//     µm per served px   = µm per full-res px / tissue_<tier>_scalef
//     imageRef.scale     = tissue_<tier>_scalef     (full-res coords -> served pixels)
//     radius             = (SPOT_DIAMETER_UM / 2) / µm per full-res px
//
// Note which constant does which job: the PITCH sets the scale, and the 55 µm DIAMETER
// only sizes the drawn marker. Deriving the radius from `spot_diameter_fullres` instead
// would draw 65 µm spots over a 55 µm reality — more overlap than the assay has.

import sharp from 'sharp';

import { attr, obsmArray, openH5ad } from '../lib/h5ad.mjs';

/** Centre-to-centre spot spacing on a Visium slide, in µm. Fixes the physical scale. */
const SPOT_PITCH_UM = 100;
/** Capture-spot diameter, in µm. Sizes the drawn marker, and nothing else. */
const SPOT_DIAMETER_UM = 55;
/** How far the lattice may depart from a regular hexagon before the fit is not trusted. */
const HEX_TOLERANCE = 0.02;

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const die = (msg) => { console.error(msg); process.exit(2); };

const h5ad = flag('h5ad') ?? die('--h5ad is required');
const out = flag('out') ?? die('--out is required');
const tier = flag('tier', 'hires');
const library = flag('library');
const spatialKey = flag('spatial-key', 'spatial');
const pitchUm = Number(flag('spot-pitch-um', SPOT_PITCH_UM));
const diameterUm = Number(flag('spot-diameter-um', SPOT_DIAMETER_UM));

/**
 * The tier's pixels as uint8 RGB.
 *
 * squidpy stores these as float32, and as 0..1 rather than 0..255 — but not always, and a
 * silently misread range is a black or blown-out slide, so the range decides rather than
 * the dtype alone.
 */
function toUint8(flat) {
  let peak = 0;
  for (let i = 0; i < flat.length; i++) if (flat[i] > peak) peak = flat[i];
  const scale = peak <= 1 ? 255 : 1;
  const out8 = new Uint8Array(flat.length);
  for (let i = 0; i < flat.length; i++) {
    out8[i] = Math.max(0, Math.min(255, Math.round(flat[i] * scale)));
  }
  return out8;
}

/** Least-squares slope and intercept of `y = a*x + b`. */
function fitLine(xs, ys) {
  const n = xs.length;
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  const a = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  return [a, (sy - a * sx) / n];
}

const rms = (xs, ys, [a, b]) => Math.sqrt(
  xs.reduce((acc, x, i) => acc + (ys[i] - (a * x + b)) ** 2, 0) / xs.length,
);

const f = await openH5ad(h5ad);
let report;
try {
  const uns = f.get('uns');
  if (!uns?.keys?.().includes('spatial')) die('no uns/spatial: not a Visium-style AnnData');
  const libraries = f.get('uns/spatial').keys();
  const lib = library ?? (libraries.length === 1 ? libraries[0] : null);
  if (!lib) die(`--library required, one of: ${libraries.join(', ')}`);
  if (!libraries.includes(lib)) die(`no uns/spatial/${lib}; have: ${libraries.join(', ')}`);

  const base = `uns/spatial/${lib}`;
  const images = f.get(`${base}/images`);
  if (!images?.keys?.().includes(tier)) {
    die(`no images/${tier}; have: ${images?.keys?.().join(', ') ?? 'none'}`);
  }
  const node = f.get(`${base}/images/${tier}`);
  const [height, width, channels] = node.shape.map(Number);
  if (channels !== 3 && channels !== 4) {
    die(`images/${tier}: expected HxWx3, got ${node.shape.join('x')}`);
  }
  const pixels = toUint8(node.value);
  const rgb = channels === 3 ? pixels : (() => {
    const three = new Uint8Array(width * height * 3);
    for (let i = 0, o = 0; i < width * height; i++, o += 3) {
      three[o] = pixels[i * 4];
      three[o + 1] = pixels[i * 4 + 1];
      three[o + 2] = pixels[i * 4 + 2];
    }
    return three;
  })();
  await sharp(Buffer.from(rgb), { raw: { width, height, channels: 3 } }).png().toFile(out);

  const sf = f.get(`${base}/scalefactors`);
  const tierKey = `tissue_${tier}_scalef`;
  if (!sf?.keys?.().includes(tierKey)) die(`no ${base}/scalefactors/${tierKey}`);
  const scalef = Number(f.get(`${base}/scalefactors/${tierKey}`).value);
  if (!(scalef > 0)) die(`${tierKey} is not positive: ${scalef}`);

  const coords = obsmArray(f, spatialKey);
  const obs = f.get('obs');
  let pitchPx;
  let how;
  if (obs.keys().includes('array_row') && obs.keys().includes('array_col')) {
    // Visium's axes are image-aligned, so x depends only on array_col and y only on
    // array_row — two 1-D fits rather than a 2-D affine, which keeps the residual
    // interpretable as "how well does this look like the lattice it claims to be".
    const rowIdx = Array.from(f.get('obs/array_row').value, Number);
    const colIdx = Array.from(f.get('obs/array_col').value, Number);
    const xs = Array.from({ length: coords.rows }, (_, i) => Number(coords.flat[i * coords.dims]));
    const ys = Array.from({ length: coords.rows }, (_, i) => Number(coords.flat[i * coords.dims + 1]));
    const fitX = fitLine(colIdx, xs);
    const fitY = fitLine(rowIdx, ys);
    const dx = Math.abs(fitX[0]);
    const dy = Math.abs(fitY[0]);
    if (!(dx > 0 && dy > 0)) die('array_row/array_col do not vary; cannot fit the lattice');
    // Consecutive spots in one row differ by TWO in array_col (the odd/even offset that
    // makes the grid hexagonal), so the same-row neighbour distance is 2*dx. Its
    // adjacent-row neighbour is one step in each, at hypot(dx, dy). On a regular hexagon
    // those are equal, and their ratio is the check.
    const sameRow = 2 * dx;
    const diagonal = Math.hypot(dx, dy);
    const ratio = diagonal / sameRow;
    if (Math.abs(ratio - 1) > HEX_TOLERANCE) {
      die(`lattice is not a regular hexagon (diagonal/same-row = ${ratio.toFixed(4)}); `
        + 'coordinates may not be full-resolution pixels');
    }
    pitchPx = (sameRow + diagonal) / 2;
    const resid = Math.hypot(rms(colIdx, xs, fitX), rms(rowIdx, ys, fitY));
    how = `hex ratio ${ratio.toFixed(4)}, residual ${resid.toFixed(2)} px`;
  } else {
    // Fallback for a file without the array indices: the median nearest-neighbour
    // distance. Weaker — a lattice edge or a dropped spot pulls individual distances,
    // which is why it is the median — and it cannot check hex regularity, so it says so.
    const best = [];
    for (let i = 0; i < coords.rows; i++) {
      let near = Infinity;
      const xi = Number(coords.flat[i * coords.dims]);
      const yi = Number(coords.flat[i * coords.dims + 1]);
      for (let j = 0; j < coords.rows; j++) {
        if (i === j) continue;
        const d = Math.hypot(xi - Number(coords.flat[j * coords.dims]),
          yi - Number(coords.flat[j * coords.dims + 1]));
        if (d < near) near = d;
      }
      best.push(near);
    }
    best.sort((a, b) => a - b);
    pitchPx = best[Math.floor(best.length / 2)];
    how = 'median nearest neighbour, unchecked';
  }

  const umPerFullres = pitchUm / pitchPx;
  const umPerServed = umPerFullres / scalef;
  const radius = (diameterUm / 2) / umPerFullres;

  // A check the caller can act on rather than a comment claiming it holds: the spots must
  // land INSIDE the tier they are about to be drawn over. Catches a coordinate frame that
  // is not full-resolution pixels, which no correct arithmetic downstream would fix.
  let lo = [Infinity, Infinity];
  let hi = [-Infinity, -Infinity];
  for (let i = 0; i < coords.rows; i++) {
    for (let d = 0; d < 2; d++) {
      const v = Number(coords.flat[i * coords.dims + d]) * scalef;
      if (v < lo[d]) lo[d] = v;
      if (v > hi[d]) hi[d] = v;
    }
  }
  const fits = lo[0] >= 0 && lo[1] >= 0 && hi[0] <= width && hi[1] <= height;

  const stated = sf.keys().includes('spot_diameter_fullres')
    ? Number(f.get(`${base}/scalefactors/spot_diameter_fullres`).value) : null;

  report = { width, height, lib, pitchPx, how, scalef, tierKey, umPerFullres, umPerServed, radius, lo, hi, fits, stated };
} finally {
  f.close();
}

const r = report;
console.log(`wrote ${out}: ${r.width}x${r.height} from images/${tier} of ${r.lib}`);
console.log(`  lattice pitch ${r.pitchPx.toFixed(2)} full-res px = ${pitchUm} µm  (${r.how})`);
console.log(`    ->  ${r.umPerFullres.toFixed(6)} µm per full-res px`);
console.log(`  ${r.tierKey} ${r.scalef.toFixed(8)}  ->  ${r.umPerServed.toFixed(4)} µm per served px`);
if (r.stated !== null) {
  // What the obvious-but-wrong route would have produced, on the record rather than as a
  // claim in a comment.
  console.log(`  (scalefactors/spot_diameter_fullres ${r.stated.toFixed(2)} px would be `
    + `${(r.stated * r.umPerFullres).toFixed(1)} µm, not ${diameterUm} — not used)`);
}
console.log(`  spots span x ${r.lo[0].toFixed(1)}..${r.hi[0].toFixed(1)}, `
  + `y ${r.lo[1].toFixed(1)}..${r.hi[1].toFixed(1)} in a ${r.width}x${r.height} image: `
  + `${r.fits ? 'inside' : 'OUT OF BOUNDS'}`);
console.log('');
console.log(`  make-pyramid:  --mpp ${r.umPerServed.toFixed(4)}`);
console.log(`  converter:     --image-scale ${r.scalef.toFixed(8)},${r.scalef.toFixed(8)} \\`);
console.log(`                 --image-mpp ${r.umPerServed.toFixed(4)},${r.umPerServed.toFixed(4)} \\`);
console.log(`                 --microns-per-unit ${r.umPerFullres.toFixed(6)} --radius ${r.radius.toFixed(2)}`);
if (!r.fits) {
  console.error('spots fall outside the image; check --spatial-key and --tier');
  process.exit(2);
}
