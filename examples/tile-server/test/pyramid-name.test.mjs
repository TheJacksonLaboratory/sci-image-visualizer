/** A transcript pyramid is named after its bundle and kept next to it, as jit-service expects. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isLocalSource, transcriptPyramidName } from '../lib/xenium/pyramid-name.mjs';

test('names the pyramid after the bundle, zipped or not', () => {
  assert.equal(transcriptPyramidName('gs://b/run/WTA_Preview_xe_outs.zip'), 'WTA_Preview_xe_outs.transcripts');
  assert.equal(transcriptPyramidName('/data/run/S1_xe_outs.ZIP'), 'S1_xe_outs.transcripts');
  assert.equal(transcriptPyramidName('/data/run/outs/'), 'outs.transcripts');
  assert.equal(transcriptPyramidName('https://h/x/S2_xe_outs.zip?sig=1'), 'S2_xe_outs.transcripts');
});

test('tells local paths from URLs', () => {
  assert.equal(isLocalSource('/data/x_xe_outs.zip'), true);
  assert.equal(isLocalSource('xenium/x_xe_outs.zip'), true);
  for (const u of ['gs://b/x.zip', 'https://h/x.zip', 's3://b/x.zip']) assert.equal(isLocalSource(u), false, u);
});
