/**
 * Region sources over HTTP: the wire the library's HTTP region source reads, for a single
 * GeoJSON file and for a folder of per-slice files.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { startServer } from './harness.mjs';

const square = (x, y, s, perSide = 10) => {
  const c = [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  const pts = [];
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = c[k];
    const [bx, by] = c[(k + 1) % 4];
    for (let i = 0; i < perSide; i++) pts.push([ax + ((bx - ax) * i) / perSide, ay + ((by - ay) * i) / perSide]);
  }
  return [...pts, pts[0]];
};
const feature = (id, x, name, z) => ({
  type: 'Feature',
  id,
  properties: { classification: { name, color: [255, 0, 0] }, acronym: id },
  geometry: { type: 'Polygon', coordinates: [square(x, 0, 100)], ...(z ? { plane: { z } } : {}) },
});
const collection = (features) => JSON.stringify({ type: 'FeatureCollection', features });

let server;
const get = async (p) => {
  const res = await fetch(`${server.url}${p}`);
  return { status: res.status, body: await res.json() };
};
const post = async (p, body) => {
  const res = await fetch(`${server.url}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  server = await startServer();
  const dir = path.join(server.dir, 'regions');
  await writeFile(path.join(dir, 'cells.geojson'), collection([feature('a', 0, 'A'), feature('b', 600, 'B'), feature('c', 0, 'A', 1)]));
  await mkdir(path.join(dir, 'plates'));
  await writeFile(path.join(dir, 'plates', '001.geojson'), collection([feature('997', 0, 'root')]));
  await writeFile(path.join(dir, 'plates', '002.geojson'), collection([feature('997', 0, 'root'), feature('8', 200, 'grey')]));
  await writeFile(path.join(server.dir, 'secret.geojson'), collection([feature('x', 0, 'X')]));
});

after(() => server.stop());

test('lists the region sets', async () => {
  const { body } = await get('/regions');
  assert.deepEqual(body.sets, [
    { id: 'cells', kind: 'file' },
    { id: 'plates', kind: 'folder' },
  ]);
});

test('a file set: info, tiles per plane, exact features, the index and the export', async () => {
  const info = (await get('/regions/cells/info')).body;
  assert.equal(info.featureCount, 3);
  assert.deepEqual(info.planes, [0, 1]);
  assert.deepEqual(info.classColors, { A: '#ff0000', B: '#ff0000' });

  const t0 = (await get('/regions/cells/tile/0/0/0/0')).body;
  assert.deepEqual(t0.features.map((f) => f.id), ['a']);
  assert.equal(t0.features[0].rings[0].length, 80);
  assert.deepEqual((await get('/regions/cells/tile/1/0/0/0')).body.features.map((f) => f.id), ['c']);
  // Coarser levels carry fewer vertices.
  const coarse = (await get('/regions/cells/tile/0/1/0/0')).body.features[0];
  assert.equal(coarse.rings[0].length, 8);

  const feats = (await post('/regions/cells/features', { ids: ['b'] })).body.features;
  assert.equal(feats[0].feature.properties.acronym, 'b');

  const page = (await post('/regions/cells/index', { z: 0, offset: 0, limit: 10, exclude: ['a'] })).body;
  assert.deepEqual(page.rows.map((r) => r.id), ['b']);

  const out = (await post('/regions/cells/export', { exclude: ['b'], extra: [{ type: 'Feature', id: 'new', geometry: null }] })).body;
  assert.deepEqual(out.features.map((f) => f.id), ['a', 'c', 'new']);
});

test('a folder set: one slice per file, ids qualified by slice', async () => {
  const info = (await get('/regions/plates/info')).body;
  assert.equal(info.featureCount, 3);
  assert.deepEqual(info.planes, [0, 1]);

  const t1 = (await get('/regions/plates/tile/1/0/0/0')).body;
  assert.deepEqual(t1.features.map((f) => f.id), ['1:997', '1:8']);
  assert.deepEqual((await get('/regions/plates/tile/5/0/0/0')).body, { features: [] });

  const feats = (await post('/regions/plates/features', { ids: ['1:8', '0:997'] })).body.features;
  assert.deepEqual(feats.map((f) => f.id), ['1:8', '0:997']);

  const page = (await post('/regions/plates/index', { z: 1, offset: 0, limit: 10, exclude: ['1:997', '0:8'] })).body;
  assert.deepEqual(page.rows.map((r) => r.id), ['1:8']);

  const out = (await post('/regions/plates/export', { exclude: ['0:997'], extra: [] })).body;
  assert.deepEqual(out.features.map((f) => f.id), ['1:997', '1:8']);
  assert.equal(out.features[0].geometry.plane.z, 1);
});

test('refuses ids that are not one name, and answers 404 for an unknown set', async () => {
  assert.equal((await get('/regions/nope/info')).status, 404);
  assert.equal((await get(`/regions/${encodeURIComponent('../secret')}/info`)).status, 404);
  assert.equal((await get('/regions/..%2Fsecret/info')).status, 404);
  assert.equal((await get('/regions/cells/tile/x/0/0/0')).status, 400);
});
