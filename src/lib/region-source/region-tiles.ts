/**
 * The pure core of a tiled region source: a large GeoJSON region set cut into tiles per level
 * of detail, the outlines simplified per level, so a view only ever holds and draws what is on
 * screen at the detail the zoom can show.
 *
 * Levels: level 0 is exact; a level-k tile covers `tileSize · 2ᵏ` image pixels and its outlines
 * are simplified (Douglas–Peucker) to `2ᵏ⁻¹` image pixels — half to one screen pixel at the zooms
 * that pick that level ({@link regionLevelFor}). A feature under `2ᵏ` image pixels (one to two
 * screen pixels there) is left out of the level. A tile holds the WHOLE simplified feature (not
 * clipped) for every feature whose box meets it, so a view de-duplicates features by id, and at
 * level 0 the tiles in view hold the exact outline of everything visible.
 *
 * No DOM, no Angular: the same code runs in the region-source worker and, where workers do not
 * exist, on the main thread.
 */
import { rgbToHex } from '../contracts/color';
import { simplifyRing } from '../geometry/ring';
import { polylabel } from '../geometry/polylabel';

/** An axis-aligned box `[x0, y0, x1, y1]` in image pixels. */
export type Bbox = [number, number, number, number];

/** Edge of a level-0 tile, in image pixels. */
export const REGION_TILE_SIZE = 512;

/**
 * One class of a class hierarchy (e.g. a brain-atlas ontology): the class name the features use,
 * its long name, its parent class and its colour. A region set may carry one (a GeoJSON
 * FeatureCollection's `classHierarchy` member); the Region Editor then lists the set as a tree.
 */
export interface RegionClassNode {
  /** The class name, as features use it (`classification.name`): an atlas acronym, say. */
  name: string;
  /** The long name, e.g. "Somatomotor areas, Layer 5". */
  title?: string;
  /** The parent class's name; absent for a root. */
  parent?: string | null;
  /** `#rrggbb`. */
  color?: string;
  /** Position among its siblings (an atlas's graph order); file order without one. */
  order?: number;
}

/**
 * How a region set wants to be drawn, a hint the viewer applies when the set opens (a GeoJSON
 * FeatureCollection's `style` member): an atlas fills its structures and labels them.
 */
export interface RegionSourceStyle {
  /** Fill regions in their colour at this opacity (0 = outlines only). */
  fillOpacity?: number;
  /** Outline colour when filled (default: the region's colour). */
  stroke?: string;
  /** Outline width in screen px. */
  strokeWidth?: number;
  /** Show class labels inside the regions. */
  labels?: boolean;
  /** Fill colour of selected regions. */
  highlight?: string;
}

/** What a region source holds, known once it is open. */
export interface RegionSourceInfo {
  /** Features in the source, over every plane. */
  featureCount: number;
  /** The box around every feature's geometry; null when none has any. */
  bounds: Bbox | null;
  /** Edge of a level-0 tile, in image pixels. */
  tileSize: number;
  /** Number of levels; the last one's tiles cover {@link bounds} in a few tiles. */
  levels: number;
  /** The z planes features are on (QuPath's `geometry.plane.z`, 0 without one), ascending. */
  planes: number[];
  /** The colour the file gives each class (its first feature's), by class name. */
  classColors: Record<string, string>;
  /** The set's class hierarchy, when it has one. */
  hierarchy?: RegionClassNode[];
  /** How the set wants to be drawn, when it says. */
  style?: RegionSourceStyle;
}

/** One feature as a tile carries it: identity, class and outline at the tile's level. */
export interface TileFeature {
  id: string;
  /** The class name. */
  label: string | null;
  /** The feature's own colour (`#rrggbb`), from its classification. */
  color: string | null;
  /** The box around the exact geometry. */
  bbox: Bbox;
  /** Rings as interleaved `x, y` (no repeated closing vertex): exteriors and holes of every
   *  part, drawn and hit-tested even-odd. For an open feature, its polylines. */
  rings: Float32Array[];
  /** A polyline (LineString) rather than an area. */
  open: boolean;
  /**
   * Where to label the feature, per part big enough: `x, y, room` triples, `room` the distance
   * from the point to the part's nearest edge (image px), so a label shows once it fits.
   */
  labels?: Float32Array;
}

/** One tile of one level of one plane. */
export interface RegionTile {
  z: number;
  level: number;
  gx: number;
  gy: number;
  features: TileFeature[];
}

/** A tile's address. */
export interface RegionTileKey {
  level: number;
  gx: number;
  gy: number;
}

/** One row of a source's feature index (the Region Editor's table). */
export interface RegionIndexRow {
  id: string;
  label: string | null;
  color: string | null;
  bbox: Bbox;
}

/** A page of a plane's feature index. */
export interface RegionIndexPage {
  /** Rows matching the query, over the whole plane. */
  total: number;
  rows: RegionIndexRow[];
}

/** Which rows a page of the index holds. */
export interface RegionIndexQuery {
  offset: number;
  limit: number;
  /** Only rows whose class name contains this (case-insensitive). */
  label?: string;
  /** Leave these ids out (taken into the working set, or deleted). */
  exclude?: readonly string[];
  /** Only rows of exactly these classes. */
  classes?: readonly string[];
}

/** The parts of a GeoJSON feature the tiler reads. Parsed from a file: nothing is guaranteed. */
export interface GeoJsonFeatureLike {
  type?: string;
  id?: string | number;
  geometry?: { type?: string; coordinates?: unknown; plane?: { z?: number } } | null;
  properties?: { id?: string | number; classification?: unknown } & Record<string, unknown>;
}

/**
 * The level whose tiles suit a zoom of `pxPerImagePx` screen pixels per image pixel: exact (0)
 * at 1:1 and closer, else level k for zooms in [2⁻ᵏ, 2¹⁻ᵏ), where its tolerance is half to one
 * screen pixel and the features it leaves out are under one or two.
 */
export function regionLevelFor(pxPerImagePx: number, levels: number): number {
  if (!(pxPerImagePx > 0) || levels <= 1) return 0;
  const level = Math.ceil(-Math.log2(pxPerImagePx) - 1e-9);
  return Math.max(0, Math.min(levels - 1, level));
}

/** Simplification tolerance of a level, in image pixels (0 = exact). */
export function levelTolerance(level: number): number {
  return level <= 0 ? 0 : 2 ** (level - 1);
}

/** Features smaller than this (their box's longer side, image pixels) are left out of a level. */
export function levelMinExtent(level: number): number {
  return level <= 0 ? 0 : 2 ** level;
}

/** Tile edge of a level, in image pixels. */
export function levelTileSize(level: number, tileSize = REGION_TILE_SIZE): number {
  return tileSize * 2 ** level;
}

/**
 * Tiles of `level` that meet `rect`, clipped to `bounds` (none past the data), ordered from the
 * rectangle's centre outward so the middle of the screen fills first. At most `limit`.
 */
export function regionTilesInRect(
  rect: Bbox,
  level: number,
  tileSize: number,
  bounds: Bbox | null,
  limit = Infinity,
): RegionTileKey[] {
  if (!bounds) return [];
  const x0 = Math.max(rect[0], bounds[0]);
  const y0 = Math.max(rect[1], bounds[1]);
  const x1 = Math.min(rect[2], bounds[2]);
  const y1 = Math.min(rect[3], bounds[3]);
  if (x1 < x0 || y1 < y0) return [];
  const size = levelTileSize(level, tileSize);
  const gx0 = Math.floor(x0 / size);
  const gy0 = Math.floor(y0 / size);
  const gx1 = Math.floor(x1 / size);
  const gy1 = Math.floor(y1 / size);
  const cx = (rect[0] + rect[2]) / 2 / size;
  const cy = (rect[1] + rect[3]) / 2 / size;
  const out: RegionTileKey[] = [];
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) out.push({ level, gx, gy });
  }
  const d = (k: RegionTileKey) => (k.gx + 0.5 - cx) ** 2 + (k.gy + 0.5 - cy) ** 2;
  out.sort((a, b) => d(a) - d(b));
  return out.length > limit ? out.slice(0, limit) : out;
}

/** `level/gx/gy`, a tile's id within one plane. */
export function regionTileId(k: RegionTileKey): string {
  return `${k.level}/${k.gx}/${k.gy}`;
}

/** The tile of `level` holding image point (x, y). */
export function tileAt(x: number, y: number, level: number, tileSize = REGION_TILE_SIZE): RegionTileKey {
  const size = levelTileSize(level, tileSize);
  return { level, gx: Math.floor(x / size), gy: Math.floor(y / size) };
}

/** True when two boxes meet (edges included). */
export function bboxesMeet(a: Readonly<Bbox>, b: Readonly<Bbox>): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

// ── Picking ──────────────────────────────────────────────────────────────────────────────

/**
 * The feature under image point (x, y): inside an area (even-odd over its rings, so holes are
 * outside) or within `tolerance` image pixels of a polyline. Of several, the one with the
 * smallest box — the innermost of nested outlines. Null when none is.
 */
export function featureAt(
  features: Iterable<TileFeature>,
  x: number,
  y: number,
  tolerance = 0,
): TileFeature | null {
  let best: TileFeature | null = null;
  let bestArea = Infinity;
  for (const f of features) {
    const b = f.bbox;
    if (x < b[0] - tolerance || x > b[2] + tolerance || y < b[1] - tolerance || y > b[3] + tolerance) continue;
    const hit = f.open ? nearPolylines(f.rings, x, y, tolerance) : insideRings(f.rings, x, y);
    if (!hit) continue;
    const area = (b[2] - b[0]) * (b[3] - b[1]);
    if (area < bestArea) {
      best = f;
      bestArea = area;
    }
  }
  return best;
}

/** Features whose box meets `rect` (the rubber band's rule for regions). */
export function featuresInRect(features: Iterable<TileFeature>, rect: Readonly<Bbox>): TileFeature[] {
  const out: TileFeature[] = [];
  for (const f of features) if (bboxesMeet(f.bbox, rect)) out.push(f);
  return out;
}

/** Even-odd containment over interleaved rings. */
export function insideRings(rings: readonly ArrayLike<number>[], x: number, y: number): boolean {
  let inside = false;
  for (const r of rings) {
    const n = r.length >> 1;
    if (n < 3) continue;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i],
        yi = r[2 * i + 1],
        xj = r[2 * j],
        yj = r[2 * j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function nearPolylines(lines: readonly ArrayLike<number>[], x: number, y: number, tolerance: number): boolean {
  for (const l of lines) {
    for (let i = 2; i + 1 < l.length; i += 2) {
      if (segmentDistance(x, y, l[i - 2], l[i - 1], l[i], l[i + 1]) <= tolerance) return true;
    }
  }
  return false;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax,
    dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ── Simplification ───────────────────────────────────────────────────────────────────────

/** Douglas–Peucker over an open polyline (both ends kept). */
export function simplifyPolyline(xs: number[], ys: number[], epsilon: number): { xs: number[]; ys: number[] } {
  const n = xs.length;
  if (n <= 2 || !(epsilon > 0)) return { xs: xs.slice(), ys: ys.slice() };
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    let maxD = -1,
      idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(xs[i], ys[i], xs[a], ys[a], xs[b], ys[b]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > epsilon) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const ox: number[] = [],
    oy: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) {
      ox.push(xs[i]);
      oy.push(ys[i]);
    }
  }
  return { xs: ox, ys: oy };
}

/**
 * Rings simplified for a level: every ring through Douglas–Peucker at the level's tolerance,
 * rings whose box is under the level's minimum extent dropped, and rings left with too few
 * vertices to draw (3 for a closed ring, 2 for a polyline) dropped. Level 0 returns the rings
 * as they are.
 */
export function simplifyRings(rings: readonly Float64Array[], open: boolean, level: number): Float32Array[] {
  const tol = levelTolerance(level);
  const minExtent = levelMinExtent(level);
  const minVertices = open ? 2 : 3;
  const out: Float32Array[] = [];
  for (const ring of rings) {
    const n = ring.length >> 1;
    if (n < minVertices) continue;
    if (tol === 0) {
      out.push(Float32Array.from(ring));
      continue;
    }
    const xs = new Array<number>(n),
      ys = new Array<number>(n);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = ring[2 * i],
        y = ring[2 * i + 1];
      xs[i] = x;
      ys[i] = y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (Math.max(x1 - x0, y1 - y0) < minExtent) continue;
    const s = open ? simplifyPolyline(xs, ys, tol) : simplifyRing(xs, ys, tol);
    if (s.xs.length < minVertices) continue;
    const flat = new Float32Array(s.xs.length * 2);
    for (let i = 0; i < s.xs.length; i++) {
      flat[2 * i] = s.xs[i];
      flat[2 * i + 1] = s.ys[i];
    }
    out.push(flat);
  }
  return out;
}

// ── The feature table ────────────────────────────────────────────────────────────────────

/** Features (and their simplified outlines) cached per level, past which the oldest go. */
const SIMPLIFIED_CACHE_LIMIT = 200_000;

/**
 * A parsed GeoJSON region set, indexed for tiles. Holds the raw features (for the exact
 * geometry and the export), each feature's rings, box, plane and class, and builds a level's
 * tile buckets the first time that level of a plane is asked for.
 */
export class RegionFeatureTable {
  readonly ids: string[] = [];
  readonly labels: Array<string | null> = [];
  readonly colors: Array<string | null> = [];
  readonly planes: number[] = [];
  readonly boxes: Bbox[] = [];
  readonly rings: Float64Array[][] = [];
  readonly open: boolean[] = [];
  /** Per feature, its parts as ring indices (the exterior first, then its holes). */
  readonly parts: number[][][] = [];
  private readonly labelPoints = new Map<number, Float32Array>();
  private hierarchy?: RegionClassNode[];
  private style?: RegionSourceStyle;
  private readonly byId = new Map<string, number>();
  private readonly buckets = new Map<string, Map<string, number[]>>();
  private readonly simplified = new Map<string, Float32Array[]>();
  private readonly bounds: Bbox | null;
  private readonly levels: number;

  constructor(
    readonly raw: GeoJsonFeatureLike[],
    readonly tileSize = REGION_TILE_SIZE,
  ) {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    raw.forEach((feature, i) => {
      const own = featureIdOf(feature);
      const id = own === undefined || this.byId.has(own) ? `#${i}` : own;
      this.byId.set(id, i);
      this.ids.push(id);
      const { label, color } = classificationOf(feature);
      this.labels.push(label);
      this.colors.push(color);
      this.planes.push(feature?.geometry?.plane?.z ?? 0);
      const { rings, open, parts } = ringsOf(feature);
      this.rings.push(rings);
      this.open.push(open);
      this.parts.push(parts);
      const box = ringsBox(rings);
      this.boxes.push(box);
      if (rings.length) {
        x0 = Math.min(x0, box[0]);
        y0 = Math.min(y0, box[1]);
        x1 = Math.max(x1, box[2]);
        y1 = Math.max(y1, box[3]);
      }
    });
    this.bounds = x0 <= x1 ? [x0, y0, x1, y1] : null;
    const extent = this.bounds ? Math.max(Math.abs(x0), Math.abs(y0), Math.abs(x1), Math.abs(y1)) : 0;
    this.levels = 1 + Math.max(0, Math.ceil(Math.log2(Math.max(extent, tileSize) / tileSize)));
  }

  /** Parse a GeoJSON FeatureCollection string. Throws on invalid JSON or no `features`. */
  static fromGeoJson(text: string, tileSize = REGION_TILE_SIZE): RegionFeatureTable {
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.features)) {
      throw new Error("Invalid GeoJson file: must contain the 'features' key.");
    }
    const table = new RegionFeatureTable(parsed.features, tileSize);
    table.describe(parsed.classHierarchy, parsed.style);
    return table;
  }

  /** Attach a class hierarchy and a style hint (each ignored when not well formed). */
  describe(hierarchy?: unknown, style?: unknown): void {
    this.hierarchy = readHierarchy(hierarchy) ?? this.hierarchy;
    this.style = readStyle(style) ?? this.style;
  }

  /** Features per class on plane `z` (what the plane has of each class). */
  classCounts(z: number): Record<string, number> {
    const counts: Record<string, number> = {};
    for (let i = 0; i < this.ids.length; i++) {
      const label = this.labels[i];
      if (this.planes[i] !== z || !label) continue;
      counts[label] = (counts[label] ?? 0) + 1;
    }
    return counts;
  }

  info(): RegionSourceInfo {
    const classColors: Record<string, string> = {};
    this.labels.forEach((label, i) => {
      const color = this.colors[i];
      if (label && color && !(label in classColors)) classColors[label] = color;
    });
    return {
      featureCount: this.ids.length,
      bounds: this.bounds,
      tileSize: this.tileSize,
      levels: this.levels,
      planes: Array.from(new Set(this.planes)).sort((a, b) => a - b),
      classColors,
      ...(this.hierarchy ? { hierarchy: this.hierarchy } : {}),
      ...(this.style ? { style: this.style } : {}),
    };
  }

  /** One tile of plane `z`. */
  tile(z: number, level: number, gx: number, gy: number): RegionTile {
    const bucket = this.bucketsFor(z, level).get(`${gx}/${gy}`) ?? [];
    const features: TileFeature[] = [];
    for (const i of bucket) {
      const rings = this.ringsAt(i, level);
      if (!rings.length) continue;
      const labels = this.labelsAt(i, level);
      features.push({
        id: this.ids[i],
        label: this.labels[i],
        color: this.colors[i],
        bbox: this.boxes[i],
        rings,
        open: this.open[i],
        ...(labels ? { labels } : {}),
      });
    }
    return { z, level, gx, gy, features };
  }

  /** The raw GeoJSON features with these ids, in the order asked (unknown ids skipped). */
  features(ids: readonly string[]): Array<{ id: string; feature: GeoJsonFeatureLike }> {
    const out: Array<{ id: string; feature: GeoJsonFeatureLike }> = [];
    for (const id of ids) {
      const i = this.byId.get(id);
      if (i !== undefined) out.push({ id, feature: this.raw[i] });
    }
    return out;
  }

  /** A page of plane `z`'s features, in file order. */
  index(z: number, query: RegionIndexQuery): RegionIndexPage {
    const exclude = new Set(query.exclude ?? []);
    const classes = query.classes ? new Set(query.classes) : null;
    const needle = query.label?.trim().toLowerCase() || null;
    const rows: RegionIndexRow[] = [];
    let total = 0;
    for (let i = 0; i < this.ids.length; i++) {
      if (this.planes[i] !== z || exclude.has(this.ids[i])) continue;
      if (needle && !(this.labels[i] ?? '').toLowerCase().includes(needle)) continue;
      if (classes && !classes.has(this.labels[i] ?? '')) continue;
      if (total >= query.offset && rows.length < query.limit) {
        rows.push({ id: this.ids[i], label: this.labels[i], color: this.colors[i], bbox: this.boxes[i] });
      }
      total++;
    }
    return { total, rows };
  }

  /**
   * The source as a GeoJSON FeatureCollection string, through the working set: features whose
   * id is in `exclude` (taken for editing, or deleted) are left out, `extra` (the working set's
   * features) appended. Every feature keeps an `id`.
   */
  exportGeoJson(exclude: readonly string[], extra: readonly object[]): string {
    const skip = new Set(exclude);
    const parts: string[] = [];
    this.raw.forEach((feature, i) => {
      const id = this.ids[i];
      if (skip.has(id)) return;
      parts.push(JSON.stringify(feature.id === undefined ? { type: 'Feature', id, ...feature } : feature));
    });
    for (const f of extra) parts.push(JSON.stringify(f));
    return `{"type":"FeatureCollection","features":[${parts.join(',')}]}`;
  }

  /**
   * Feature `i`'s label points (one per part with room for a label at `level`: a part under the
   * level's minimum extent is not drawn there), from the exact geometry, computed once.
   */
  private labelsAt(i: number, level: number): Float32Array | null {
    if (this.open[i] || !this.labels[i]) return null;
    let points = this.labelPoints.get(i);
    if (!points) {
      const out: number[] = [];
      for (const part of this.parts[i]) {
        const pole = polylabel(part.map((r) => this.rings[i][r]));
        if (pole && pole.distance > 0) out.push(pole.x, pole.y, pole.distance);
      }
      points = Float32Array.from(out);
      this.labelPoints.set(i, points);
    }
    const min = levelMinExtent(level) / 2;
    if (!min) return points.length ? points : null;
    const kept: number[] = [];
    for (let k = 0; k + 2 < points.length; k += 3)
      if (points[k + 2] >= min) kept.push(points[k], points[k + 1], points[k + 2]);
    return kept.length ? Float32Array.from(kept) : null;
  }

  /** Feature `i`'s rings at `level`, simplified once and cached. */
  private ringsAt(i: number, level: number): Float32Array[] {
    const key = `${level}/${i}`;
    let rings = this.simplified.get(key);
    if (!rings) {
      rings = simplifyRings(this.rings[i], this.open[i], level);
      if (this.simplified.size >= SIMPLIFIED_CACHE_LIMIT) {
        const oldest = this.simplified.keys().next().value as string;
        this.simplified.delete(oldest);
      }
      this.simplified.set(key, rings);
    }
    return rings;
  }

  /** Plane `z`'s level-`level` buckets (`gx/gy` → feature indices), built on first use. */
  private bucketsFor(z: number, level: number): Map<string, number[]> {
    const key = `${z}/${level}`;
    let buckets = this.buckets.get(key);
    if (buckets) return buckets;
    buckets = new Map();
    const size = levelTileSize(level, this.tileSize);
    const minExtent = levelMinExtent(level);
    for (let i = 0; i < this.ids.length; i++) {
      if (this.planes[i] !== z || !this.rings[i].length) continue;
      const b = this.boxes[i];
      if (Math.max(b[2] - b[0], b[3] - b[1]) < minExtent) continue;
      for (let gy = Math.floor(b[1] / size); gy <= Math.floor(b[3] / size); gy++) {
        for (let gx = Math.floor(b[0] / size); gx <= Math.floor(b[2] / size); gx++) {
          const id = `${gx}/${gy}`;
          const list = buckets.get(id);
          if (list) list.push(i);
          else buckets.set(id, [i]);
        }
      }
    }
    this.buckets.set(key, buckets);
    return buckets;
  }
}

/** A feature's own id (`id`, else `properties.id`) as a string. */
export function featureIdOf(feature: GeoJsonFeatureLike): string | undefined {
  const id = feature?.id ?? feature?.properties?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}

/** Class name and colour from QuPath's `classification` (`{name, color}`, or a bare name). */
function classificationOf(feature: GeoJsonFeatureLike): { label: string | null; color: string | null } {
  const c = feature?.properties?.classification as { name?: string; color?: number[] } | string | undefined;
  if (!c) return { label: 'Cell', color: null };
  if (typeof c === 'string') return { label: c, color: null };
  const color =
    Array.isArray(c.color) && c.color.length >= 3 ? rgbToHex([c.color[0], c.color[1], c.color[2]]) : null;
  return { label: c.name ?? null, color };
}

/**
 * A feature's rings, interleaved, without the closing vertex; whether it is a polyline; and its
 * parts as ring indices (each part's exterior first, then its holes).
 */
function ringsOf(feature: GeoJsonFeatureLike): { rings: Float64Array[]; open: boolean; parts: number[][] } {
  const g = feature?.geometry;
  const coords = g?.coordinates as unknown;
  if (!g || !Array.isArray(coords)) return { rings: [], open: false, parts: [] };
  const polygons = (list: number[][][][]) => {
    const rings: Float64Array[] = [];
    const parts: number[][] = [];
    for (const polygon of list) {
      const part: number[] = [];
      for (const r of polygon) {
        part.push(rings.length);
        rings.push(flatRing(r, true));
      }
      if (part.length) parts.push(part);
    }
    return { rings, open: false, parts };
  };
  switch (g.type) {
    case 'Polygon':
      return polygons([coords as number[][][]]);
    case 'MultiPolygon':
      return polygons(coords as number[][][][]);
    case 'LineString':
      return { rings: [flatRing(coords as number[][], false)], open: true, parts: [] };
    case 'MultiLineString':
      return { rings: (coords as number[][][]).map((r) => flatRing(r, false)), open: true, parts: [] };
    default:
      return { rings: [], open: false, parts: [] };
  }
}

/** A well-formed class hierarchy from a file (colours as `#rrggbb` or `[r, g, b]`), else undefined. */
export function readHierarchy(raw: unknown): RegionClassNode[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: RegionClassNode[] = [];
  for (const n of raw as Array<Record<string, unknown>>) {
    if (!n || typeof n.name !== 'string') continue;
    const color = Array.isArray(n.color) ? rgbToHex([+n.color[0], +n.color[1], +n.color[2]]) : n.color;
    out.push({
      name: n.name,
      ...(typeof n.title === 'string' ? { title: n.title } : {}),
      ...(typeof n.parent === 'string' ? { parent: n.parent } : {}),
      ...(typeof color === 'string' ? { color } : {}),
      ...(typeof n.order === 'number' ? { order: n.order } : {}),
    });
  }
  return out.length ? out : undefined;
}

/** A well-formed style hint from a file, else undefined. */
export function readStyle(raw: unknown): RegionSourceStyle | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const style: RegionSourceStyle = {};
  if (typeof r.fillOpacity === 'number') style.fillOpacity = Math.max(0, Math.min(1, r.fillOpacity));
  if (typeof r.stroke === 'string') style.stroke = r.stroke;
  if (typeof r.strokeWidth === 'number' && r.strokeWidth > 0) style.strokeWidth = r.strokeWidth;
  if (typeof r.labels === 'boolean') style.labels = r.labels;
  if (typeof r.highlight === 'string') style.highlight = r.highlight;
  return Object.keys(style).length ? style : undefined;
}

function flatRing(points: number[][], closed: boolean): Float64Array {
  let n = points?.length ?? 0;
  if (closed && n > 1) {
    const a = points[0],
      b = points[n - 1];
    if (a[0] === b[0] && a[1] === b[1]) n--;
  }
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[2 * i] = +points[i][0];
    out[2 * i + 1] = +points[i][1];
  }
  return out;
}

function ringsBox(rings: readonly Float64Array[]): Bbox {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const r of rings) {
    for (let i = 0; i + 1 < r.length; i += 2) {
      if (r[i] < x0) x0 = r[i];
      if (r[i] > x1) x1 = r[i];
      if (r[i + 1] < y0) y0 = r[i + 1];
      if (r[i + 1] > y1) y1 = r[i + 1];
    }
  }
  return [x0, y0, x1, y1];
}
