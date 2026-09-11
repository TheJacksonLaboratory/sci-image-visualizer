// Convert an AnnData `.h5ad` into a bundle dataset directory this server can serve.
//
//   npm install            # h5wasm comes with it
//   node scripts/h5ad-to-spatial.mjs --h5ad seqfish.h5ad --out spatial/seqfish \
//       --id seqfish --name "Mouse embryo seqFISH (Lohoff et al)" \
//       --spatial-key spatial --embedding X_umap:UMAP \
//       --column celltype_mapped_refined:categorical --column Area:continuous
//
// `X` may be CSC or CSR — scanpy writes CSR by default, so a CSC-only reader would reject
// most `.h5ad` files in existence.
//
// This is a CLI over `lib/h5ad-bundle.mjs`, which `lib/spatial-h5ad.mjs` also uses when it
// converts a dropped-in CSR file on first open. One writer, so a dataset converted by hand
// and the same dataset served through the drop-in path cannot disagree.
//
// The difference between the two is only where the columns and embeddings come from: here
// they are named on the command line, so nothing is guessed and a bundle carries exactly
// what was asked for.

import { writeBundle } from '../lib/h5ad-bundle.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const many = (name) => args.reduce(
  (out, a, i) => (a === `--${name}` && args[i + 1] ? [...out, args[i + 1]] : out), [],
);
const die = (msg) => { console.error(msg); process.exit(2); };

/** `--flag a,b` as two numbers. Comma-separated so a negative value is not read as a flag. */
function pair(text, name) {
  const parts = String(text).split(',');
  if (parts.length !== 2 || parts.some((v) => Number.isNaN(Number(v)))) {
    die(`--${name}: expected two comma-separated numbers, got "${text}"`);
  }
  return parts.map(Number);
}

const h5ad = flag('h5ad') ?? die('--h5ad is required');
const out = flag('out') ?? die('--out is required');
const id = flag('id') ?? die('--id is required');
const name = flag('name') ?? die('--name is required');
const radius = flag('radius');
const micronsPerUnit = flag('microns-per-unit');
const imageId = flag('image-id');
const imageScale = flag('image-scale');
const imageTranslate = flag('image-translate');
const imageMpp = flag('image-mpp');

let imageRef = null;
if (imageId || imageScale) {
  imageRef = {};
  if (imageId) imageRef.imageId = imageId;
  if (imageScale) imageRef.scale = pair(imageScale, 'image-scale');
  if (imageTranslate) imageRef.translate = pair(imageTranslate, 'image-translate');
  if (imageMpp) [imageRef.mppX, imageRef.mppY] = pair(imageMpp, 'image-mpp');
}

try {
  const manifest = await writeBundle({
    h5ad,
    out,
    id,
    name,
    spatialKey: flag('spatial-key', 'spatial'),
    columns: many('column').map((spec) => {
      const [colName, kind = 'continuous'] = spec.split(':');
      return { name: colName, kind };
    }),
    embeddings: many('embedding').map((spec) => {
      const [key, label] = spec.split(':');
      return { key, label };
    }),
    derived: new Set(many('derived')),
    radius: radius === null ? null : Number(radius),
    featuresUnit: flag('features-unit'),
    imageRef,
    micronsPerUnit: micronsPerUnit === null ? null : Number(micronsPerUnit),
  });
  console.log(`wrote ${out}: ${manifest.count} observations, ${manifest.features.count} genes, `
    + `${manifest.columns.length} columns, ${(manifest.embeddings ?? []).length} embeddings, `
    + `radius ${manifest.radius.value.toFixed(4)}`);
} catch (err) {
  die(String(err.message ?? err));
}
