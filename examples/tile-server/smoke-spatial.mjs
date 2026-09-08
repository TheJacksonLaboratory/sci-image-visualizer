// End-to-end smoke check for the spatial-omics endpoints.
//
//   node scripts/make-spatial-demo.mjs && node smoke-spatial.mjs
//
// Boots the real server on an ephemeral port and exercises every route,
// decoding the binary responses exactly as the library's `spatial-wire.ts`
// does — so a change to either side that breaks the wire format fails here
// rather than in a browser.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const ID = 'demo-brain';
const SPATIAL_DIR = new URL('./spatial', import.meta.url).pathname;
// The zarr path serves the same wire format from a store with NO build step, so it has to
// be covered by the same checks. `make-zarr-demo.mjs` writes one that needs no download.
const ZARR_DIR = new URL('./stores', import.meta.url).pathname;
const ZARR_ID = 'demo-zarr.table';
// A plain `.h5ad` needs no preparation at all, so it gets the same checks.
const H5AD_DIR = new URL('./h5ad', import.meta.url).pathname;

let failures = 0;
function check(label, ok, detail = '') {
  const mark = ok ? 'ok  ' : 'FAIL';
  if (!ok) failures++;
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function getJson(pathname) {
  const res = await fetch(`${BASE}${pathname}`);
  if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}`);
  return res.json();
}
async function getBuffer(pathname) {
  const res = await fetch(`${BASE}${pathname}`);
  if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}`);
  return res.arrayBuffer();
}

const server = spawn(process.execPath, [path.join(import.meta.dirname, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), SPATIAL_DIR, ZARR_DIR, H5AD_DIR },
  stdio: ['ignore', 'pipe', 'inherit'],
});
// Wait for the listen line before hitting the socket, then KEEP DRAINING the pipe.
//
// A plain `data` listener rather than `for await ... break`: breaking out of a for-await
// calls `return()` on the iterator, which DESTROYS the stream. The server logs while
// serving — building a pyramid, converting a CSR `.h5ad` — and writing to a destroyed or
// unread pipe kills it with EPIPE mid-request, which reads as the request failing rather
// than as the harness having shut the pipe.
await new Promise((resolve) => {
  const onData = (chunk) => {
    if (String(chunk).includes('listening')) resolve();
  };
  server.stdout.on('data', onData);
});

try {
  console.log('discovery');
  const { datasets } = await getJson('/spatial/datasets');
  check('lists the demo dataset', datasets.some((d) => d.id === ID),
    datasets.map((d) => d.id).join(', ') || '(none)');
  const summary = datasets.find((d) => d.id === ID);

  console.log('manifest');
  const manifest = await getJson(`/spatial/${ID}/manifest`);
  check('wire version is 1', manifest.version === 1, `got ${manifest.version}`);
  check('count agrees with discovery', manifest.count === summary.count);
  check('has a categorical and continuous column',
    manifest.columns.some((c) => c.kind === 'categorical')
    && manifest.columns.some((c) => c.kind === 'continuous'));
  const N = manifest.count;

  console.log('coords');
  const coords = await getBuffer(`/spatial/${ID}/coords`);
  check('length is 2 x N f32', coords.byteLength === N * 2 * 4,
    `${coords.byteLength} vs ${N * 2 * 4}`);
  const x = new Float32Array(coords, 0, N);
  const y = new Float32Array(coords, N * 4, N);
  check('coordinates are finite and positive',
    x.every(Number.isFinite) && y.every(Number.isFinite) && x[0] >= 0);

  console.log('ids');
  const { ids } = await getJson(`/spatial/${ID}/ids`);
  check('one id per observation', ids.length === N, `${ids.length} vs ${N}`);

  console.log('columns');
  const catMeta = manifest.columns.find((c) => c.kind === 'categorical');
  const catBuf = await getBuffer(`/spatial/${ID}/column/${catMeta.name}`);
  check(`categorical "${catMeta.name}" is u16[N]`, catBuf.byteLength === N * 2,
    `${catBuf.byteLength} vs ${N * 2}`);
  const codes = new Uint16Array(catBuf);
  check('every code indexes a real category',
    codes.every((c) => c < catMeta.categories.length));

  const contMeta = manifest.columns.find((c) => c.kind === 'continuous');
  const contBuf = await getBuffer(`/spatial/${ID}/column/${contMeta.name}`);
  check(`continuous "${contMeta.name}" is f32[N]`, contBuf.byteLength === N * 4);
  const values = new Float32Array(contBuf);
  check('values fall inside the manifest min/max',
    values.every((v) => v >= contMeta.min - 1e-3 && v <= contMeta.max + 1e-3));

  console.log('features');
  const gene = manifest.features.names[0];
  const featBuf = await getBuffer(`/spatial/${ID}/feature/${gene}`);
  check(`gene "${gene}" is f32[N]`, featBuf.byteLength === N * 4);
  check('expression is non-negative and finite',
    new Float32Array(featBuf).every((v) => Number.isFinite(v) && v >= 0));

  // The ranged read must land on the right gene: the last gene's bytes differ
  // from the first's, and both are exactly N floats.
  const lastGene = manifest.features.names.at(-1);
  const lastBuf = await getBuffer(`/spatial/${ID}/feature/${lastGene}`);
  check('a later gene is a distinct vector (ranged read hits the right offset)',
    lastBuf.byteLength === N * 4
    && Buffer.compare(Buffer.from(featBuf), Buffer.from(lastBuf)) !== 0);

  const search = await getJson(`/spatial/${ID}/features?q=t&limit=5`);
  check('feature search returns matches', Array.isArray(search.names) && search.names.length > 0,
    search.names.join(', '));

  console.log('polygons');
  const polyBuf = await getBuffer(`/spatial/${ID}/polygons`);
  const count = new Uint32Array(polyBuf, 0, 1)[0];
  const offsets = new Uint32Array(polyBuf, 4, count + 1);
  const vertexCount = offsets[count];
  const expected = 4 + (count + 1) * 4 + vertexCount * 2 * 4;
  check('ring count matches the manifest', count === manifest.polygons.count);
  check('blob length matches the offsets', polyBuf.byteLength === expected,
    `${polyBuf.byteLength} vs ${expected}`);
  check('offsets are monotonic',
    offsets.every((v, i) => i === 0 || v >= offsets[i - 1]));

  console.log('tissue image (the spatial dataset\'s imageRef target)');
  const imageId = manifest.imageRef?.imageId;
  check('manifest names a tissue image', !!imageId, String(imageId));
  const infoB64 = Buffer.from(JSON.stringify({ image: imageId })).toString('base64url');

  const desc = await getJson(`/tiles/info?info=${infoB64}`);
  check('descriptor has a pyramid', Array.isArray(desc.levels) && desc.levels.length > 1,
    `${desc.levels?.length} levels, ${desc.width}x${desc.height}`);
  check('res 0 is the full-size level',
    desc.levels[0].res === 0 && desc.levels[0].width === desc.width);

  const tile = await fetch(`${BASE}/tile?info=${infoB64}&res=0&col=0&row=0&tileSize=512&z=0`);
  check('serves a PNG tile', tile.ok && tile.headers.get('content-type') === 'image/png',
    `HTTP ${tile.status}`);

  // The affine is the thing most likely to be silently wrong, so check it
  // numerically: every spot, transformed, must land inside the image.
  const [sx, sy] = manifest.imageRef.scale ?? [1, 1];
  const [tx, ty] = manifest.imageRef.translate ?? [0, 0];
  let inside = 0;
  for (let i = 0; i < N; i++) {
    const ix = x[i] * sx + tx;
    const iy = y[i] * sy + ty;
    if (ix >= 0 && ix <= desc.width && iy >= 0 && iy <= desc.height) inside++;
  }
  check('every spot maps inside the image under imageRef', inside === N, `${inside}/${N}`);

  // A degenerate affine (everything squashed into one corner) would still pass
  // the bounds test, so also require the spots to span the image. The tissue is
  // an ellipse inscribed at 78% of the frame and spots exist only inside it, so
  // ~76% is the expected figure — not ~100%.
  const spanX = (Math.max(...x) - Math.min(...x)) * sx / desc.width;
  check('spots span the tissue-sized fraction of the image', spanX > 0.7 && spanX < 0.85,
    `${(spanX * 100).toFixed(0)}%`);

  // The 3D source is optional — it needs a ~1.9GB download — so probe it and skip
  // rather than fail when it is absent. When it IS there, hasZ and the third
  // coordinate block are the things worth pinning: a 2-block response silently
  // read as 3 would shear the whole cloud.
  console.log('3D source (skipped unless abc/ is populated)');
  const abcList = await (await fetch(`${BASE}/spatial/datasets`)).json();
  const abc = abcList.datasets.find((d) => d.id === 'abc.wholebrain.sub10');
  if (!abc) {
    console.log('  - not present (run npm run fetch-abc)');
  } else {
    const m = await (await fetch(`${BASE}/spatial/${abc.id}/manifest`)).json();
    check('3D manifest sets hasZ', m.hasZ === true, String(m.hasZ));
    check('3D manifest has no imageRef', !m.imageRef, JSON.stringify(m.imageRef));
    const buf = new Float32Array(
      await (await fetch(`${BASE}/spatial/${abc.id}/coords`)).arrayBuffer(),
    );
    check('coords carry THREE f32 blocks', buf.length === m.count * 3,
      `${buf.length} floats for ${m.count} obs`);
    // z must actually vary; a constant would mean the sections were stacked flat
    // rather than registered, which is the whole point of this dataset.
    const z = buf.subarray(m.count * 2, m.count * 3);
    let zlo = Infinity;
    let zhi = -Infinity;
    for (const v of z) {
      if (v < zlo) zlo = v;
      if (v > zhi) zhi = v;
    }
    check('z spans the brain, not one plane', zhi - zlo > 5000,
      `${(zlo / 1000).toFixed(1)}-${(zhi / 1000).toFixed(1)} mm`);
    // Cardinality decides which views a column can drive, not whether it is
    // servable: the 3D POINTS layer draws flat above 95 categories (its 256-entry
    // LUT cannot keep more apart), while the 2D markers and the per-cluster density
    // volumes have no such limit. So what matters is that a wide column arrives
    // COMPLETE — every category named, every colour present — since those are what
    // the views that can render it read.
    const cats = (m.columns || []).filter((c) => c.kind === 'categorical');
    const wide = cats.filter((c) => c.categories.length > 95);
    check('subclass is served, above the LUT ceiling, for the density volumes',
      wide.some((c) => c.name === 'subclass'),
      wide.map((c) => `${c.name}=${c.categories.length}`).join(', ') || 'none served');
    const ragged = cats.filter(
      (c) => c.categories.some((n) => !n && n !== '')
        || (c.colors && c.colors.length !== c.categories.length),
    );
    check('every categorical names every category, and colours match 1:1',
      ragged.length === 0, ragged.map((c) => c.name).join(', '));
    // A code has to fit the u16 the wire format sends it in.
    check('category counts fit the u16 code space',
      cats.every((c) => c.categories.length <= 65535));

    // The anatomical backdrop. Byte count against the declared dims is the check
    // that matters: a short or long buffer read as a 3D texture does not error,
    // it shears the anatomy into diagonal streaks.
    const vol = m.volume;
    check('3D manifest declares a reference volume', !!vol, JSON.stringify(vol));
    if (vol) {
      const bytes = await (await fetch(`${BASE}/spatial/${abc.id}/volume`)).arrayBuffer();
      const want = vol.width * vol.height * vol.depth;
      check('volume byte count matches its declared dims', bytes.byteLength === want,
        `${bytes.byteLength} vs ${want}`);
      // Voxel dims x size must reproduce the brain's real extent, or the cloud
      // and the anatomy are drawn at different scales.
      const mm = [vol.width, vol.height, vol.depth]
        .map((d, i) => (d * vol.voxelSize[i]) / 1000);
      check('volume extent is a mouse brain, in mm', mm.every((x) => x > 5 && x < 20),
        mm.map((x) => x.toFixed(1)).join(' x '));
    }
    const noVol = await fetch(`${BASE}/spatial/${ID}/volume`);
    check('a dataset without a volume 404s', noVol.status === 404, `got ${noVol.status}`);
  }

  // ── the zarr path, when a store is present ────────────────────────────────
  const zarrManifest = await fetch(`${BASE}/spatial/${ZARR_ID}/manifest`)
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!zarrManifest) {
    console.log('zarr store (skipped — run `node scripts/make-zarr-demo.mjs`)');
  } else {
    console.log('zarr store, read directly');
    const embeddings = zarrManifest.embeddings ?? [];
    // The whole point of the zarr path: what the source published is already there, so an
    // `obsm/X_umap` needs no conversion step to reach the client.
    check('obsm arrays are advertised as embeddings', embeddings.length >= 2,
      embeddings.map((e) => `${e.name}(${e.dims}D)`).join(', ') || 'none');
    check('the coordinates are not offered as one',
      !embeddings.some((e) => e.name === 'spatial'));
    for (const emb of embeddings) {
      const buf = await getBuffer(`/spatial/${ZARR_ID}/embedding/${emb.name}`);
      // Struct of arrays, f32, one plane per dimension — byte for byte what a bundle
      // serves, so the client cannot tell which source answered.
      check(`${emb.name} is ${emb.dims} f32 planes of ${zarrManifest.count}`,
        buf.byteLength === zarrManifest.count * emb.dims * 4,
        `${buf.byteLength} bytes`);
      const values = new Float32Array(buf);
      check(`${emb.name} coordinates are finite`,
        values.every((v) => Number.isFinite(v)));
    }
    const badEmbedding = await fetch(`${BASE}/spatial/${ZARR_ID}/embedding/X_nope`);
    check('unknown embedding is 404', badEmbedding.status === 404, `got ${badEmbedding.status}`);
    // A store column and a derived column of the same name would otherwise both be
    // declared, and the second would shadow real data with a k-means the server invented.
    const names = (zarrManifest.columns ?? []).map((c) => c.name);
    check('no column is declared twice', new Set(names).size === names.length,
      names.join(', '));
  }

  // ── a plain .h5ad, when one is present ───────────────────────────────────
  const h5adEntries = (await getJson('/spatial/datasets')).datasets
    .filter((d) => d.source === 'h5ad');
  if (h5adEntries.length === 0) {
    console.log('h5ad drop-in (skipped — no .h5ad in ./h5ad)');
  }
  // EVERY one of them: a CSC file is served straight out of the file and a CSR file
  // through a bundle built on first open, and the two must answer identically.
  for (const h5adEntry of h5adEntries) {
    const hid = h5adEntry.id;
    console.log(`h5ad drop-in (${hid})`);
    const m = await getJson(`/spatial/${hid}/manifest`);
    // Everything is INFERRED from the file: nothing was named on a command line.
    check('columns are inferred from obs', (m.columns ?? []).length > 0,
      `${m.columns.length} columns`);
    check('a categorical column carries its categories',
      (m.columns ?? []).some((c) => c.kind === 'categorical' && c.categories?.length > 0));
    check('genes are inferred from var', (m.features?.count ?? 0) > 0,
      `${m.features?.count} genes`);

    const coords = await getBuffer(`/spatial/${hid}/coords`);
    const dims = m.hasZ ? 3 : 2;
    check('coords are the declared dims of f32', coords.byteLength === m.count * dims * 4,
      `${coords.byteLength} bytes for ${m.count} x ${dims}`);
    if (m.hasIds) {
      const { ids } = await getJson(`/spatial/${hid}/ids`);
      // The labels are in every `.h5ad` as `obs/_index`; a converted bundle used to lose
      // them and 404 here while a directly-read one served them.
      check('ids are served, one per observation', ids?.length === m.count,
        `${ids?.length} of ${m.count}`);
    }
    for (const emb of m.embeddings ?? []) {
      const buf = await getBuffer(`/spatial/${hid}/embedding/${emb.name}`);
      check(`${emb.name} is ${emb.dims} f32 planes`,
        buf.byteLength === m.count * emb.dims * 4, `${buf.byteLength} bytes`);
    }
    const gene = m.features.names?.[0] ?? (await getJson(`/spatial/${hid}/features?limit=1`)).names[0];
    const vec = await getBuffer(`/spatial/${hid}/feature/${gene}`);
    check(`one gene is f32[N] — ${gene}`, vec.byteLength === m.count * 4,
      `${vec.byteLength} bytes`);
    // Prefix-first, so the two drop-in paths and the bundle rank suggestions alike.
    const hits = (await getJson(`/spatial/${hid}/features?q=${gene.slice(0, 2)}&limit=5`)).names;
    check('feature search returns prefix matches first',
      hits.length > 0 && hits[0].toLowerCase().startsWith(gene.slice(0, 2).toLowerCase()),
      hits.join(', '));
    const badGene = await fetch(`${BASE}/spatial/${hid}/feature/NotAGene`);
    check('unknown gene is 404', badGene.status === 404, `got ${badGene.status}`);
  }

  console.log('error handling');
  const notFound = await fetch(`${BASE}/spatial/${ID}/feature/NotAGene`);
  check('unknown gene is 404', notFound.status === 404, `got ${notFound.status}`);
  const badColumn = await fetch(`${BASE}/spatial/${ID}/column/nope`);
  check('unknown column is 404', badColumn.status === 404, `got ${badColumn.status}`);
  const traversal = await fetch(`${BASE}/spatial/..%2F..%2Fetc/manifest`);
  check('path traversal is refused', traversal.status === 404, `got ${traversal.status}`);
  const missing = await fetch(`${BASE}/spatial/no-such-dataset/manifest`);
  check('unknown dataset is 404', missing.status === 404, `got ${missing.status}`);
} finally {
  server.kill();
  await once(server, 'exit').catch(() => undefined);
}

console.log(failures === 0 ? '\nspatial smoke: PASS' : `\nspatial smoke: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
