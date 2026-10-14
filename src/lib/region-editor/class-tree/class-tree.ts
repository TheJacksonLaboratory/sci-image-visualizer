import type { RegionClassNode } from '../../region-source/region-tiles';

/** A class hierarchy as a tree: children in order, subtree counts, depths. Pure. */
export interface ClassTree {
  roots: string[];
  node: Map<string, RegionClassNode>;
  children: Map<string, string[]>;
  parent: Map<string, string | null>;
  /** Regions of the class and every class under it. */
  total: Map<string, number>;
}

/**
 * Build the tree of `nodes`, counting `counts` (regions per class) up through it. A node whose
 * parent is not in the hierarchy is a root; siblings sort by `order`, then as listed.
 */
export function buildClassTree(nodes: readonly RegionClassNode[], counts: ReadonlyMap<string, number>): ClassTree {
  const node = new Map<string, RegionClassNode>();
  for (const n of nodes) if (!node.has(n.name)) node.set(n.name, n);
  const children = new Map<string, string[]>();
  const parent = new Map<string, string | null>();
  const roots: string[] = [];
  const position = new Map(nodes.map((n, i) => [n.name, i]));
  for (const n of node.values()) {
    const p = n.parent && node.has(n.parent) && n.parent !== n.name ? n.parent : null;
    parent.set(n.name, p);
    if (p) {
      const list = children.get(p);
      if (list) list.push(n.name);
      else children.set(p, [n.name]);
    } else roots.push(n.name);
  }
  const byOrder = (a: string, b: string) =>
    (node.get(a)?.order ?? Infinity) - (node.get(b)?.order ?? Infinity) ||
    (position.get(a) ?? 0) - (position.get(b) ?? 0);
  roots.sort(byOrder);
  for (const list of children.values()) list.sort(byOrder);

  const total = new Map<string, number>();
  const visit = (name: string, seen: Set<string>): number => {
    const known = total.get(name);
    if (known !== undefined) return known;
    if (seen.has(name)) return 0; // a cycle in a malformed file
    seen.add(name);
    let sum = counts.get(name) ?? 0;
    for (const c of children.get(name) ?? []) sum += visit(c, seen);
    total.set(name, sum);
    return sum;
  };
  for (const name of node.keys()) visit(name, new Set());
  return { roots, node, children, parent, total };
}

/** `name` and every class under it. */
export function subtree(tree: ClassTree, name: string): string[] {
  const out: string[] = [];
  const stack = [name];
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop() as string;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    for (const c of tree.children.get(n) ?? []) stack.push(c);
  }
  return out;
}

/** The classes from the root down to `name`'s parent. */
export function ancestors(tree: ClassTree, name: string): string[] {
  const out: string[] = [];
  let p = tree.parent.get(name) ?? null;
  while (p && !out.includes(p)) {
    out.unshift(p);
    p = tree.parent.get(p) ?? null;
  }
  return out;
}

/** One visible row of the tree. */
export interface ClassTreeRow {
  name: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * The rows to draw: depth-first through the expanded nodes. With a `query`, only the nodes whose
 * name or title contains it and their ancestors, all expanded.
 */
export function visibleRows(tree: ClassTree, expanded: ReadonlySet<string>, query = ''): ClassTreeRow[] {
  const q = query.trim().toLowerCase();
  let keep: Set<string> | null = null;
  if (q) {
    keep = new Set();
    for (const [name, n] of tree.node) {
      if (name.toLowerCase().includes(q) || (n.title ?? '').toLowerCase().includes(q)) {
        keep.add(name);
        for (const a of ancestors(tree, name)) keep.add(a);
      }
    }
  }
  const rows: ClassTreeRow[] = [];
  const walk = (name: string, depth: number) => {
    if (keep && !keep.has(name)) return;
    const kids = tree.children.get(name) ?? [];
    const open = keep ? true : expanded.has(name);
    rows.push({ name, depth, hasChildren: kids.length > 0, expanded: open && kids.length > 0 });
    if (open) for (const c of kids) walk(c, depth + 1);
  };
  for (const r of tree.roots) walk(r, 0);
  return rows;
}
