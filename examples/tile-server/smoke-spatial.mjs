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
  env: { ...process.env, PORT: String(PORT), SPATIAL_DIR },
  stdio: ['ignore', 'pipe', 'inherit'],
});
// Wait for the listen line before hitting the socket.
for await (const chunk of server.stdout) {
  if (String(chunk).includes('listening')) break;
}

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
