import { traceContours } from 'napari-js/geometry';

import type { RegionClassNode, RegionSourceStyle } from '../region-source/region-tiles';
import type { LabelVolume } from './label-volume';

/**
 * The classes of a label volume's values: their names and colours and, when the volume comes
 * with an ontology, their tree. Pure.
 */
export interface LabelClasses {
  /** The class of label `value` (> 0); one without an ontology entry is `label <value>`. */
  classOf(value: number): { name: string; color: string; title?: string };
  /** The class tree, when the ontology has one. */
  hierarchy?: RegionClassNode[];
  /** How the set wants to be drawn (an atlas's filled look), when the ontology says. */
  style?: RegionSourceStyle;
}

/** The look the Allen atlas region sets carry (see the brain-atlas example's GeoJSON). */
export const ATLAS_STYLE: RegionSourceStyle = {
  fillOpacity: 0.6,
  stroke: '#3c3c3c',
  strokeWidth: 1,
  labels: true,
  highlight: '#a020f0',
};

interface AllenNode {
  id: number;
  acronym: string;
  name?: string;
  color_hex_triplet?: string;
  graph_order?: number;
  children?: AllenNode[];
}

/**
 * The classes of a label volume from `ontology`, a parsed JSON document:
 *
 * - an **Allen structure graph** (`structure_graph_1.json`: `{ msg: [root] }`, or a node or a
 *   list of nodes with `id`, `acronym`, `name`, `color_hex_triplet`, `graph_order` and
 *   `children`): label = structure id, class = acronym, its tree the ontology's, drawn as the
 *   atlas region sets are;
 * - a **region set description** (a `regionset.json`: `classHierarchy`, optional `style`), whose
 *   classes name their label as `value` (or `id`), or with a `labels` map of value → class name.
 *
 * Without one (or with another document), each label is its own class `label <value>`.
 */
export function labelClasses(ontology?: unknown): LabelClasses {
  const allen = allenRoots(ontology);
  if (allen) return allenClasses(allen);
  if (
    ontology &&
    typeof ontology === 'object' &&
    Array.isArray((ontology as { classHierarchy?: unknown }).classHierarchy)
  ) {
    return regionSetClasses(ontology as RegionSetDoc);
  }
  return { classOf: unnamed };
}

function unnamed(value: number): { name: string; color: string } {
  return { name: `label ${value}`, color: paletteColor(value) };
}

function allenRoots(doc: unknown): AllenNode[] | null {
  const isNode = (n: unknown): n is AllenNode =>
    !!n &&
    typeof n === 'object' &&
    typeof (n as AllenNode).id === 'number' &&
    typeof (n as AllenNode).acronym === 'string';
  const msg = (doc as { msg?: unknown })?.msg;
  const roots = Array.isArray(msg) ? msg : Array.isArray(doc) ? doc : doc ? [doc] : [];
  return roots.length && roots.every(isNode) ? (roots as AllenNode[]) : null;
}

function allenClasses(roots: AllenNode[]): LabelClasses {
  const byId = new Map<number, { name: string; color: string; title?: string }>();
  const hierarchy: RegionClassNode[] = [];
  const walk = (n: AllenNode, parent: string | null) => {
    const color = `#${(n.color_hex_triplet || '808080').toUpperCase()}`;
    byId.set(n.id, { name: n.acronym, color, title: n.name });
    hierarchy.push({
      name: n.acronym,
      ...(n.name ? { title: n.name } : {}),
      ...(parent ? { parent } : {}),
      color,
      ...(n.graph_order != null ? { order: n.graph_order } : {}),
    });
    for (const c of n.children ?? []) walk(c, n.acronym);
  };
  for (const r of roots) walk(r, null);
  hierarchy.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return { classOf: (v) => byId.get(v) ?? unnamed(v), hierarchy, style: ATLAS_STYLE };
}

interface RegionSetDoc {
  classHierarchy: Array<RegionClassNode & { value?: number; id?: number }>;
  style?: RegionSourceStyle;
  labels?: Record<string, string>;
}

function regionSetClasses(doc: RegionSetDoc): LabelClasses {
  const nodes = new Map(doc.classHierarchy.map((n) => [n.name, n]));
  const byValue = new Map<number, string>();
  for (const n of doc.classHierarchy) {
    const v = typeof n.value === 'number' ? n.value : typeof n.id === 'number' ? n.id : undefined;
    if (v != null) byValue.set(v, n.name);
  }
  for (const [v, name] of Object.entries(doc.labels ?? {})) byValue.set(Number(v), name);
  const hierarchy = doc.classHierarchy.map(({ name, title, parent, color, order }) => ({
    name,
    ...(title ? { title } : {}),
    ...(parent ? { parent } : {}),
    ...(color ? { color } : {}),
    ...(order != null ? { order } : {}),
  }));
  return {
    classOf: (v) => {
      const name = byValue.get(v);
      const node = name ? nodes.get(name) : undefined;
      return node ? { name: node.name, color: node.color ?? paletteColor(v), title: node.title } : unnamed(v);
    },
    hierarchy,
    ...(doc.style ? { style: doc.style } : {}),
  };
}

/** A colour per label value, spread around the hue circle. */
function paletteColor(value: number): string {
  const hue = (value * 137.508) % 360;
  const [r, g, b] = hsl(hue, 0.65, 0.55);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((c) => Math.round(c * 255)) as [number, number, number];
}

const rgb = (hex: string): [number, number, number] =>
  [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16)) as [number, number, number];

/**
 * Slice `z` of `volume` as a GeoJSON FeatureCollection string: one feature per label on the
 * slice, its every piece (with holes) traced along pixel edges, in image pixels with y down;
 * classified by `classes`, which also give the collection its class tree and style.
 */
export function labelSliceGeoJson(volume: LabelVolume, z: number, classes: LabelClasses): string {
  const labels = volume.sliceLabels(z);
  const byLabel = new Map<number, number[][][][]>();
  for (const c of traceContours({ data: labels, width: volume.width, height: volume.height })) {
    const polygons = byLabel.get(c.value) ?? [];
    polygons.push([ring(c.outer), ...c.holes.map(ring)]);
    byLabel.set(c.value, polygons);
  }
  const features = [...byLabel].map(([value, polygons]) => {
    const cls = classes.classOf(value);
    return {
      type: 'Feature',
      id: String(value),
      geometry: { type: 'MultiPolygon', coordinates: polygons },
      properties: {
        objectType: 'annotation',
        name: cls.title ?? cls.name,
        classification: { name: cls.name, color: rgb(cls.color) },
        labelValue: value,
      },
    };
  });
  return JSON.stringify({
    type: 'FeatureCollection',
    ...(classes.hierarchy ? { classHierarchy: classes.hierarchy } : {}),
    ...(classes.style ? { style: classes.style } : {}),
    features,
  });
}

/** A closed GeoJSON ring from a flat `[x0, y0, …]` one. */
function ring(flat: number[]): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  if (pts.length) pts.push([...pts[0]]);
  return pts;
}
