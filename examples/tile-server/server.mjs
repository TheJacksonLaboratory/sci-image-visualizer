// Lightweight tile server implementing the subset of the sci-image-visualizer
// "slide-crop server" contract that the tiled (Mode A) render path exercises:
//
//   GET  /tiles/info?info=<b64>[&tileSize=]   -> TileDescriptor JSON (200 ready)
//   GET  /tile?info=<b64>&res=&col=&row=&z=&tileSize=[&channel=] -> image/png
//   POST /zoom/region  { info, roi, screen, zIndex }             -> image/png
//
// …plus the SPATIAL-OMICS data plane the library's SpatialDataHttpService
// speaks (see src/lib/implementations/spatial-data-http/spatial-wire.ts):
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
import path from 'node:path';
import sharp from 'sharp';

const pathJoin = path.join;
const sharpFor = (raw, width, height) => sharp(raw, { raw: { width, height, channels: 3 } });
import { loadDescriptor, readTile, readRegion, readPreview, listImages } from './lib/cog.mjs';
import {
  listSpatialDatasets, loadManifest, openWireFile, readIds, readColumn,
  readFeatureVector, searchFeatures,
} from './lib/spatial.mjs';
import {
  listZarrDatasets, zarrManifest, zarrCoords, zarrRadius, zarrIds, zarrColumn,
  zarrFeature, zarrFeatureSearch, zarrPolygons, zarrImageSource,
} from './lib/spatial-zarr.mjs';
import {
  listStDatasets, stManifest, stCoords, stIds, stColumn, stFeature, stFeatureSearch, stImage,
} from './lib/spatial-st.mjs';
import { writePyramid } from './lib/pyramid.mjs';
import {
  listAbcDatasets, abcManifest, abcCoords, abcColumn, abcFeature, abcFeatureSearch, abcVolume,
} from './lib/spatial-abc.mjs';
import { readArray } from './lib/zarr3.mjs';

const PORT = Number(process.env.PORT || 8090);
const COG_DIR = process.env.COG_DIR
  ? process.env.COG_DIR
  : new URL('./cogs', import.meta.url).pathname;
const SPATIAL_DIR = process.env.SPATIAL_DIR
  ? process.env.SPATIAL_DIR
  : new URL('./spatial', import.meta.url).pathname;
// Directory of SpatialData *.zarr stores, served LIVE — no build step. Each
// (store, table, region) triple becomes a dataset.
const ZARR_DIR = process.env.ZARR_DIR
  ? process.env.ZARR_DIR
  : new URL('./stores', import.meta.url).pathname;
// Directory of LEGACY Spatial Transcriptomics bundles (gzipped TSV counts +
// HE JPEGs + spot-selection tables), one sub-directory each. See lib/spatial-st.mjs.
const ST_DIR = process.env.ST_DIR
  ? process.env.ST_DIR
  : new URL('./st', import.meta.url).pathname;
// Allen Brain Cell Atlas CSVs — the only 3D source here (see lib/spatial-abc.mjs
// and scripts/fetch-abc.mjs). Absent unless someone has run the fetch script.
const ABC_DIR = process.env.ABC_DIR
  ? process.env.ABC_DIR
  : new URL('./abc', import.meta.url).pathname;

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

/**
 * Materialise a Zarr-backed dataset's tissue image into $COG_DIR the first time
 * it is asked for, so OSD's tile path is unchanged and only the first request
 * pays. `<datasetId>-tissue` is the id `zarrManifest` advertises.
 */
const pyramidJobs = new Map();
async function ensureZarrImage(imageId) {
  if (!imageId.endsWith('-tissue')) return;
  const datasetId = imageId.slice(0, -'-tissue'.length);
  try {
    await loadDescriptor(COG_DIR, imageId);
    return; // already built
  } catch { /* fall through and build */ }

  // One build per image, even under concurrent tile requests.
  if (!pyramidJobs.has(imageId)) {
    pyramidJobs.set(imageId, (async () => {
      // A Zarr store holds the image as a cyx array; a legacy ST bundle holds a
      // JPEG. Try each, and let the error surface if neither owns this id.
      let source;
      try {
        source = { kind: 'zarr', ...(await zarrImageSource(ZARR_DIR, datasetId)) };
      } catch {
        source = { kind: 'st', ...(await stImage(ST_DIR, datasetId)) };
      }
      console.log(`[tile-server] building pyramid for ${imageId} from ${source.kind}`);

      let input;
      let width;
      let height;
      if (source.kind === 'zarr') {
        const img = await readArray(source.root, `images/${source.imageName}/${source.levelPath}`);
        const [bands, h, w] = img.shape;
        width = w;
        height = h;
        const rgb = Buffer.allocUnsafe(width * height * 3);
        const plane = width * height;
        for (let p = 0; p < plane; p++) {
          rgb[p * 3] = img.data[p];
          rgb[p * 3 + 1] = bands > 1 ? img.data[plane + p] : img.data[p];
          rgb[p * 3 + 2] = bands > 2 ? img.data[2 * plane + p] : img.data[p];
        }
        input = sharpFor(rgb, width, height);
      } else {
        input = sharp(source.bytes, { limitInputPixels: false });
        const meta = await input.metadata();
        width = meta.width;
        height = meta.height;
      }
      await writePyramid(pathJoin(COG_DIR, imageId), input,
        { width, height, mppX: source.mpp, mppY: source.mpp });
      console.log(`[tile-server] pyramid ready: ${imageId} (${width}x${height})`);
    })().finally(() => pyramidJobs.delete(imageId)));
  }
  await pyramidJobs.get(imageId);
}

app.get('/tiles/info', async (req, res) => {
  try {
    const { image } = decodeInfo(req.query.info);
    await ensureZarrImage(image).catch(() => undefined);
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
    // A client that jumps straight to /tile still gets a built pyramid.
    await ensureZarrImage(image).catch(() => undefined);
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
//
// TWO SOURCES, one wire format:
//   * $ZARR_DIR   — SpatialData *.zarr stores read LIVE (no build step). See
//                   lib/spatial-zarr.mjs for what that costs.
//   * $SPATIAL_DIR — pre-built bundles, for a synthetic demo or a dataset
//                   someone converted deliberately.
// A bundle wins when both offer the same id, so a pre-built one can override.

/** RangeError (bad id / unknown name) and ENOENT are 404s; anything else 400. */
function spatialError(res, err) {
  if (err instanceof RangeError || err?.code === 'ENOENT') {
    return res.status(404).json({ error: String(err?.message || err) });
  }
  return res.status(400).json({ error: String(err?.message || err) });
}

const octet = (res) => res
  .set('Content-Type', 'application/octet-stream')
  .set('Cache-Control', 'public, max-age=3600');

/**
 * Which source owns an id, resolved by asking each for a manifest in priority
 * order and cached. Priority is bundle > zarr > st, so a deliberately-converted
 * bundle can override a live source of the same name.
 */
const sourceOf = new Map();
async function resolveSource(id) {
  const cached = sourceOf.get(id);
  if (cached) return cached;
  for (const [name, probe] of [
    ['bundle', () => loadManifest(SPATIAL_DIR, id)],
    ['zarr', () => zarrManifest(ZARR_DIR, id)],
    ['st', () => stManifest(ST_DIR, id)],
    ['abc', () => abcManifest(ABC_DIR, id)],
  ]) {
    try {
      await probe();
      sourceOf.set(id, name);
      return name;
    } catch {
      // Not this one; try the next.
    }
  }
  throw new RangeError(`unknown dataset: ${id}`);
}

/**
 * Dispatch one route to whichever source owns the id. Keeping the choice here
 * rather than in each route means the sources cannot drift in which paths they
 * answer.
 */
async function fromSource(res, id, handlers) {
  try {
    const source = await resolveSource(id);
    const handler = handlers[source];
    if (!handler) throw new RangeError(`${source} source cannot serve this path`);
    await handler();
  } catch (err) {
    spatialError(res, err);
  }
}

app.get('/spatial/datasets', async (_req, res) => {
  try {
    const [bundles, stores, st, abc] = await Promise.all([
      listSpatialDatasets(SPATIAL_DIR),
      listZarrDatasets(ZARR_DIR).catch(() => []),
      listStDatasets(ST_DIR).catch(() => []),
      listAbcDatasets(ABC_DIR).catch(() => []),
    ]);
    const seen = new Set();
    const datasets = [];
    // Priority order, first id wins.
    for (const list of [bundles, stores, st, abc]) {
      for (const d of list) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        datasets.push(d);
      }
    }
    res.json({ datasets });
  } catch (err) {
    spatialError(res, err);
  }
});

app.get('/spatial/:id/manifest', async (req, res) => {
  const { id } = req.params;
  await fromSource(res, id, {
    bundle: async () => res.set('Cache-Control', 'public, max-age=3600')
      .json(await loadManifest(SPATIAL_DIR, id)),
    zarr: async () => res.json(await zarrManifest(ZARR_DIR, id)),
    st: async () => res.json(await stManifest(ST_DIR, id)),
    abc: async () => res.json(await abcManifest(ABC_DIR, id)),
  });
});

// coords.bin / radius.bin / polygons.bin are written by the converter in the
// exact byte layout the client decodes, so the bundle path is a file stream; the
// Zarr path assembles the same bytes on demand.
// A legacy ST dataset has uniform spot radii and no outlines, so it answers
// only `coords` — `radius` and `polygons` legitimately 404 there.
const WIRE_FILES = {
  coords: { file: 'coords.bin', zarr: zarrCoords, st: stCoords, abc: abcCoords },
  // The anatomical volume a 3D cloud sits inside: uint8 scalar field, x-fastest.
  // Only the ABC source has one, so every other source legitimately 404s here.
  volume: { file: 'volume.bin', abc: abcVolume },
  radius: { file: 'radius.bin', zarr: zarrRadius },
  polygons: { file: 'polygons.bin', zarr: zarrPolygons },
};
for (const [route, { file, zarr, st, abc }] of Object.entries(WIRE_FILES)) {
  app.get(`/spatial/:id/${route}`, async (req, res) => {
    const { id } = req.params;
    await fromSource(res, id, {
      bundle: async () => {
        const { stream, size } = await openWireFile(SPATIAL_DIR, id, file);
        octet(res).set('Content-Length', String(size));
        stream.pipe(res);
      },
      zarr: async () => octet(res).send(await zarr(ZARR_DIR, id)),
      ...(st ? { st: async () => octet(res).send(await st(ST_DIR, id)) } : {}),
      ...(abc ? { abc: async () => octet(res).send(await abc(ABC_DIR, id)) } : {}),
    });
  });
}

app.get('/spatial/:id/ids', async (req, res) => {
  const { id } = req.params;
  await fromSource(res, id, {
    bundle: async () => res.set('Cache-Control', 'public, max-age=3600')
      .json(await readIds(SPATIAL_DIR, id)),
    zarr: async () => res.json(await zarrIds(ZARR_DIR, id)),
    st: async () => res.json(await stIds(ST_DIR, id)),
  });
});

app.get('/spatial/:id/column/:name', async (req, res) => {
  const { id, name } = req.params;
  await fromSource(res, id, {
    bundle: async () => octet(res).send(await readColumn(SPATIAL_DIR, id, name)),
    zarr: async () => octet(res).send(await zarrColumn(ZARR_DIR, id, name)),
    st: async () => octet(res).send(await stColumn(ST_DIR, id, name)),
    abc: async () => octet(res).send(await abcColumn(ABC_DIR, id, name)),
  });
});

app.get('/spatial/:id/feature/:name', async (req, res) => {
  const { id, name } = req.params;
  await fromSource(res, id, {
    bundle: async () => octet(res).send(await readFeatureVector(SPATIAL_DIR, id, name)),
    zarr: async () => octet(res).send(await zarrFeature(ZARR_DIR, id, name)),
    st: async () => octet(res).send(await stFeature(ST_DIR, id, name)),
    abc: async () => octet(res).send(await abcFeature(ABC_DIR, id, name)),
  });
});

app.get('/spatial/:id/features', async (req, res) => {
  const { id } = req.params;
  const limit = intParam(req.query.limit, 50);
  await fromSource(res, id, {
    bundle: async () => res.json({ names: await searchFeatures(SPATIAL_DIR, id, req.query.q, limit) }),
    zarr: async () => res.json({ names: await zarrFeatureSearch(ZARR_DIR, id, req.query.q, limit) }),
    st: async () => res.json({ names: await stFeatureSearch(ST_DIR, id, req.query.q, limit) }),
    abc: async () => res.json({ names: await abcFeatureSearch(ABC_DIR, id, req.query.q, limit) }),
  });
});

// Health + discovery (handy for the example / smoke checks).
app.get('/', (_req, res) => res.json({ ok: true, service: 'tile-server' }));
app.get('/images', async (_req, res) => res.json({ images: await listImages(COG_DIR) }));

function intParam(v, dflt) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

app.listen(PORT, () => {
  console.log(`[tile-server] listening on :${PORT}`);
  console.log(`  COG_DIR=${COG_DIR}`);
  console.log(`  SPATIAL_DIR=${SPATIAL_DIR}  (pre-built bundles)`);
  console.log(`  ZARR_DIR=${ZARR_DIR}  (SpatialData stores, read live)`);
  console.log(`  ST_DIR=${ST_DIR}  (legacy Spatial Transcriptomics bundles)`);
});
