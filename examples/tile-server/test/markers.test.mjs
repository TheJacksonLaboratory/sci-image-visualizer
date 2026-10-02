/** Marker genes per cell group: the group-specific genes, best first, controls excluded. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeMarkers, topMarkers, NO_CATEGORY } from '../lib/xenium/markers.mjs';

// 6 cells: 0-2 in group A, 3-4 in group B, 5 unassigned. Genes: G0 marks A, G1 marks B,
// G2 is everywhere (no marker), G3 is a control probe that would otherwise mark A.
const codes = new Uint16Array([0, 0, 0, 1, 1, NO_CATEGORY]);
const matrix = [
  [[0, 5], [1, 4], [2, 6]],              // G0
  [[3, 7], [4, 8], [0, 1]],              // G1
  [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2]], // G2
  [[0, 9], [1, 9], [2, 9]],              // G3 (control)
];
const run = () => computeMarkers({
  groupings: [{ name: 'type', codes, categories: ['A', 'B'] }],
  geneCount: 4,
  geneName: (g) => `G${g}`,
  isReal: (g) => g !== 3,
  forEachNonzero: async (visit) => matrix.forEach((row, g) => row.forEach(([c, v]) => visit(g, c, v))),
});

test('finds each group\'s specific gene and nothing shared or control', async () => {
  const r = (await run()).get('type');
  const [a, b] = r.groups;
  assert.equal(a.name, 'A');
  assert.equal(a.cells, 3);
  assert.deepEqual(a.genes.map((g) => g.name), ['G0']);
  assert.deepEqual(b.genes.map((g) => g.name), ['G1']);
  assert.equal(b.genes[0].pctIn, 1);
  assert.equal(b.genes[0].pctOut, 1 / 3); // detected in one of A's three cells
});

test('topMarkers trims to n per group', async () => {
  const r = topMarkers((await run()).get('type'), 0);
  assert.deepEqual(r.groups.map((g) => g.genes.length), [0, 0]);
});
