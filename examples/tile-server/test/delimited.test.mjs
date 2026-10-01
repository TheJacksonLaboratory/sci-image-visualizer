/** Imported grouping tables: quoted CSV fields must survive, and TSV is recognised. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDelimited } from '../lib/delimited.mjs';

test('keeps a quoted comma inside its field', () => {
  assert.deepEqual(parseDelimited('cell_id,group\nabc-1,"T cell, activated"\n'),
    [['cell_id', 'group'], ['abc-1', 'T cell, activated']]);
});

test('unescapes doubled quotes and keeps quoted newlines', () => {
  assert.deepEqual(parseDelimited('a,b\r\nx,"say ""hi""\nthere"'),
    [['a', 'b'], ['x', 'say "hi"\nthere']]);
});

test('reads TSV when the header is tab-separated, commas and all', () => {
  assert.deepEqual(parseDelimited('cell_id\tgroup\nabc-1\tA, B\n'), [['cell_id', 'group'], ['abc-1', 'A, B']]);
});

test('trims unquoted fields, skips blank lines, keeps empty fields', () => {
  assert.deepEqual(parseDelimited(' a , b \n\n x ,\n'), [['a', 'b'], ['x', '']]);
});

test('rejects an unterminated quote', () => {
  assert.throws(() => parseDelimited('a,b\nx,"open'), /unterminated/);
});
