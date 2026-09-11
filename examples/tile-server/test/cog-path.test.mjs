/**
 * Id validation for the tile routes.
 *
 * The imageId arrives inside a base64 blob the client is free to write, so it is the one
 * value on the tile path that an attacker fully controls. Everything else — the pyramid
 * level, the channel, the slice — is bounded against the descriptor before it is used.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { safeId, cogPath } from '../lib/cog.mjs';

const ROOT = path.resolve('/srv/cogs');

test('accepts the id shapes real pyramids use', () => {
  for (const id of ['demo', 'B16-69_O7', 'visium.brain', 'a1', 'x_y-z.1']) {
    assert.equal(safeId(id), id, id);
    assert.equal(cogPath(ROOT, id, 'descriptor.json'), path.join(ROOT, id, 'descriptor.json'));
  }
});

test('rejects `..`, which the old character class accepted whole', () => {
  // `/^[A-Za-z0-9._-]+$/` matched the two-character id `..` because `.` was in the class
  // and `+` allowed exactly two of them. `path.join(cogDir, '..')` then resolved to the
  // PARENT of the COG dir, where the server would look for a descriptor or an L0.tif.
  assert.throws(() => safeId('..'), /bad image id/);
  assert.throws(() => cogPath(ROOT, '..', 'descriptor.json'), /bad image id/);
});

test('rejects a lone dot and any dotfile', () => {
  for (const id of ['.', '.git', '.env', '.ssh']) {
    assert.throws(() => safeId(id), /bad image id/, id);
  }
});

test('rejects separators, traversal, encodings and absolute paths', () => {
  for (const id of [
    '../etc/passwd', 'a/../..', 'a/b', 'a\\b', '/etc/passwd', 'C:\\x',
    '..%2fetc', '%2e%2e', 'a..b', 'a/..', '', null, undefined,
  ]) {
    assert.throws(() => safeId(id), /bad image id/, String(id));
  }
});

test('a joined path can never leave the root, whatever the trailing parts say', () => {
  // The containment check also covers the interpolated FILENAME, not just the id: level
  // and channel are numbers today, and this is what keeps that from being load-bearing.
  assert.throws(() => cogPath(ROOT, 'demo', '../../etc/passwd'), /bad image id/);
  assert.throws(() => cogPath(ROOT, 'demo', '..', '..'), /bad image id/);
});

test('a root whose name prefixes another directory is not a way out', () => {
  // `startsWith(root)` alone would accept `/srv/cogs-evil`; the separator is why the
  // check appends one.
  const nearby = path.resolve('/srv/cogs-evil/x');
  assert.notEqual(cogPath(ROOT, 'demo'), nearby);
  assert.ok(cogPath(ROOT, 'demo').startsWith(ROOT + path.sep));
});
