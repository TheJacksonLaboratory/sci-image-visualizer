/**
 * Allen Brain Cell Atlas whole-mouse-brain MERFISH — the example's only
 * genuinely 3D spatial-omics source.
 *
 * Every other source here serves a single plane. This one serves ~4M cells from
 * 59 coronal sections, each affinely registered into the Allen CCFv3, so a cell
 * has a real (x, y, z) in a common anatomical frame. That is the difference that
 * matters: the HER2 sections in st/ are also a series through a block, but they
 * were never registered to each other, so they cannot be stacked. Here they can.
 *
 * Input is two plain CSVs from a public AWS Open Data bucket — see
 * scripts/fetch-abc.mjs. CSV is a terrible serving format (row-major, 1.5GB, no
 * random access), so the first request transcodes it once into a compact binary
 * cache under `.cache/` and every later request mmap-reads slices out of that.
 * The transcode is the expensive step; it runs once per download.
 *
 * Dataset ids:
 *   abc.wholebrain        all cells, 3D
 *   abc.wholebrain.sub10  deterministic 1-in-10 stride of the same cloud
 *
 * The subsample exists because 4M billboards is a lot to ask of a demo on
 * integrated graphics; it is the same cloud at the same extent, just thinner.
 */
import { createReadStream } from 'node:fs';
import { readNifti } from './nifti.mjs';
import { readFile, writeFile, mkdir, rename, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const CACHE_VERSION = 1;

const CELLS_CSV = 'cell_metadata_with_parcellation_annotation.csv';
const GENES_CSV = 'example_genes_all_cells_expression.csv';

/**
 * Categorical columns we surface, and the column carrying Allen's own colour for
 * each. Using the deposited colours rather than our default palette means the
 * render matches every figure in the Yao et al. atlas papers.
 *
 * The list stops at columns with at most ~96 distinct values, and that ceiling
 * is not arbitrary: the 3D points layer colours points by mapping a per-point
 * SCALAR through a 256-entry LUT (it has no per-point RGBA), so a categorical
 * palette has to be encoded as one contiguous block of LUT entries per category.
 * Measured against napari-js, every K from 2..96 round-trips its colours exactly
 * and K=97 is the first that does not — 256 texels cannot keep more categories
 * apart than that. So `subclass` (338), `parcellation_structure` (~300),
 * `supertype` (1,201) and `cluster` (5,322) are deliberately absent: serving them
 * would render colours that are subtly wrong while the legend claimed otherwise,
 * which is worse than not offering them. Class and division tell the same story
 * at a cardinality that both the LUT and a human legend can hold.
 */
const CATEGORICAL = [
  { name: 'class', color: 'class_color', description: 'Cell class — the top level of the whole-brain taxonomy' },
  { name: 'neurotransmitter', color: 'neurotransmitter_color', description: 'Neurotransmitter identity, blank where not assigned' },
  { name: 'parcellation_division', color: 'parcellation_division_color', description: 'CCF anatomical division' },
  { name: 'brain_section_label', color: null, description: 'Source coronal section — 59 of them, ordered anterior to posterior' },
];

/** Continuous columns worth colouring by. */
const CONTINUOUS = [
  {
    name: 'average_correlation_score',
    unit: 'correlation',
    logScaleHint: false,
    description: "Confidence of the cell's cluster assignment, as deposited",
  },
];

/**
 * Which deposited coordinate columns become our (x, y, z).
 *
 * The RECONSTRUCTED coordinates, not the CCF ones, and that choice is load-bearing:
 * the reference volumes we render underneath are on the reconstructed section grid
 * (their z pixdim is 0.2mm, exactly the section spacing), and voxel index is then
 * simply `coord / pixdim` along each axis with no offset or flip.
 *
 * That is measured, not assumed. Every cell carries its own `parcellation_index`,
 * and `resampled_annotation.nii.gz` holds the same labels per voxel, so a candidate
 * alignment can be scored against the data: this one agrees with the cells' own
 * labels for 9,000 out of 9,000 sampled cells. Searching the CCF coordinates over
 * every axis permutation and flip peaks at 1.4%.
 *
 * The cost is that z is quantised to the 76 section planes rather than varying
 * continuously as `z_ccf` does. That is the honest sampling — the cells really do
 * come from serial sections — and exact registration to the anatomy is worth more
 * than a continuous z synthesised by registering tilted sections.
 *
 * Axis order puts mediolateral on x and dorsoventral on y, so the default camera
 * looks down the anterior-posterior axis at a coronal section: the orientation
 * every mouse-brain figure uses.
 */
const AXES = { x: 'x_reconstructed', y: 'y_reconstructed', z: 'z_reconstructed' };

/**
 * The anatomical backdrop: the CCF average template resampled onto the same grid.
 *
 * Downsampled 4x in the two 10um axes on the way into the cache. The source is
 * 1100x1100x76 float32 = 351MB, which is neither a sane response nor a sane 3D
 * texture; at 40um it is 275x275x76 uint8 = 5.7MB and still far finer than the
 * 200um section spacing, which is the real limit on what the data can resolve.
 */
const VOLUME_FILE = 'resampled_average_template.nii.gz';
const VOLUME_XY_DOWNSAMPLE = 4;

/** Deposited coordinates are millimetres; the rest of the library thinks in microns. */
const MM_TO_UM = 1000;

const caches = new Map();

export function clearAbcCaches() {
  caches.clear();
}

/* ------------------------------------------------------------------ CSV ---- */

/**
 * Pull just the wanted columns out of one CSV line, in a single pass.
 *
 * A `line.split(',')` would allocate 38 strings per row and we want 12 of them;
 * over 4M rows that is most of the build time. This walks the line once and
 * slices only the fields asked for, indexing `slotForField` (built once from the
 * header) so neither the field loop nor the emit does any searching. Quotes are
 * honoured because Allen's structure names do contain commas ("Field CA1,
 * pyramidal layer").
 */
function pickFields(line, slotForField, out) {
  out.fill('');
  let field = 0;
  let start = 0;
  let quoted = false;
  let sawQuote = false;
  const last = slotForField.length - 1;

  const emit = (end) => {
    const slot = field <= last ? slotForField[field] : -1;
    if (slot >= 0) {
      let v = line.slice(start, end);
      if (sawQuote) v = v.replace(/^"|"$/g, '').replace(/""/g, '"');
      out[slot] = v;
    }
  };

  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 34 /* " */) {
      quoted = !quoted;
      sawQuote = true;
    } else if (c === 44 /* , */ && !quoted) {
      emit(i);
      field++;
      start = i + 1;
      sawQuote = false;
    }
  }
  emit(line.length);
  return out;
}

/** Split a header line fully — done once, so clarity beats speed. */
function splitHeader(line) {
  const cells = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 34) quoted = !quoted;
    else if (c === 44 && !quoted) {
      cells.push(line.slice(start, i).replace(/^"|"$/g, ''));
      start = i + 1;
    }
  }
  cells.push(line.slice(start).replace(/^"|"$/g, ''));
  return cells;
}

/* ---------------------------------------------------------- growable buf --- */

/** Float32Array that doubles on demand — N is unknown until the CSV ends. */
class F32 {
  constructor(cap = 1 << 20) {
    this.a = new Float32Array(cap);
    this.n = 0;
  }
  push(v) {
    if (this.n === this.a.length) {
      const bigger = new Float32Array(this.a.length * 2);
      bigger.set(this.a);
      this.a = bigger;
    }
    this.a[this.n++] = v;
  }
  view() {
    return this.a.subarray(0, this.n);
  }
}

class U16 {
  constructor(cap = 1 << 20) {
    this.a = new Uint16Array(cap);
    this.n = 0;
  }
  push(v) {
    if (this.n === this.a.length) {
      const bigger = new Uint16Array(this.a.length * 2);
      bigger.set(this.a);
      this.a = bigger;
    }
    this.a[this.n++] = v;
  }
  view() {
    return this.a.subarray(0, this.n);
  }
}

/** Interns category strings to Uint16 codes, remembering first-seen colour. */
class Categorizer {
  constructor() {
    this.codes = new Map();
    this.categories = [];
    this.colors = [];
  }
  code(value, color) {
    // Blank means "not assigned" upstream (e.g. non-neuronal neurotransmitter).
    // NO_CATEGORY in the contract is 0xffff, which the renderer draws as muted
    // rather than inventing a category for it.
    if (value === '') return 0xffff;
    let c = this.codes.get(value);
    if (c === undefined) {
      c = this.categories.length;
      if (c >= 0xffff) throw new RangeError('too many categories for a Uint16 code');
      this.codes.set(value, c);
      this.categories.push(value);
      this.colors.push(color || '');
    }
    return c;
  }
}

/* --------------------------------------------------------------- build ----- */

async function buildCache(abcDir, log = () => {}) {
  const cacheDir = path.join(abcDir, '.cache');
  const cellsPath = path.join(abcDir, CELLS_CSV);
  await mkdir(cacheDir, { recursive: true });

  const stream = createReadStream(cellsPath, { highWaterMark: 1 << 22 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let header = null;
  let slotForField = null;
  let slotOf = null;
  let out = null;
  const xs = new F32();
  const ys = new F32();
  const zs = new F32();
  const cats = CATEGORICAL.map(() => new Categorizer());
  const catCodes = CATEGORICAL.map(() => new U16());
  const conts = CONTINUOUS.map(() => new F32());
  let n = 0;
  let dropped = 0;

  for await (const line of rl) {
    if (header === null) {
      header = splitHeader(line);
      const need = [AXES.x, AXES.y, AXES.z];
      for (const c of CATEGORICAL) {
        need.push(c.name);
        if (c.color) need.push(c.color);
      }
      for (const c of CONTINUOUS) need.push(c.name);

      // name -> position in `out`, and CSV field -> that same position. Both are
      // built once so the per-row path is pure indexing.
      slotOf = new Map();
      slotForField = new Int16Array(header.length).fill(-1);
      for (const name of need) {
        const at = header.indexOf(name);
        if (at < 0) throw new Error(`${CELLS_CSV} has no column "${name}" — wrong file or release?`);
        if (!slotOf.has(name)) slotOf.set(name, slotOf.size);
        slotForField[at] = slotOf.get(name);
      }
      out = new Array(slotOf.size).fill('');
      continue;
    }
    if (!line) continue;

    pickFields(line, slotForField, out);
    const slot = (name) => out[slotOf.get(name)];

    const x = +slot(AXES.x);
    const y = +slot(AXES.y);
    const z = +slot(AXES.z);
    // A cell with no reconstructed position cannot be placed in the volume. Dropping
    // it is the honest choice: putting it at the origin would draw a spurious
    // blob of thousands of cells at one corner of the brain.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      dropped++;
      continue;
    }
    xs.push(x * MM_TO_UM);
    ys.push(y * MM_TO_UM);
    zs.push(z * MM_TO_UM);

    for (let i = 0; i < CATEGORICAL.length; i++) {
      const spec = CATEGORICAL[i];
      catCodes[i].push(cats[i].code(slot(spec.name), spec.color ? slot(spec.color) : ''));
    }
    for (let i = 0; i < CONTINUOUS.length; i++) {
      const v = +slot(CONTINUOUS[i].name);
      conts[i].push(Number.isFinite(v) ? v : NaN);
    }

    if (++n % 500000 === 0) log(`  ${n.toLocaleString()} cells…`);
  }

  if (!n) throw new Error(`${CELLS_CSV} produced no rows`);
  log(`  ${n.toLocaleString()} cells (${dropped.toLocaleString()} without coordinates, dropped)`);

  // Planar layout — x block, then y, then z — matching decodeCoords() on the
  // client, which takes three contiguous Float32 views over one buffer.
  const coords = new Float32Array(n * 3);
  coords.set(xs.view(), 0);
  coords.set(ys.view(), n);
  coords.set(zs.view(), n * 2);

  const columns = [];
  const write = async (file, typed) => {
    const tmp = path.join(cacheDir, file + '.tmp');
    await writeFile(tmp, Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength));
    await rename(tmp, path.join(cacheDir, file));
  };

  await write('coords.f32', coords);
  for (let i = 0; i < CATEGORICAL.length; i++) {
    const spec = CATEGORICAL[i];
    await write(`col.${spec.name}.u16`, catCodes[i].view());
    columns.push({
      kind: 'categorical',
      name: spec.name,
      categories: cats[i].categories,
      colors: cats[i].colors.some(Boolean) ? cats[i].colors : undefined,
      description: spec.description,
    });
  }
  for (let i = 0; i < CONTINUOUS.length; i++) {
    const spec = CONTINUOUS[i];
    await write(`col.${spec.name}.f32`, conts[i].view());
    columns.push({
      kind: 'continuous',
      name: spec.name,
      unit: spec.unit,
      logScaleHint: spec.logScaleHint,
      description: spec.description,
    });
  }

  const genes = await buildGenes(abcDir, cacheDir, n, write, log);
  const volume = await buildVolume(abcDir, write, log);

  const index = { version: CACHE_VERSION, count: n, columns, genes, volume };
  await writeFile(path.join(cacheDir, 'index.json'), JSON.stringify(index));
  return index;
}

/**
 * Transcode the 8-gene expression CSV, if present.
 *
 * The full 500-gene panel ships only as h5ad and we have no HDF5 reader, so
 * these eight marker genes are the whole of colour-by-gene here.
 *
 * They arrive in a SEPARATE file, keyed by `cell_label`, that neither matches the
 * cell table's row order nor its row set: 4,334,174 rows against 3,739,961 cells,
 * because expression covers every segmented cell while the CCF view keeps only
 * the ones that passed QC and registered. So this is a real hash join, not a
 * positional zip.
 *
 * Join on the label VERBATIM. Both sides carry a `-<n>` suffix on about a third
 * of their rows, and it is part of the identity, not noise: labels are unique
 * as-is on both sides, but stripping the suffix collapses 3,739,961 cells into
 * 2,648,427 keys — over a million cells losing their identity, and a join that
 * would then attach one cell's expression to another's coordinates.
 *
 * That costs a ~3.7M-entry Map for the duration of the build. It is the heaviest
 * thing this module does, and it is why the join happens once into a binary cache
 * rather than per request. Genes are skipped rather than guessed at if the file
 * is missing or unreadable — a plausible-looking but wrongly-joined gene map is
 * the worst possible outcome, since nothing on screen would look amiss.
 */
async function buildGenes(abcDir, cacheDir, n, write, log) {
  const genesPath = path.join(abcDir, GENES_CSV);
  try {
    await stat(genesPath);
  } catch {
    log('  no gene CSV; colour-by-gene disabled');
    return [];
  }

  // label -> row index in the cache we just wrote. Built by re-reading the cell
  // table so the main pass does not have to retain 3.7M label strings.
  const rowOf = new Map();
  {
    const stream = createReadStream(path.join(abcDir, CELLS_CSV), { highWaterMark: 1 << 22 });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let at = -1;
    let row = 0;
    for await (const line of rl) {
      if (at < 0) {
        at = splitHeader(line).indexOf('cell_label');
        if (at !== 0) throw new Error('cell_label is no longer the first column');
        continue;
      }
      if (!line) continue;
      // Field 0, so slice to the first comma rather than parsing the row.
      const comma = line.indexOf(',');
      const label = comma < 0 ? line : line.slice(0, comma);
      rowOf.set(label, row++);
    }
    if (row !== n) {
      // The main pass dropped rows (no CCF coords); indices would be shifted.
      log(`  cell table re-read gave ${row.toLocaleString()} rows against ${n.toLocaleString()} cached; skipping genes`);
      return [];
    }
  }

  const stream = createReadStream(genesPath, { highWaterMark: 1 << 22 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let names = null;
  let slotForField = null;
  let out = null;
  let cols = null;
  let matched = 0;
  let missed = 0;
  for await (const line of rl) {
    if (names === null) {
      const head = splitHeader(line);
      if (head[0] !== 'cell_label') throw new Error(`${GENES_CSV} does not start with cell_label`);
      names = head.slice(1);
      // Field 0 is the join key; genes follow, one slot each.
      slotForField = new Int16Array(head.length).fill(-1);
      for (let i = 0; i < names.length; i++) slotForField[i + 1] = i;
      out = new Array(names.length).fill('');
      // NaN, not 0: a cell with no expression row has UNKNOWN expression, and 0
      // would read as "measured, not detected" on the colour bar.
      cols = names.map(() => new Float32Array(n).fill(NaN));
      continue;
    }
    if (!line) continue;
    const comma = line.indexOf(',');
    const row = rowOf.get(comma < 0 ? line : line.slice(0, comma));
    if (row === undefined) {
      missed++;
      continue;
    }
    pickFields(line, slotForField, out);
    for (let i = 0; i < cols.length; i++) {
      const v = +out[i];
      cols[i][row] = Number.isFinite(v) ? v : NaN;
    }
    matched++;
  }

  // matched counts DISTINCT cells filled, so this cannot exceed 1 unless the
  // join key stops being unique — in which case the number says so loudly.
  const coverage = matched / n;
  if (coverage < 0.5) {
    log(`  gene CSV matched only ${(coverage * 100).toFixed(1)}% of cells; skipping genes`);
    return [];
  }
  for (let i = 0; i < names.length; i++) await write(`gene.${names[i]}.f32`, cols[i]);
  log(`  ${names.length} genes joined to ${(coverage * 100).toFixed(1)}% of cells `
    + `(${missed.toLocaleString()} expression rows had no registered cell): ${names.join(', ')}`);
  return names;
}

/**
 * Transcode the reference volume: float32 -> uint8, downsampled in x/y.
 *
 * Box-averages each 4x4 column rather than picking one voxel, so the result is a
 * proper reduction instead of a subsample that would alias the fine anatomy into
 * speckle. Values are windowed on the volume's own min/max: the template is an
 * average of many brains and its range is arbitrary, so there is no fixed scale
 * to preserve.
 *
 * Optional. Absent volume file -> no volume, and the cloud renders alone.
 */
async function buildVolume(abcDir, write, log) {
  const file = path.join(abcDir, VOLUME_FILE);
  try {
    await stat(file);
  } catch {
    log('  no reference volume; the 3D cloud renders without anatomy');
    return null;
  }

  const v = await readNifti(file);
  const [W, H, D] = v.dims;
  const step = VOLUME_XY_DOWNSAMPLE;
  const ow = Math.ceil(W / step);
  const oh = Math.ceil(H / step);
  const src = v.data;

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    if (x < min) min = x;
    if (x > max) max = x;
  }
  const span = max > min ? max - min : 1;

  const out = new Uint8Array(ow * oh * D);
  for (let k = 0; k < D; k++) {
    const plane = k * W * H;
    for (let oy = 0; oy < oh; oy++) {
      const y0 = oy * step;
      const y1 = Math.min(H, y0 + step);
      for (let ox = 0; ox < ow; ox++) {
        const x0 = ox * step;
        const x1 = Math.min(W, x0 + step);
        let sum = 0;
        let cells = 0;
        for (let y = y0; y < y1; y++) {
          const row = plane + y * W;
          for (let x = x0; x < x1; x++) {
            sum += src[row + x];
            cells++;
          }
        }
        const mean = cells ? sum / cells : 0;
        out[(k * oh + oy) * ow + ox] = Math.max(0, Math.min(255,
          Math.round(((mean - min) / span) * 255)));
      }
    }
  }
  await write('volume.u8', out);

  // World size of one output voxel, in microns — the axes keep their true
  // proportions only if this reflects the downsample.
  const voxelSize = [
    v.pixdim[0] * step * MM_TO_UM,
    v.pixdim[1] * step * MM_TO_UM,
    v.pixdim[2] * MM_TO_UM,
  ];
  log(`  volume ${ow}x${oh}x${D} uint8 (${(out.length / 1048576).toFixed(1)} MB), `
    + `voxel ${voxelSize.map((x) => x.toFixed(0)).join('x')} um`);
  return { width: ow, height: oh, depth: D, voxelSize };
}

/* --------------------------------------------------------------- serve ----- */

async function load(abcDir, log) {
  const key = path.resolve(abcDir);
  let entry = caches.get(key);
  if (entry) return entry;

  const cacheDir = path.join(key, '.cache');
  let index = null;
  try {
    const raw = JSON.parse(await readFile(path.join(cacheDir, 'index.json'), 'utf8'));
    if (raw.version === CACHE_VERSION) index = raw;
  } catch {
    // No cache yet, or an older layout; rebuild.
  }
  if (!index) {
    try {
      await stat(path.join(key, CELLS_CSV));
    } catch {
      throw new RangeError('no ABC atlas data');
    }
    (log || console.log)(`[abc] building binary cache from ${CELLS_CSV} (one time)…`);
    const t0 = Date.now();
    index = await buildCache(key, log || console.log);
    (log || console.log)(`[abc] cache built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  entry = { index, dir: cacheDir, blobs: new Map() };
  caches.set(key, entry);
  return entry;
}

async function blob(entry, file) {
  let b = entry.blobs.get(file);
  if (!b) {
    b = await readFile(path.join(entry.dir, file));
    entry.blobs.set(file, b);
  }
  return b;
}

/** Datasets are the full cloud plus a strided view of it. */
const VARIANTS = [
  { suffix: '', stride: 1, name: 'Whole mouse brain MERFISH · 3D (CCFv3)' },
  { suffix: '.sub10', stride: 10, name: 'Whole mouse brain MERFISH · 3D · 1-in-10' },
];

function variantOf(id) {
  if (!id.startsWith('abc.wholebrain')) return null;
  const suffix = id.slice('abc.wholebrain'.length);
  return VARIANTS.find((v) => v.suffix === suffix) || null;
}

/** N after striding. */
const strided = (count, stride) => Math.ceil(count / stride);

export async function listAbcDatasets(abcDir) {
  let entry;
  try {
    entry = await load(abcDir);
  } catch {
    return [];
  }
  return VARIANTS.map((v) => ({
    id: 'abc.wholebrain' + v.suffix,
    name: v.name,
    count: strided(entry.index.count, v.stride),
    source: 'abc',
    prettyName: 'Allen Brain Cell Atlas',
  }));
}

export async function abcManifest(abcDir, id) {
  const v = variantOf(id);
  if (!v) throw new RangeError(`unknown dataset: ${id}`);
  const entry = await load(abcDir);
  const count = strided(entry.index.count, v.stride);
  return {
    version: 1,
    id,
    name: v.name,
    count,
    hasZ: true,
    hasIds: false,
    // MERFISH somata run ~10um across. There is no reference image, so this is
    // microns of tissue, same units as the coordinates.
    radius: { mode: 'uniform', value: 5 },
    columns: entry.index.columns,
    // The anatomical volume the observations sit inside. Same grid for every
    // variant — striding thins the cloud, not the anatomy.
    volume: entry.index.volume ?? undefined,
    features: entry.index.genes.length
      ? { count: entry.index.genes.length, unit: 'log2(CPM+1)', logScaleHint: false }
      : undefined,
  };
}

export async function abcCoords(abcDir, id) {
  const v = variantOf(id);
  if (!v) throw new RangeError(`unknown dataset: ${id}`);
  const entry = await load(abcDir);
  const b = await blob(entry, 'coords.f32');
  const total = entry.index.count;
  const full = new Float32Array(b.buffer, b.byteOffset, total * 3);
  if (v.stride === 1) return Buffer.from(full.buffer, full.byteOffset, full.byteLength);

  const n = strided(total, v.stride);
  const out = new Float32Array(n * 3);
  for (let axis = 0; axis < 3; axis++) {
    const src = axis * total;
    const dst = axis * n;
    for (let i = 0, j = 0; i < total; i += v.stride, j++) out[dst + j] = full[src + i];
  }
  return Buffer.from(out.buffer);
}

async function vector(abcDir, id, file, Type) {
  const v = variantOf(id);
  if (!v) throw new RangeError(`unknown dataset: ${id}`);
  const entry = await load(abcDir);
  const b = await blob(entry, file);
  const full = new Type(b.buffer, b.byteOffset, entry.index.count);
  if (v.stride === 1) return Buffer.from(full.buffer, full.byteOffset, full.byteLength);
  const n = strided(entry.index.count, v.stride);
  const out = new Type(n);
  for (let i = 0, j = 0; i < entry.index.count; i += v.stride, j++) out[j] = full[i];
  return Buffer.from(out.buffer);
}

export async function abcColumn(abcDir, id, name) {
  const entry = await load(abcDir);
  const meta = entry.index.columns.find((c) => c.name === name);
  if (!meta) throw new RangeError(`unknown column: ${name}`);
  return meta.kind === 'categorical'
    ? vector(abcDir, id, `col.${name}.u16`, Uint16Array)
    : vector(abcDir, id, `col.${name}.f32`, Float32Array);
}

export async function abcFeature(abcDir, id, name) {
  const entry = await load(abcDir);
  if (!entry.index.genes.includes(name)) throw new RangeError(`unknown gene: ${name}`);
  return vector(abcDir, id, `gene.${name}.f32`, Float32Array);
}

export async function abcVolume(abcDir, id) {
  const v = variantOf(id);
  if (!v) throw new RangeError(`unknown dataset: ${id}`);
  const entry = await load(abcDir);
  if (!entry.index.volume) throw new RangeError('no volume for this dataset');
  return blob(entry, 'volume.u8');
}

export async function abcFeatureSearch(abcDir, id, query, limit = 50) {
  const entry = await load(abcDir);
  const q = String(query || '').toLowerCase();
  return entry.index.genes.filter((g) => g.toLowerCase().includes(q)).slice(0, limit);
}
