// Generate a synthetic, Visium-shaped spatial-omics dataset so `npm start`
// serves something immediately — no 68 MB download, no Python, no network.
//
//   node scripts/make-spatial-demo.mjs [--out <dir>] [--id demo-brain]
//
// The geometry is real Visium geometry (4,992 capture spots on a hex grid,
// 100 µm centre-to-centre, 55 µm diameter, filtered to an in-tissue mask), and
// the marker genes are real mouse-brain markers, so the demo reads plausibly
// and exercises every branch of the wire format. The EXPRESSION IS FABRICATED —
// spatially structured noise, not measurements. For real data use
// `make_spatial.py`, which converts a SpatialData Zarr store.
//
// Writes the layout documented in ../lib/spatial.mjs.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const ID = argOf('--id', 'demo-brain');
const OUT_ROOT = argOf('--out', new URL('../spatial', import.meta.url).pathname);
const OUT = path.join(OUT_ROOT, ID);

// ── Visium v1 capture geometry ──────────────────────────────────────────────
const ROWS = 78;              // array_row 0..77
const COLS = 128;             // array_col 0..127, same parity as the row
const PITCH_UM = 100;         // centre-to-centre
const SPOT_DIAMETER_UM = 55;
const MPP = 1.0;              // µm per pixel of the reference image
const PITCH_PX = PITCH_UM / MPP;
const RADIUS_PX = SPOT_DIAMETER_UM / 2 / MPP;

// Deterministic PRNG so re-running produces an identical dataset (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260901);
/** Box-Muller normal. */
function gauss(mean = 0, sd = 1) {
  const u = Math.max(rand(), 1e-9);
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// ── Tissue mask: a coronal-section-ish blob ─────────────────────────────────
const CX = (COLS / 2) * (PITCH_PX / 2);
const CY = (ROWS / 2) * PITCH_PX * (Math.sqrt(3) / 2);
const RX = CX * 0.78;
const RY = CY * 0.72;

function inTissue(x, y) {
  const nx = (x - CX) / RX;
  const ny = (y - CY) / RY;
  // Ellipse, flattened on top so it reads as a brain section rather than an egg.
  const squash = ny < 0 ? 1.25 : 1.0;
  return nx * nx + (ny * squash) * (ny * squash) <= 1;
}

// ── Build the spot grid ─────────────────────────────────────────────────────
const xs = [];
const ys = [];
const ids = [];
const arrayRow = [];
const arrayCol = [];
for (let row = 0; row < ROWS; row++) {
  for (let col = row % 2; col < COLS; col += 2) {
    const x = col * (PITCH_PX / 2);
    const y = row * PITCH_PX * (Math.sqrt(3) / 2);
    if (!inTissue(x, y)) continue;
    xs.push(x);
    ys.push(y);
    arrayRow.push(row);
    arrayCol.push(col);
    ids.push(`${String(col).padStart(3, '0')}x${String(row).padStart(3, '0')}-1`);
  }
}
const N = xs.length;

// ── Anatomical regions → the categorical column ─────────────────────────────
// Concentric-ish bands: cortex at the rim, then white matter, hippocampus,
// thalamus in the middle, with a choroid-plexus spot near the midline.
const REGIONS = ['Cortex', 'White matter', 'Hippocampus', 'Thalamus', 'Choroid plexus'];
const REGION_COLORS = ['#4c72b0', '#dd8452', '#55a868', '#c44e52', '#8172b3'];
const codes = new Uint16Array(N);
for (let i = 0; i < N; i++) {
  const nx = (xs[i] - CX) / RX;
  const ny = (ys[i] - CY) / RY;
  const r = Math.sqrt(nx * nx + ny * ny) + gauss(0, 0.03);
  const nearMidline = Math.abs(nx) < 0.10 && ny > -0.15 && ny < 0.25;
  if (nearMidline && r < 0.35) codes[i] = 4;
  else if (r > 0.80) codes[i] = 0;
  else if (r > 0.62) codes[i] = 1;
  else if (r > 0.38) codes[i] = 2;
  else codes[i] = 3;
}

// ── Continuous columns ──────────────────────────────────────────────────────
const totalCounts = new Float32Array(N);
const nGenes = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const base = [9000, 6500, 11000, 8000, 14000][codes[i]];
  totalCounts[i] = Math.max(200, Math.round(base * Math.exp(gauss(0, 0.28))));
  nGenes[i] = Math.round(Math.min(6500, 1200 + totalCounts[i] * 0.28 * Math.exp(gauss(0, 0.10))));
}

// ── Marker genes: real names, fabricated (region-enriched) expression ────────
const GENES = [
  { name: 'Snap25', region: null, base: 3.2 },          // pan-neuronal
  { name: 'Camk2a', region: 0, base: 1.1 },
  { name: 'Cux2', region: 0, base: 0.6 },
  { name: 'Mbp', region: 1, base: 1.4 },
  { name: 'Plp1', region: 1, base: 1.2 },
  { name: 'Prox1', region: 2, base: 0.5 },
  { name: 'Neurod6', region: 2, base: 0.9 },
  { name: 'Prkcd', region: 3, base: 0.7 },
  { name: 'Tcf7l2', region: 3, base: 0.6 },
  { name: 'Ttr', region: 4, base: 0.4 },                // choroid plexus, very sharp
  { name: 'Gfap', region: null, base: 0.8 },
  { name: 'Fth1', region: null, base: 2.6 },
];

// GENE-MAJOR matrix: [gene0: f32*N][gene1: f32*N]… — the layout that makes a
// per-gene fetch a contiguous ranged read on the server.
const matrix = new Float32Array(GENES.length * N);
GENES.forEach((gene, g) => {
  const offset = g * N;
  for (let i = 0; i < N; i++) {
    const enriched = gene.region === null ? 1 : (codes[i] === gene.region ? 6.0 : 0.35);
    // log1p-normalised-looking values, floored at 0 with a dropout rate.
    const v = gene.base * enriched * Math.exp(gauss(0, 0.45));
    matrix[offset + i] = rand() < 0.06 ? 0 : Math.max(0, v);
  }
});

// ── Spot outlines: each spot as a 16-gon, in wire layout ────────────────────
const RING_VERTICES = 16;
const polyOffsets = new Uint32Array(N + 1);
const polyCoords = new Float32Array(N * RING_VERTICES * 2);
for (let i = 0; i < N; i++) {
  polyOffsets[i] = i * RING_VERTICES;
  for (let v = 0; v < RING_VERTICES; v++) {
    const a = (v / RING_VERTICES) * Math.PI * 2;
    polyCoords[(i * RING_VERTICES + v) * 2] = xs[i] + Math.cos(a) * RADIUS_PX;
    polyCoords[(i * RING_VERTICES + v) * 2 + 1] = ys[i] + Math.sin(a) * RADIUS_PX;
  }
}
polyOffsets[N] = N * RING_VERTICES;

// ── Serialise ───────────────────────────────────────────────────────────────
/** coords.bin: [x f32*N][y f32*N] — already the client's decode layout. */
function coordsBuffer() {
  const out = new Float32Array(N * 2);
  out.set(Float32Array.from(xs), 0);
  out.set(Float32Array.from(ys), N);
  return Buffer.from(out.buffer);
}

/** polygons.bin: [u32 count][u32 offsets×(N+1)][f32 coords]. */
function polygonsBuffer() {
  const header = new Uint32Array(1 + N + 1);
  header[0] = N;
  header.set(polyOffsets, 1);
  return Buffer.concat([Buffer.from(header.buffer), Buffer.from(polyCoords.buffer)]);
}

const columns = [
  {
    kind: 'categorical', name: 'region', description: 'Anatomical region (synthetic)',
    categories: REGIONS, colors: REGION_COLORS,
  },
  {
    kind: 'continuous', name: 'total_counts', description: 'UMI counts per spot (synthetic)',
    unit: 'counts', logScaleHint: true,
    min: Math.min(...totalCounts), max: Math.max(...totalCounts),
  },
  {
    kind: 'continuous', name: 'n_genes_by_counts', description: 'Genes detected per spot (synthetic)',
    unit: 'genes', logScaleHint: false,
    min: Math.min(...nGenes), max: Math.max(...nGenes),
  },
  {
    kind: 'continuous', name: 'array_row', description: 'Visium array row',
    min: Math.min(...arrayRow), max: Math.max(...arrayRow),
  },
];

const manifest = {
  version: 1,
  id: ID,
  name: 'Synthetic Visium-geometry mouse brain (demo)',
  count: N,
  hasIds: true,
  radius: { mode: 'uniform', value: RADIUS_PX },
  columns,
  features: {
    count: GENES.length,
    names: GENES.map((g) => g.name), // small panel -> inline, no /features round-trip
    unit: 'log1p normalized (synthetic)',
    logScaleHint: false,
  },
  polygons: { count: N },
  imageRef: {
    // No image is generated here — the host points this at whichever tissue
    // image it serves. Coordinates are already in that image's pixel space.
    scale: [1, 1],
    translate: [0, 0],
    mppX: MPP,
    mppY: MPP,
  },
};

await mkdir(path.join(OUT, 'columns'), { recursive: true });
await mkdir(path.join(OUT, 'features'), { recursive: true });

await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(path.join(OUT, 'coords.bin'), coordsBuffer());
await writeFile(path.join(OUT, 'ids.json'), JSON.stringify({ ids }));
await writeFile(path.join(OUT, 'polygons.bin'), polygonsBuffer());
// Columns are stored by INDEX in manifest.columns (see lib/spatial.mjs).
await writeFile(path.join(OUT, 'columns', '0.bin'), Buffer.from(codes.buffer));
await writeFile(path.join(OUT, 'columns', '1.bin'), Buffer.from(totalCounts.buffer));
await writeFile(path.join(OUT, 'columns', '2.bin'), Buffer.from(nGenes.buffer));
await writeFile(path.join(OUT, 'columns', '3.bin'), Buffer.from(Float32Array.from(arrayRow).buffer));
await writeFile(path.join(OUT, 'features', 'names.json'), JSON.stringify(GENES.map((g) => g.name)));
await writeFile(path.join(OUT, 'features', 'matrix.f32'), Buffer.from(matrix.buffer));

const counts = REGIONS.map((r, i) => `${r}=${codes.reduce((n, c) => n + (c === i ? 1 : 0), 0)}`);
console.log(`[make-spatial-demo] wrote ${OUT}`);
console.log(`  ${N} spots (of ${ROWS * (COLS / 2)} capture positions), radius ${RADIUS_PX} px`);
console.log(`  regions: ${counts.join(', ')}`);
console.log(`  ${GENES.length} genes, matrix ${(GENES.length * N * 4 / 1024).toFixed(0)} KiB gene-major`);
