// Lightweight tile server implementing the subset of the sci-image-visualizer
// "slide-crop server" contract that the tiled (Mode A) render path exercises:
//
//   GET  /tiles/info?info=<b64>[&tileSize=]   -> TileDescriptor JSON (200 ready)
//   GET  /tile?info=<b64>&res=&col=&row=&z=&tileSize=[&channel=] -> image/png
//   POST /zoom/region  { info, roi, screen, zIndex }             -> image/png
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

const PORT = Number(process.env.PORT || 8090);
const COG_DIR = process.env.COG_DIR
  ? process.env.COG_DIR
  : new URL('./cogs', import.meta.url).pathname;

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
    const png = await readPreview(COG_DIR, image, String(req.query.tier || ''));
    res.set('Content-Type', 'image/png')
      .set('Cache-Control', 'public, max-age=86400')
      .send(png);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.post('/zoom/region', async (req, res) => {
  try {
    const { info, roi, screen } = req.body ?? {};
    const { image } = decodeInfo(info);
    if (!roi || typeof roi.width !== 'number') throw new Error('roi required');
    const png = await readRegion(COG_DIR, image, roi, screen);
    res.set('Content-Type', 'image/png').send(png);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
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
  console.log(`[tile-server] listening on :${PORT}  COG_DIR=${COG_DIR}`);
});
