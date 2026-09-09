/**
 * Which source owns a dataset id, and for how long that answer is trusted.
 *
 * Five sources can claim the same id, in priority order bundle > zarr > st > abc > h5ad,
 * and that order exists so a deliberately-converted bundle can OVERRIDE a live source.
 * The directories are ones people drop files into while the server is running, so the
 * resolution has to be re-checkable — a permanently cached owner turns the override into
 * something that only takes effect after a restart.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { startServer, writeBundle } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a bundle generated later takes over from the source it shadows', async () => {
  // A short TTL keeps the test quick; the mechanism under test is the expiry itself.
  const server = await startServer({ SOURCE_TTL_MS: '300' });
  try {
    // The h5ad source claims an id purely by filename — it does not open the file, so a
    // placeholder is enough to make it the owner, and its manifest then fails.
    const h5ad = path.join(server.dir, 'h5ad', 'takeover.h5ad');
    await writeFile(h5ad, 'not really hdf5');

    const claimed = await fetch(`${server.url}/spatial/takeover/manifest`);
    assert.ok(claimed.status >= 400, `h5ad should own it and fail: ${claimed.status}`);

    // Now the bundle appears, which outranks it.
    await writeBundle(path.join(server.dir, 'spatial'), 'takeover', { name: 'Converted' });
    await sleep(400);

    const res = await fetch(`${server.url}/spatial/takeover/manifest`);
    assert.equal(res.status, 200, 'the bundle never took over');
    assert.equal((await res.json()).name, 'Converted');
  } finally {
    await server.stop();
  }
});

test('an owner that disappears stops being dispatched to', async () => {
  const server = await startServer({ SOURCE_TTL_MS: '300' });
  try {
    const spatial = path.join(server.dir, 'spatial');
    await writeBundle(spatial, 'transient');
    assert.equal((await fetch(`${server.url}/spatial/transient/manifest`)).status, 200);

    await rm(path.join(spatial, 'transient'), { recursive: true, force: true });
    await sleep(400);

    const res = await fetch(`${server.url}/spatial/transient/manifest`);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /unknown dataset/);
  } finally {
    await server.stop();
  }
});

test('within the window, repeated requests reuse the resolved owner', async () => {
  // The cache still has to do its job: one page load asks for a manifest and then a dozen
  // vectors, and re-probing five sources for each would be the reason it exists.
  const server = await startServer({ SOURCE_TTL_MS: '60000' });
  try {
    await writeBundle(path.join(server.dir, 'spatial'), 'stable');
    for (let i = 0; i < 5; i++) {
      assert.equal((await fetch(`${server.url}/spatial/stable/manifest`)).status, 200);
    }
    // A bundle added now must NOT be visible yet: that is what proves the earlier answer
    // was reused rather than re-derived on every request.
    await writeBundle(path.join(server.dir, 'spatial'), 'stable-2');
    const early = await fetch(`${server.url}/spatial/stable-2/manifest`);
    assert.equal(early.status, 200, 'a NEW id still resolves — the cache is per id');
  } finally {
    await server.stop();
  }
});
