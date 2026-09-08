// Write a small synthetic SpatialData-shaped Zarr v3 store, so the zarr path can be
// developed and demoed with no download.
//
//   node scripts/make-zarr-demo.mjs [--out stores/demo-zarr] [--spots 400]
//
// Why this exists: `$ZARR_DIR` is the one spatial source that needs NO build step —
// `spatial-zarr.mjs` reads a store directly — and yet nothing in the repo produced one,
// so the whole path was untestable without fetching a real SpatialData sandbox zip. The
// bundle path has had `make-spatial-demo.mjs` for exactly this reason; this is its
// counterpart.
//
// Deliberately UNCOMPRESSED. `lib/zarr3.mjs` reads zstd and gzip, but a fixture whose
// chunks are raw little-endian bytes needs no codec at all, which keeps this script to
// plain `writeFile` and makes a wrong byte obvious when something does not read back.
//
// What it writes (the subset `spatial-zarr.mjs` actually reads):
//
//   zarr.json                              root group
//   shapes/<region>/zarr.json              so the region resolves; no geometry needed,
//                                          because obsm/spatial carries the coordinates
//   tables/table/obs/_index                cell ids
//   tables/table/obs/region                categorical: which shapes element a row is in
//   tables/table/obs/{cluster,total_counts}
//   tables/table/var/_index                gene names
//   tables/table/X/{data,indices,indptr}   CSR over observations
//   tables/table/obsm/spatial              n x 2 coordinates
//   tables/table/obsm/{X_umap,X_umap3d}    embeddings, the point of the fixture

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const OUT = path.resolve(argOf('--out', new URL('../stores/demo-zarr', import.meta.url).pathname));
const SPOTS = Number(argOf('--spots', 400));
const GENES = 20;
const REGION = 'spots';
const TABLE = 'table';
const CLUSTERS = ['Cortex', 'White matter', 'Hippocampus', 'Ventricle'];

/** Deterministic RNG, so a regenerated fixture is byte-identical. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const group = () => JSON.stringify({
  zarr_format: 3, node_type: 'group', attributes: {},
}, null, 1);

/**
 * One Zarr v3 array: metadata plus a single chunk covering the whole thing.
 *
 * Single-chunk on purpose. `readArray` supports exactly two layouts — one chunk, or a 1-D
 * array split into many — and a fixture has no reason to exercise the harder one.
 */
async function writeArray(dir, shape, dataType, bytes, codecs) {
  await mkdir(path.join(dir, 'c', ...shape.slice(0, -1).map(() => '0')), { recursive: true });
  await writeFile(path.join(dir, 'zarr.json'), JSON.stringify({
    zarr_format: 3,
    node_type: 'array',
    shape,
    data_type: dataType,
    chunk_grid: { name: 'regular', configuration: { chunk_shape: shape } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: dataType === 'string' ? '' : 0,
    codecs,
    attributes: {},
  }, null, 1));
  await writeFile(path.join(dir, 'c', ...shape.map(() => '0')), bytes);
}

const numeric = (dir, shape, dataType, typed) => writeArray(
  dir, shape, dataType, Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength),
  [{ name: 'bytes', configuration: { endian: 'little' } }],
);

/** numcodecs vlen-utf8: `[u32 count]` then `[u32 byteLength][utf8 bytes]` each. */
function encodeVlenUtf8(values) {
  const parts = values.map((v) => Buffer.from(String(v), 'utf8'));
  const size = 4 + parts.reduce((n, b) => n + 4 + b.length, 0);
  const out = Buffer.alloc(size);
  out.writeUInt32LE(values.length, 0);
  let o = 4;
  for (const b of parts) {
    out.writeUInt32LE(b.length, o);
    o += 4;
    b.copy(out, o);
    o += b.length;
  }
  return out;
}

const strings = (dir, values) => writeArray(
  dir, [values.length], 'string', encodeVlenUtf8(values), [{ name: 'vlen-utf8' }],
);

/** A categorical obs column, in the group form `loadObs` expects. */
async function categorical(dir, categories, codes) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'zarr.json'), group());
  await strings(path.join(dir, 'categories'), categories);
  await numeric(path.join(dir, 'codes'), [codes.length], 'int8', codes);
}

// ── the data ────────────────────────────────────────────────────────────────
const rand = rng(11);
const cols = Math.ceil(Math.sqrt(SPOTS));
const x = new Float32Array(SPOTS);
const y = new Float32Array(SPOTS);
const cluster = new Int8Array(SPOTS);
const totals = new Float32Array(SPOTS);
for (let i = 0; i < SPOTS; i++) {
  const gx = i % cols;
  const gy = Math.floor(i / cols);
  // A hex-ish grid at a 100-unit pitch, so `medianPitch` finds something sane and the
  // manifest's derived radius and µm/px are not degenerate.
  x[i] = gx * 100 + (gy % 2) * 50;
  y[i] = gy * 87;
  // Four concentric-ish regions, so a cluster column means something on the map.
  const r = Math.hypot(gx - cols / 2, gy - cols / 2) / (cols / 2);
  cluster[i] = Math.min(CLUSTERS.length - 1, Math.floor(r * CLUSTERS.length));
  totals[i] = 2000 + rand() * 8000;
}

// Expression: each gene enriched in one cluster, so a heatmap is readable. Synthetic, and
// the README says so — an embedding of this recovers the generator, not biology.
const geneNames = Array.from({ length: GENES }, (_, g) => `Gene${String(g + 1).padStart(2, '0')}`);
const data = [];
const indices = [];
const indptr = new Int32Array(SPOTS + 1);
for (let i = 0; i < SPOTS; i++) {
  indptr[i] = data.length;
  for (let g = 0; g < GENES; g++) {
    if (rand() < 0.25) continue; // dropout
    const enriched = (g % CLUSTERS.length) === cluster[i] ? 5 : 1;
    data.push(Math.round(enriched * (0.5 + rand() * 3) * 100) / 100);
    indices.push(g);
  }
}
indptr[SPOTS] = data.length;

// Embeddings. Published coordinates, as far as the server is concerned — it serves what
// the store holds and marks nothing derived.
const umap = new Float32Array(SPOTS * 2);
const umap3d = new Float32Array(SPOTS * 3);
for (let i = 0; i < SPOTS; i++) {
  // Cluster-separated blobs: the shape a UMAP of this data would have, without pulling in
  // a UMAP implementation to produce a fixture.
  const a = (cluster[i] / CLUSTERS.length) * Math.PI * 2;
  const jitter = () => (rand() - 0.5) * 1.6;
  umap[i * 2] = Math.cos(a) * 6 + jitter();
  umap[i * 2 + 1] = Math.sin(a) * 6 + jitter();
  umap3d[i * 3] = Math.cos(a) * 6 + jitter();
  umap3d[i * 3 + 1] = Math.sin(a) * 6 + jitter();
  umap3d[i * 3 + 2] = (cluster[i] - CLUSTERS.length / 2) * 3 + jitter();
}

// ── write it ────────────────────────────────────────────────────────────────
await rm(OUT, { recursive: true, force: true });
const base = path.join(OUT, 'tables', TABLE);
await mkdir(base, { recursive: true });
await writeFile(path.join(OUT, 'zarr.json'), group());

// The region must exist as a shapes element or `regionsOf` will not resolve it. No
// geometry inside: `loadGeometry` prefers obsm/spatial and never opens the parquet.
await mkdir(path.join(OUT, 'shapes', REGION), { recursive: true });
await writeFile(path.join(OUT, 'shapes', REGION, 'zarr.json'), group());
await writeFile(path.join(OUT, 'tables', 'zarr.json'), group());
await writeFile(path.join(base, 'zarr.json'), group());

for (const sub of ['obs', 'var', 'obsm', 'X']) {
  await mkdir(path.join(base, sub), { recursive: true });
  await writeFile(path.join(base, sub, 'zarr.json'), group());
}

await strings(path.join(base, 'obs', '_index'),
  Array.from({ length: SPOTS }, (_, i) => `spot-${i}`));
await categorical(path.join(base, 'obs', 'region'), [REGION], new Int8Array(SPOTS));
await categorical(path.join(base, 'obs', 'cluster'), CLUSTERS, cluster);
await numeric(path.join(base, 'obs', 'total_counts'), [SPOTS], 'float32', totals);

await strings(path.join(base, 'var', '_index'), geneNames);

await numeric(path.join(base, 'X', 'data'), [data.length], 'float32', Float32Array.from(data));
await numeric(path.join(base, 'X', 'indices'), [indices.length], 'int32', Int32Array.from(indices));
await numeric(path.join(base, 'X', 'indptr'), [SPOTS + 1], 'int32', indptr);

const xy = new Float32Array(SPOTS * 2);
for (let i = 0; i < SPOTS; i++) { xy[i * 2] = x[i]; xy[i * 2 + 1] = y[i]; }
await numeric(path.join(base, 'obsm', 'spatial'), [SPOTS, 2], 'float32', xy);
await numeric(path.join(base, 'obsm', 'X_umap'), [SPOTS, 2], 'float32', umap);
await numeric(path.join(base, 'obsm', 'X_umap3d'), [SPOTS, 3], 'float32', umap3d);

console.log(`[make-zarr-demo] ${OUT}`);
console.log(`  ${SPOTS} spots x ${GENES} genes, ${data.length} nonzeros`);
console.log(`  obsm: spatial, X_umap (2D), X_umap3d (3D)`);
console.log(`  serve with:  ZARR_DIR=${path.dirname(OUT)} npm start`);
