// Headless smoke test: build the example first (`npm run build:example`), then
// `node examples/browser-image/smoke.mjs`. Serves the built dist and loads it in
// chromium, failing on any console/page error or if <visualizer> doesn't render.
//
// One exception, and it is deliberate: a 4xx from the configured TILE SERVER on a
// `spatial/` path is TOLERATED. The example's spatial gallery is data-driven — it asks
// `/spatial/datasets` at startup and shows whatever the server reports, catching a failure
// and simply offering no spatial entries. A tile server older than the spatial data plane
// is therefore a SUPPORTED configuration, not a broken build; the browser still logs the
// 404 as a console error, and failing on it blocks the Pages deploy over something the
// application handles by design. Anything else from that origin, and any 4xx from the
// locally served bundle, still fails.
// Catches white-page runtime failures (JIT-unavailable, CJS-interop, wrong Pages
// base) that a green build hides. Honors PAGES_BASE so it probes the SAME subpath
// the public deploy uses.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const config = fileURLToPath(new URL('./vite.config.mts', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 4173;
const BASE = process.env.PAGES_BASE || '/';
const URL_ = `http://localhost:${PORT}${BASE}`;
/** Origin of the tile server the built example talks to, if one is configured. */
const TILE_ORIGIN = (() => {
  try { return new URL(process.env.VITE_TILE_SERVER ?? '').origin; } catch { return null; }
})();

/** A spatial-data-plane request the example is designed to survive losing. */
function toleratedSpatial(url) {
  if (!TILE_ORIGIN || !url) return false;
  try {
    const u = new URL(url);
    return u.origin === TILE_ORIGIN && /(^|\/)spatial(\/|$)/.test(u.pathname);
  } catch { return false; }
}

const preview = spawn(
  'npx', ['vite', 'preview', '--config', config, '--port', String(PORT), '--strictPort'],
  { cwd: repoRoot, stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForServer(ms = 25000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    try { const r = await fetch(URL_); if (r.status === 200) return; } catch {}
    await sleep(500);
  }
  throw new Error('vite preview did not start');
}

let failed = false;
try {
  await waitForServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  const tolerated = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Playwright reports the failing request's URL as the message's location, which is
    // what lets an expected spatial 404 be told apart from a real script error.
    const at = m.location?.()?.url ?? '';
    if (toleratedSpatial(at)) { tolerated.push(at); return; }
    errors.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const bad = [];
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (r.status() >= 400 && u.host === `localhost:${PORT}` && !u.pathname.endsWith('/favicon.ico'))
      bad.push(`${r.status()} ${u.pathname}`);
  });
  await page.goto(URL_, { waitUntil: 'load', timeout: 30000 });
  let rendered = false;
  try { await page.waitForSelector('visualizer', { timeout: 15000 }); rendered = true; } catch {}
  const tiles = await page.locator('.gallery .tile').count();
  // PrimeNG overlay sanity: the plot-mode dropdown must open with options
  // (catches missing PrimeNG CSS / broken overlays that render blank).
  let overlayOpts = 0;
  try {
    await page.locator('p-dropdown').first().click({ timeout: 5000 });
    await page.waitForSelector('.p-dropdown-panel', { timeout: 5000 });
    overlayOpts = await page.locator('.p-dropdown-item').count();
  } catch {}
  // Splitter: dragging the divider right must widen the gallery (and, since the
  // viewer flexes, shrink the canvas). Verifies the resize wiring end-to-end.
  let resizeDelta = 0;
  try {
    await page.keyboard.press('Escape').catch(() => {}); // dismiss any open overlay
    const box = await page.locator('.splitter').boundingBox();
    const before = (await page.locator('.gallery').boundingBox()).width;
    const cy = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, cy);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, cy, { steps: 10 });
    await page.mouse.up();
    const after = (await page.locator('.gallery').boundingBox()).width;
    resizeDelta = Math.round(after - before);
  } catch {}
  // After widening, the gallery must stay two equal columns with NO horizontal
  // scroll (regression: long filenames pinned the right column and forced a
  // horizontal scrollbar, so the right column didn't resize with the left).
  let hOverflow = 999, colSkew = 999;
  try {
    const m = await page.evaluate(() => {
      const g = document.querySelector('.gallery');
      const t = [...document.querySelectorAll('.gallery .tile .thumb')].slice(0, 2);
      return {
        overflow: g.scrollWidth - g.clientWidth,
        w0: t[0] ? t[0].getBoundingClientRect().width : 0,
        w1: t[1] ? t[1].getBoundingClientRect().width : 0,
      };
    });
    hOverflow = Math.round(m.overflow);
    colSkew = Math.round(Math.abs(m.w0 - m.w1));
  } catch {}
  // DICOM: open the micro-ct folder and load a single slice — guards the
  // client-side dicom-parser decode path (browser DICOM → grayscale PNG).
  let dcmTiles = 0, dcmSliceOk = false;
  try {
    await page.locator('.tile.folder').first().click();
    await page.waitForSelector('.dcm-tile', { timeout: 8000 });
    dcmTiles = await page.locator('.dcm-tile').count();
    const before = errors.length;
    await page.locator('.dcm-tile').nth(Math.floor(dcmTiles / 2)).click();
    await sleep(2500);
    dcmSliceOk = errors.length === before;
  } catch {}
  await page.screenshot({ path: '/tmp/smoke.png', fullPage: true }).catch(() => {});
  await browser.close();
  console.log(`base: ${BASE} | rendered: ${rendered} | tiles: ${tiles} | dropdown: ${overlayOpts} | resize Δ: ${resizeDelta}px | h-overflow: ${hOverflow}px | col skew: ${colSkew}px | dcm tiles: ${dcmTiles} | dcm slice ok: ${dcmSliceOk}`);
  if (tolerated.length) {
    // Reported, not silenced: the demo will show no spatial-omics folder until the tile
    // server serves these routes, and that is worth seeing in the build log.
    console.log('TOLERATED (tile server has no spatial data plane):\n  '
      + [...new Set(tolerated)].join('\n  '));
  }
  if (errors.length) { console.log('ERRORS:\n  ' + errors.join('\n  ')); failed = true; }
  if (bad.length) { console.log('BAD RESPONSES (missing assets):\n  ' + [...new Set(bad)].join('\n  ')); failed = true; }
  if (!rendered) { console.log('FAIL: <visualizer> did not render'); failed = true; }
  if (!overlayOpts) { console.log('FAIL: plot-mode dropdown overlay did not open'); failed = true; }
  if (resizeDelta < 80) { console.log(`FAIL: splitter did not resize the gallery (Δ=${resizeDelta}px)`); failed = true; }
  if (hOverflow > 2) { console.log(`FAIL: gallery overflows horizontally (${hOverflow}px)`); failed = true; }
  if (colSkew > 2) { console.log(`FAIL: gallery columns unequal (skew ${colSkew}px)`); failed = true; }
  if (dcmTiles < 1) { console.log('FAIL: micro-ct folder did not open with DICOM slices'); failed = true; }
  if (!dcmSliceOk) { console.log('FAIL: loading a DICOM slice errored'); failed = true; }
  if (!failed) console.log('SMOKE OK');
} catch (e) {
  console.log('SMOKE ERROR:', e.message);
  failed = true;
} finally {
  preview.kill('SIGTERM');
}
process.exit(failed ? 1 : 0);
