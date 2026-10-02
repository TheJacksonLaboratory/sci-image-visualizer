/** Ranged reads survive an expired token: a 401 refreshes it and retries. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { openHttp } from '../lib/xenium/byte-source.mjs';

test('a 401 mid-run drops the token, fetches a new one, and the read succeeds', async () => {
  const body = Buffer.from('0123456789');
  let token = 'old';
  let refused = 0;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      refused++;
      res.writeHead(401).end();
      return;
    }
    const [a, b] = /bytes=(\d+)-(\d+)/.exec(req.headers.range).slice(1).map(Number);
    res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${body.length}` }).end(body.subarray(a, b + 1));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    let current = 'old';
    const src = await openHttp(`http://127.0.0.1:${server.address().port}/x`, {
      headers: async () => ({ Authorization: `Bearer ${current}` }),
      onUnauthorized: () => { current = token; },
    });
    assert.equal((await src.read(2, 3)).toString(), '234');
    token = 'new'; // the server rotates: the old token is now refused
    assert.equal((await src.read(5, 2)).toString(), '56');
    assert.equal(refused, 1);
  } finally {
    server.close();
  }
});
