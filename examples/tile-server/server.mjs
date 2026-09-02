// Lightweight tile server implementing the subset of the sci-image-visualizer
// "slide-crop server" contract that the tiled (Mode A) render path exercises:
//
//   GET  /tiles/info?info=<b64>[&tileSize=]   -> TileDescriptor JSON (200 ready)
//   GET  /tile?info=<b64>&res=&col=&row=&z=&tileSize=[&channel=] -> image/png
//   POST /zoom/region  { info, roi, screen, zIndex }             -> image/png
//
// …plus the SPATIAL-OMICS data plane the library's SpatialDataHttpService
// speaks (see src/lib/implementations/spatial/spatial-wire.ts):
//
//   GET  /spatial/datasets                    -> { datasets: [...] }
//   GET  /spatial/:id/manifest                -> manifest JSON
//   GET  /spatial/:id/{coords,radius,polygons}-> raw little-endian typed arrays
//   GET  /spatial/:id/ids                     -> { ids: [...] }
//   GET  /spatial/:id/column/:name            -> u16 codes | f32 values
//   GET  /spatial/:id/feature/:name           -> f32 vector (ranged read)
//   GET  /spatial/:id/features?q=&limit=      -> { names: [...] }
//
// The `info` param is an OPAQUE, URL-safe base64 token minted by the browser
// example's host adapter (ServerTileAccessAdapter). Here it decodes to
// `{ image: "<imageId>" }` naming a pyramid under $COG_DIR. The library never
// inspects it — the host and this server agree on its shape.
//
// Histogram / export/tiff are only needed for >8-bit images; these demo slides
// are 8-bit RGB brightfield, so they are intentionally omitted (the library only
// calls them when channelInfo reports bitDepth > 8).

import express from 'express';
import cors from 'cors';
import { loadDescriptor, readTile, readRegion, readPreview, listImages } from './lib/cog.mjs';
import {
  listSpatialDatasets, loadManifest, openWireFile, readIds, readColumn,
  readFeatureVector, searchFeatures,
} from './lib/spatial.mjs';

const PORT = Number(process.env.PORT || 8090);
const COG_DIR = process.env.COG_DIR
  ? process.env.COG_DIR
  : new URL('./cogs', import.meta.url).pathname;
const SPATIAL_DIR = process.env.SPATIAL_DIR
  ? process.env.SPATIAL_DIR
  : new URL('./spatial', import.meta.url).pathname;

const app = express();

// OpenSeadragon's tile loader sets ajaxWithCredentials:true, which forbids a
// wildcard ACAO — echo the request origin and allow credentials. For a public,
// unauthenticated demo this is harmless; a real deployment would restrict origin.
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

function decodeInfo(raw) {
  const b64 = String(raw ?? '');
  const json = Buffer.from(b64, 'base64url').toString('utf8');
  const info = JSON.parse(json);
  if (!info || typeof info.image !== 'string') throw new Error('info missing "image"');
  return info;
}

app.get('/tiles/info', async (req, res) => {
  try {
    const { image } = decodeInfo(req.query.info);
    const desc = await loadDescriptor(COG_DIR, image);
    // Pyramids are pre-generated, so the descriptor is always ready (200). A
    // server that lazily fetched the source from a bucket would return 202 here
    // while caching, and the library would poll until 200.
    res.set('Cache-Control', 'public, max-age=86400').json(desc);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.get('/tile', async (req, res) => {
  try {
    const { image } = decodeInfo(req.query.info);
    const png = await readTile(
      COG_DIR,
      image,
      intParam(req.query.res, 0),
      intParam(req.query.col, 0),
      intParam(req.query.row, 0),
      intParam(req.query.tileSize, 512),
      // Absent for a flat composite; set per request by the library's
      // per-channel path so each band can be tinted/windowed client-side.
      req.query.channel === undefined ? undefined : intParam(req.query.channel, 0),
      // Slice index for a z-stack (ignored for a single-slice image).
      intParam(req.query.z, 0),
    );
    res.set('Content-Type', 'image/png')
      .set('Cache-Control', 'public, max-age=86400')
      .send(png);
  } catch (err) {
    if (err instanceof RangeError) return res.status(404).end();
    res.status(400).json({ error: String(err?.message || err) });
  }
});

// Flat downsampled preview — the Plotly heatmap's source (IImageInfo.urls[0]).
app.get('/preview', async (req, res) => {
  try {
    const { image } = decodeInfo(req.query.info);
    const png = await readPreview(
      COG_DIR,
      image,
      String(req.query.tier || ''),
      req.query.z === undefined ? undefined : intParam(req.query.z, 0),
    );
    res.set('Content-Type', 'image/png')
      .set('Cache-Control', 'public, max-age=86400')
      .send(png);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.post('/zoom/region', async (req, res) => {
  try {
    const { info, roi, screen, zIndex } = req.body ?? {};
    const { image } = decodeInfo(info);
    if (!roi || typeof roi.width !== 'number') throw new Error('roi required');
    const png = await readRegion(COG_DIR, image, roi, screen, zIndex);
    res.set('Content-Type', 'image/png').send(png);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

// ── Spatial-omics data plane ────────────────────────────────────────────────
// Vectors are served as raw little-endian bytes: one Float32Array/Uint16Array
// per request, decoded by a typed-array view on the client with no copy. JSON
// would cost ~8-12x the bytes and a parse that allocates a JS number per value.

/** RangeError (bad id / unknown name) and ENOENT are 404s; anything else is a 400. */
function spatialError(res, err) {
  if (err instanceof RangeError || err?.code === 'ENOENT') {
    return res.status(404).json({ error: String(err?.message || err) });
  }
  return res.status(400).json({ error: String(err?.message || err) });
}

/** Stream a file that is already in wire layout — no parse, no transform. */
async function sendWireFile(res, id, name) {
  const { stream, size } = await openWireFile(SPATIAL_DIR, id, name);
  res.set('Content-Type', 'application/octet-stream')
    .set('Content-Length', String(size))
    .set('Cache-Control', 'public, max-age=3600');
  stream.pipe(res);
}

app.get('/spatial/datasets', async (_req, res) => {
  try {
    res.json({ datasets: await listSpatialDatasets(SPATIAL_DIR) });
  } catch (err) {
    spatialError(res, err);
  }
});

app.get('/spatial/:id/manifest', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=3600')
      .json(await loadManifest(SPATIAL_DIR, req.params.id));
  } catch (err) {
    spatialError(res, err);
  }
});

// coords.bin / radius.bin / polygons.bin are written by the converter in the
// exact byte layout the client decodes, so serving them is a file stream.
for (const [route, file] of [['coords', 'coords.bin'], ['radius', 'radius.bin'], ['polygons', 'polygons.bin']]) {
  app.get(`/spatial/:id/${route}`, async (req, res) => {
    try {
      await sendWireFile(res, req.params.id, file);
    } catch (err) {
      spatialError(res, err);
    }
  });
}

app.get('/spatial/:id/ids', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=3600')
      .json(await readIds(SPATIAL_DIR, req.params.id));
  } catch (err) {
    spatialError(res, err);
  }
});

app.get('/spatial/:id/column/:name', async (req, res) => {
  try {
    const buf = await readColumn(SPATIAL_DIR, req.params.id, req.params.name);
    res.set('Content-Type', 'application/octet-stream')
      .set('Cache-Control', 'public, max-age=3600')
      .send(buf);
  } catch (err) {
    spatialError(res, err);
  }
});

app.get('/spatial/:id/feature/:name', async (req, res) => {
  try {
    const buf = await readFeatureVector(SPATIAL_DIR, req.params.id, req.params.name);
    res.set('Content-Type', 'application/octet-stream')
      .set('Cache-Control', 'public, max-age=3600')
      .send(buf);
  } catch (err) {
    spatialError(res, err);
  }
});

app.get('/spatial/:id/features', async (req, res) => {
  try {
    const names = await searchFeatures(
      SPATIAL_DIR, req.params.id, req.query.q, intParam(req.query.limit, 50),
    );
    res.json({ names });
  } catch (err) {
    spatialError(res, err);
  }
});

// Health + discovery (handy for the example / smoke checks).
app.get('/', (_req, res) => res.json({ ok: true, service: 'tile-server' }));
app.get('/images', async (_req, res) => res.json({ images: await listImages(COG_DIR) }));

function intParam(v, dflt) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

app.listen(PORT, () => {
  console.log(`[tile-server] listening on :${PORT}  COG_DIR=${COG_DIR}  SPATIAL_DIR=${SPATIAL_DIR}`);
});
