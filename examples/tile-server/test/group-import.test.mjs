/**
 * Group import is a persistent write every viewer sees, so a server only accepts one when it
 * was told to: a token, or an explicit "open" for a local server. Checked before the dataset
 * is looked up, so the outcome for an unknown id shows which gate answered.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './harness.mjs';

const post = (url, headers = {}) => fetch(`${url}/spatial/nope/groups?name=x`, {
  method: 'POST', body: 'cell_id,group\na-1,A\n', headers: { 'content-type': 'text/csv', ...headers },
});

test('refused by default', async () => {
  const s = await startServer();
  try {
    const res = await post(s.url);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /disabled/);
  } finally {
    await s.stop();
  }
});

test('with a token, only a caller presenting it gets through', async () => {
  const s = await startServer({ GROUP_IMPORT_TOKEN: 's3cret' });
  try {
    assert.equal((await post(s.url)).status, 401);
    assert.equal((await post(s.url, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(s.url, { authorization: 'Bearer s3cret' })).status, 404); // past the gate
  } finally {
    await s.stop();
  }
});

test('GROUP_IMPORT=open lets a local server take imports', async () => {
  const s = await startServer({ GROUP_IMPORT: 'open' });
  try {
    assert.equal((await post(s.url)).status, 404); // past the gate: the dataset does not exist
  } finally {
    await s.stop();
  }
});
