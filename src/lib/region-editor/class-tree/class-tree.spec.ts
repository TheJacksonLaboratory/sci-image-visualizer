import { ancestors, buildClassTree, subtree, visibleRows } from './class-tree';

const nodes = [
  { name: 'root' },
  { name: 'grey', parent: 'root', order: 2 },
  { name: 'fiber', parent: 'root', order: 1 },
  { name: 'CTX', title: 'Cerebral cortex', parent: 'grey', order: 1 },
  { name: 'MO', title: 'Somatomotor areas', parent: 'CTX', order: 1 },
  { name: 'MO5', title: 'Somatomotor areas, Layer 5', parent: 'MO', order: 2 },
  { name: 'MO1', parent: 'MO', order: 1 },
  { name: 'orphan', parent: 'missing' },
];

describe('class tree', () => {
  const tree = buildClassTree(
    nodes,
    new Map([
      ['MO5', 3],
      ['MO1', 1],
      ['fiber', 2],
    ]),
  );

  it('orders siblings and treats a node with an unknown parent as a root', () => {
    expect(tree.roots).toEqual(['root', 'orphan']);
    expect(tree.children.get('root')).toEqual(['fiber', 'grey']);
    expect(tree.children.get('MO')).toEqual(['MO1', 'MO5']);
  });

  it('counts regions up the tree', () => {
    expect(tree.total.get('MO')).toBe(4);
    expect(tree.total.get('root')).toBe(6);
    expect(tree.total.get('orphan')).toBe(0);
  });

  it('lists a subtree and the path to a node', () => {
    expect(subtree(tree, 'CTX').sort()).toEqual(['CTX', 'MO', 'MO1', 'MO5']);
    expect(ancestors(tree, 'MO5')).toEqual(['root', 'grey', 'CTX', 'MO']);
  });

  it('shows the expanded nodes, or the matches of a search with their path', () => {
    expect(visibleRows(tree, new Set(['root'])).map((r) => r.name)).toEqual(['root', 'fiber', 'grey', 'orphan']);
    expect(visibleRows(tree, new Set(), 'layer 5').map((r) => [r.name, r.depth])).toEqual([
      ['root', 0],
      ['grey', 1],
      ['CTX', 2],
      ['MO', 3],
      ['MO5', 4],
    ]);
  });

  it('survives a cycle', () => {
    const t = buildClassTree(
      [
        { name: 'a', parent: 'b' },
        { name: 'b', parent: 'a' },
      ],
      new Map([['a', 1]]),
    );
    expect(t.roots).toEqual([]);
    expect(visibleRows(t, new Set())).toEqual([]);
  });
});
