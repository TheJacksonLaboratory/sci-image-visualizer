import { MultiPolygon, Polygon, Rectangle, Region } from '../models/region';

/**
 * A fingerprint of each class's regions (by label): their ids and geometry folded into one number
 * per class. Two sets give the same fingerprint for a class when its regions did not change, so
 * comparing a slice's fingerprints before and after an edit names the classes the edit touched
 * (a recoloured or relabelled region touches its old class and its new one). Profile lines and
 * unlabelled regions are left out: they are in no class.
 */
export function classSignatures(regions: readonly Region[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of regions) {
    if (!r.label || r.isProfile?.()) continue;
    out.set(r.label, mix(out.get(r.label) ?? 0, regionHash(r)));
  }
  return out;
}

/** The classes whose fingerprints differ between `before` and `after` (added and removed included). */
export function changedClasses(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): Set<string> {
  const out = new Set<string>();
  for (const [label, sig] of after) if (before.get(label) !== sig) out.add(label);
  for (const label of before.keys()) if (!after.has(label)) out.add(label);
  return out;
}

/** Order-independent within a class (summed), so reordering regions changes nothing. */
function mix(acc: number, h: number): number {
  return (acc + h) % 4294967296;
}

function regionHash(r: Region): number {
  let h = hashString(String(r.id ?? ''));
  const b = r.bounds;
  if (b instanceof Rectangle) return fold(fold(fold(fold(h, b.x), b.y), b.width), b.height);
  const polygons = b instanceof MultiPolygon ? b.polygons : b instanceof Polygon ? [b] : [];
  for (const p of polygons) {
    h = fold(h, p.closed === false ? 1 : 2);
    for (let i = 0; i < p.xpoints.length; i++) h = fold(fold(h, p.xpoints[i]), p.ypoints[i]);
    for (const hole of p.holes ?? []) for (const [x, y] of hole) h = fold(fold(h, x), y);
    // A bézier region's curve moves with its handles, not only its anchors.
    if (p.bezier)
      for (const [dx, dy] of [...(p.handlesIn ?? []), ...(p.handlesOut ?? [])]) h = fold(fold(h, dx), dy);
  }
  return h;
}

/** FNV-style step over a coordinate (kept to 1/1000 px, which no edit is finer than). */
function fold(h: number, v: number): number {
  return Math.imul(h ^ (Math.round(v * 1000) | 0), 16777619) >>> 0;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}
