#!/usr/bin/env node
/**
 * Fetch the Allen Brain Cell Atlas whole-mouse-brain MERFISH tables that
 * lib/spatial-abc.mjs serves.
 *
 * This is the only 3D spatial-omics dataset in the example: ~4M cells from 59
 * coronal sections, each registered into the Allen CCFv3, so every cell has a
 * real (x, y, z) in millimetres rather than a section index. Everything else we
 * serve is a single plane.
 *
 * The bucket is a public AWS Open Data set — no credentials, no signing, plain
 * CSV over HTTPS. We take the pre-joined "view" tables rather than joining
 * cell_metadata + ccf_coordinates + the taxonomy ourselves: CSV is row-major, so
 * a join would mean downloading ~820MB and doing the work anyway, against 1.5GB
 * and no join. Downloads resume, so a dropped connection is not a restart.
 *
 *   node scripts/fetch-abc.mjs [--dir abc] [--cells-only|--genes-only|--volume-only]
 */
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const BUCKET = 'https://allen-brain-cell-atlas.s3.amazonaws.com';
// Pinned releases. The bucket keeps every release, so pinning means a rebuild a
// year from now reproduces today's numbers instead of silently drifting.
//
// They are not all the same date: the metadata tables were revised through
// 20231215, while the image volumes stop at 20230630 (asking for them under the
// newer prefix is a 404). Same registration either way — the later releases
// revised annotations, not the reference volume.
const RELEASE = '20231215';
const VOLUME_RELEASE = '20230630';

const FILES = [
  {
    key: 'cells',
    // Cell metadata joined to the CCF registration AND the taxonomy: x/y/z_ccf,
    // class/subclass/supertype/cluster, the anatomical parcellation, and Allen's
    // official hex colour for each of those. One file, no joins.
    url: `${BUCKET}/metadata/MERFISH-C57BL6J-638850-CCF/${RELEASE}/views/cell_metadata_with_parcellation_annotation.csv`,
    name: 'cell_metadata_with_parcellation_annotation.csv',
    approxMb: 1532,
  },
  {
    key: 'genes',
    // log2 expression for 8 marker genes across all cells. The full 500-gene
    // panel ships only as h5ad, which we have no reader for; these eight are
    // published as CSV, so colour-by-gene works without an HDF5 dependency.
    url: `${BUCKET}/metadata/MERFISH-C57BL6J-638850/${RELEASE}/views/example_genes_all_cells_expression.csv`,
    name: 'example_genes_all_cells_expression.csv',
    approxMb: 343,
  },
  {
    key: 'volume',
    // The CCF average template, resampled into the SAME frame the cells are
    // registered to. This is the anatomical backdrop: without it the cloud floats
    // in empty space, and "where in the brain is this cluster" has no answer.
    url: `${BUCKET}/image_volumes/MERFISH-C57BL6J-638850-CCF/${VOLUME_RELEASE}/resampled_average_template.nii.gz`,
    name: 'resampled_average_template.nii.gz',
    approxMb: 112,
  },
];

const args = process.argv.slice(2);
const dirArg = args.indexOf('--dir');
const outDir = path.resolve(dirArg >= 0 ? args[dirArg + 1] : new URL('../abc', import.meta.url).pathname);
const ONLY_FLAGS = ['cells', 'genes', 'volume'];
const only = ONLY_FLAGS.find((k) => args.includes(`--${k}-only`)) ?? null;

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

async function sizeOf(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

async function download(spec) {
  const dest = path.join(outDir, spec.name);
  const have = await sizeOf(dest);

  // HEAD first so a complete file is a no-op and a partial one resumes at the
  // right offset instead of being appended to blindly.
  const head = await fetch(spec.url, { method: 'HEAD' });
  if (!head.ok) throw new Error(`HEAD ${spec.url} -> ${head.status}`);
  const total = Number(head.headers.get('content-length') || 0);

  if (have === total && total > 0) {
    console.log(`  ${spec.name}: already complete (${mb(total)})`);
    return;
  }
  if (have > total) throw new Error(`${dest} is larger than the remote file; delete it and retry`);

  const res = await fetch(spec.url, have ? { headers: { Range: `bytes=${have}-` } } : undefined);
  if (!res.ok) throw new Error(`GET ${spec.url} -> ${res.status}`);
  if (have && res.status !== 206) throw new Error(`server ignored Range on ${spec.name}; delete it and retry`);

  console.log(`  ${spec.name}: ${have ? `resuming at ${mb(have)}` : 'starting'} of ${mb(total)}`);
  let seen = have;
  let lastLog = Date.now();
  const started = Date.now();
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    seen += chunk.length;
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now();
      const rate = (seen - have) / ((Date.now() - started) / 1000);
      const pct = total ? ((seen / total) * 100).toFixed(1) : '?';
      console.log(`    ${pct}%  ${mb(seen)} / ${mb(total)}  (${mb(rate)}/s)`);
    }
  });
  await pipeline(body, createWriteStream(dest, { flags: have ? 'a' : 'w' }));
  console.log(`  ${spec.name}: done (${mb(seen)})`);
}

await mkdir(outDir, { recursive: true });
console.log(`Allen Brain Cell Atlas -> ${outDir}`);
console.log(`Public AWS Open Data bucket (arn:aws:s3:::allen-brain-cell-atlas), releases ${RELEASE} (tables) / ${VOLUME_RELEASE} (volume).\n`);
for (const spec of FILES) {
  if (only && spec.key !== only) continue;
  await download(spec);
}
console.log('\nDone. lib/spatial-abc.mjs builds its binary cache on first request.');
