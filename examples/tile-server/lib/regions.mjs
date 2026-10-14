// Region sources: large GeoJSON region sets served as level-of-detail tiles, the wire the
// library's HTTP region source reads (src/lib/region-source/http-region-source.ts). The browser
// never downloads a whole set: it asks for the tiles in view at the zoom's level of detail, and
// for a feature's exact geometry when someone selects it.
//
// A set under $REGION_DIR is either
//   <id>.geojson   one FeatureCollection; a z-stack's slices by QuPath's `geometry.plane.z`, or
//   <id>/          a folder of *.geojson files, one per slice (plane z = the z-th file by name).
//
// Tiling is the library's own pure core (region-tiles.ts), bundled with esbuild on first use,
// so the server and the in-browser worker cut tiles the same way.

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TILER_SRC = fileURLToPath(new URL('../../../src/lib/region-source/region-tiles.ts', import.meta.url));

/** Parsed per-slice files kept in memory, past which the least recently used are dropped. */
const OPEN_TABLES = 8;

let tilerPromise = null;

/** The library's tiler (`RegionFeatureTable`, …), compiled from its TypeScript source. */
export function loadTiler() {
  tilerPromise ??= (async () => {
    const { build } = await import('esbuild');
    const out = await build({
      entryPoints: [TILER_SRC],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      logLevel: 'silent',
    });
    const code = Buffer.from(out.outputFiles[0].text, 'utf8').toString('base64');
    return import(`data:text/javascript;base64,${code}`);
  })();
  return tilerPromise;
}

/** A set id: one path segment of word characters, dots and dashes, not starting with a dot. */
export function validRegionId(id) {
  return typeof id === 'string' && /^[\w-][\w.-]*$/.test(id);
}

/** Every region set under `dir`: `{ id, kind: 'file' | 'folder' }`. */
export async function listRegionSets(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sets = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.geojson')) sets.push({ id: e.name.slice(0, -8), kind: 'file' });
    else if (e.isDirectory() && !e.name.startsWith('.')) sets.push({ id: e.name, kind: 'folder' });
  }
  return sets.filter((s) => validRegionId(s.id)).sort((a, b) => a.id.localeCompare(b.id));
}

const sets = new Map();

/** The region set `id` under `dir`, or null when there is none. */
export async function openRegionSet(dir, id) {
  if (!validRegionId(id)) return null;
  const key = `${dir}\0${id}`;
  const cached = sets.get(key);
  if (cached) return cached;
  const file = path.join(dir, `${id}.geojson`);
  const folder = path.join(dir, id);
  let set = null;
  if (await isFile(file)) set = new FileRegionSet(file);
  else if (await isDir(folder)) {
    const files = (await readdir(folder)).filter((f) => f.endsWith('.geojson')).sort();
    set = new FolderRegionSet(files.map((f) => path.join(folder, f)));
  }
  if (set) sets.set(key, set);
  return set;
}

async function isFile(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readTable(file) {
  const { RegionFeatureTable } = await loadTiler();
  return RegionFeatureTable.fromGeoJson(await readFile(file, 'utf8'));
}

/** A tile on the wire: rings as plain arrays. */
function wireTile(tile, idOf = (id) => id) {
  return {
    features: tile.features.map((f) => ({
      id: idOf(f.id),
      label: f.label,
      color: f.color,
      bbox: f.bbox,
      rings: f.rings.map((r) => Array.from(r, (v) => Math.round(v * 100) / 100)),
      open: f.open || undefined,
    })),
  };
}

/** One GeoJSON file: its features' own planes are the slices. */
class FileRegionSet {
  constructor(file) {
    this.file = file;
    this.tablePromise = null;
  }

  table() {
    this.tablePromise ??= readTable(this.file).catch((err) => {
      this.tablePromise = null;
      throw err;
    });
    return this.tablePromise;
  }

  async info() {
    return (await this.table()).info();
  }

  async tile(z, level, gx, gy) {
    return wireTile((await this.table()).tile(z, level, gx, gy));
  }

  async features(ids) {
    return (await this.table()).features(ids);
  }

  async index(z, query) {
    return (await this.table()).index(z, query);
  }

  async export(exclude, extra) {
    return (await this.table()).exportGeoJson(exclude, extra);
  }
}

/**
 * A folder of per-slice files. Feature ids repeat across slices (an atlas structure is on many
 * sections), so the set qualifies them with the slice: `<z>:<id>`.
 */
class FolderRegionSet {
  constructor(files) {
    this.files = files;
    this.tables = new Map();
    this.infoPromise = null;
  }

  /** Slice z's table (and the plane its features are on), parsed on first use. */
  table(z) {
    const file = this.files[z];
    if (!file) return Promise.resolve(null);
    let entry = this.tables.get(z);
    if (entry) {
      this.tables.delete(z);
      this.tables.set(z, entry);
      return entry;
    }
    entry = readTable(file).then((table) => ({ table, plane: table.info().planes[0] ?? 0 }));
    entry.catch(() => this.tables.delete(z));
    this.tables.set(z, entry);
    while (this.tables.size > OPEN_TABLES) this.tables.delete(this.tables.keys().next().value);
    return entry;
  }

  /** Over every slice: read once, one file at a time. */
  info() {
    this.infoPromise ??= (async () => {
      const { REGION_TILE_SIZE } = await loadTiler();
      let featureCount = 0;
      let bounds = null;
      const classColors = {};
      for (let z = 0; z < this.files.length; z++) {
        const info = (await readTable(this.files[z])).info();
        featureCount += info.featureCount;
        for (const [label, color] of Object.entries(info.classColors)) classColors[label] ??= color;
        const b = info.bounds;
        if (b) {
          bounds = bounds
            ? [
              Math.min(bounds[0], b[0]),
              Math.min(bounds[1], b[1]),
              Math.max(bounds[2], b[2]),
              Math.max(bounds[3], b[3]),
            ]
            : b;
        }
      }
      const extent = bounds ? Math.max(...bounds.map(Math.abs)) : 0;
      const levels = 1 + Math.max(0, Math.ceil(Math.log2(Math.max(extent, REGION_TILE_SIZE) / REGION_TILE_SIZE)));
      const planes = this.files.map((_, z) => z);
      return { featureCount, bounds, tileSize: REGION_TILE_SIZE, levels, planes, classColors };
    })().catch((err) => {
      this.infoPromise = null;
      throw err;
    });
    return this.infoPromise;
  }

  async tile(z, level, gx, gy) {
    const entry = await this.table(z);
    if (!entry) return { features: [] };
    return wireTile(entry.table.tile(entry.plane, level, gx, gy), (id) => `${z}:${id}`);
  }

  async features(ids) {
    const byZ = new Map();
    for (const qualified of ids) {
      const [z, id] = splitId(qualified);
      if (z === null) continue;
      if (!byZ.has(z)) byZ.set(z, []);
      byZ.get(z).push(id);
    }
    const out = [];
    for (const [z, raw] of byZ) {
      const entry = await this.table(z);
      if (!entry) continue;
      for (const f of entry.table.features(raw)) out.push({ id: `${z}:${f.id}`, feature: f.feature });
    }
    // In the order asked.
    const at = new Map(ids.map((id, i) => [id, i]));
    return out.sort((a, b) => at.get(a.id) - at.get(b.id));
  }

  async index(z, query) {
    const entry = await this.table(z);
    if (!entry) return { total: 0, rows: [] };
    const exclude = (query.exclude ?? []).map(splitId).filter(([qz]) => qz === z).map(([, id]) => id);
    const page = entry.table.index(entry.plane, { ...query, exclude });
    return { total: page.total, rows: page.rows.map((r) => ({ ...r, id: `${z}:${r.id}` })) };
  }

  /** Every slice's features (on plane z, ids qualified) through the working set, then `extra`. */
  async export(exclude, extra) {
    const skip = new Set(exclude);
    const parts = [];
    for (let z = 0; z < this.files.length; z++) {
      const { table } = await this.table(z);
      table.raw.forEach((feature, i) => {
        const id = `${z}:${table.ids[i]}`;
        if (skip.has(id)) return;
        const plane = z ? { plane: { c: -1, z, t: 0 } } : {};
        const geometry = feature.geometry ? { ...feature.geometry, ...plane } : feature.geometry;
        parts.push(JSON.stringify({ ...feature, type: 'Feature', id, geometry }));
      });
    }
    for (const f of extra) parts.push(JSON.stringify(f));
    return `{"type":"FeatureCollection","features":[${parts.join(',')}]}`;
  }
}

/** `<z>:<id>` → [z, id]; [null, id] for an id without a slice. */
function splitId(qualified) {
  const m = /^(\d+):(.*)$/s.exec(String(qualified));
  return m ? [Number(m[1]), m[2]] : [null, qualified];
}
