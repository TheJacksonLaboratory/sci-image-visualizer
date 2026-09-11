/**
 * Route-level checks: what the server does with input it did not choose.
 *
 * These go through the socket deliberately. The interesting failures are in the seam
 * between the URL and the filesystem — what express decodes, what `path.join` makes of
 * it — and a handler called directly skips exactly that.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { startServer, infoToken, writeBundle } from './harness.mjs';

let server;

before(async () => {
  server = await startServer();
  // A file OUTSIDE $COG_DIR, in its parent. If an id could escape, this is what it would
  // reach — so the test proves the escape is closed rather than that some id 400s.
  await writeFile(
    path.join(server.dir, 'descriptor.json'),
    JSON.stringify({ secret: 'outside the cog dir' }),
  );
  await mkdir(path.join(server.dir, 'cogs', 'demo'), { recursive: true });
  await writeFile(
    path.join(server.dir, 'cogs', 'demo', 'descriptor.json'),
    JSON.stringify({ width: 4, height: 4, tileSize: 512, levels: [{ res: 0, width: 4, height: 4 }] }),
  );
});

after(() => server.stop());

test('serves a descriptor for an id that is actually in the COG dir', async () => {
  const res = await fetch(`${server.url}/tiles/info?info=${infoToken('demo')}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).width, 4);
});

test('an id of ".." does not reach the file one level up', async () => {
  // The regression: `{"image":".."}` resolved to $COG_DIR/../descriptor.json.
  const res = await fetch(`${server.url}/tiles/info?info=${infoToken('..')}`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /bad image id/);
  assert.ok(!JSON.stringify(body).includes('outside the cog dir'), 'leaked the parent file');
});

test('every tile route rejects the traversal, not just the descriptor one', async () => {
  const info = infoToken('..');
  const routes = [
    `/tiles/info?info=${info}`,
    `/tile?info=${info}&res=0&col=0&row=0`,
    `/preview?info=${info}&tier=small`,
  ];
  for (const route of routes) {
    const res = await fetch(`${server.url}${route}`);
    assert.ok(res.status >= 400, `${route} -> ${res.status}`);
    assert.ok(!(await res.text()).includes('outside the cog dir'), route);
  }
  const post = await fetch(`${server.url}/zoom/region`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ info, roi: { x: 0, y: 0, width: 2, height: 2 } }),
  });
  assert.ok(post.status >= 400);
});

test('rejects a malformed info token instead of guessing', async () => {
  for (const info of ['', 'not-base64!!', Buffer.from('{}').toString('base64url'),
    Buffer.from('{"image":7}').toString('base64url')]) {
    const res = await fetch(`${server.url}/tiles/info?info=${encodeURIComponent(info)}`);
    assert.equal(res.status, 400, JSON.stringify(info));
  }
});

test('a tile outside the pyramid is a 404, not a 500', async () => {
  const info = infoToken('demo');
  const res = await fetch(`${server.url}/tile?info=${info}&res=0&col=99&row=99`);
  assert.equal(res.status, 404);
});

test('a level the pyramid does not have is a 404', async () => {
  const res = await fetch(`${server.url}/tile?info=${infoToken('demo')}&res=9&col=0&row=0`);
  assert.equal(res.status, 404);
});

test('spatial ids are held to the same alphabet', async () => {
  await writeBundle(path.join(server.dir, 'spatial'), 'demo-set');
  const ok = await fetch(`${server.url}/spatial/demo-set/manifest`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).id, 'demo-set');

  // Encoded so express does not collapse it before the route sees it.
  for (const id of ['..', '.', '%2e%2e', '.hidden']) {
    const res = await fetch(`${server.url}/spatial/${id}/manifest`);
    assert.equal(res.status, 404, id);
  }
});

test('an unknown dataset is a 404 that names the id, not a stack trace', async () => {
  const res = await fetch(`${server.url}/spatial/nothing-here/manifest`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /unknown dataset: nothing-here/);
});

test('discovery lists the bundle and survives a foreign directory', async () => {
  await mkdir(path.join(server.dir, 'spatial', 'half-written'), { recursive: true });
  const res = await fetch(`${server.url}/spatial/datasets`);
  assert.equal(res.status, 200);
  const ids = (await res.json()).datasets.map((d) => d.id);
  assert.ok(ids.includes('demo-set'), JSON.stringify(ids));
  assert.ok(!ids.includes('half-written'));
});

test('spatial responses ask to be revalidated rather than held for an hour', async () => {
  // A rebuilt bundle stayed invisible to an open page under the old `max-age=3600`.
  const res = await fetch(`${server.url}/spatial/demo-set/manifest`);
  assert.match(res.headers.get('cache-control') ?? '', /no-cache/);
});
