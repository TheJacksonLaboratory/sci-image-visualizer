// Local dev check for the TILED (Mode A) path (not run in CI — needs a tile
// server + COGs). Companion to smoke.mjs (which covers the serverless path). Assumes a tile server is
// running at VITE_TILE_SERVER (default http://localhost:8090/) with a `cmu-1`
// pyramid, and that the example was BUILT with that env. Serves the built dist,
// loads the CMU-1 gigapixel entry, and asserts OSD fetched /tiles/info + /tile.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const config = fileURLToPath(new URL('./vite.config.mts', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const TILES = process.env.VITE_TILE_SERVER || 'http://localhost:8090/';
const PORT = 4173;
const URL_ = `http://localhost:${PORT}/`;

const preview = spawn('npx', ['vite', 'preview', '--config', config, '--port', String(PORT), '--strictPort'],
  { cwd: repoRoot, stdio: 'ignore' });
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
  const tileReqs = { info: 0, tile: 0, statuses: new Set() };
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/tiles/info')) { tileReqs.info++; tileReqs.statuses.add(r.status()); }
    else if (u.includes('/tile?')) { tileReqs.tile++; tileReqs.statuses.add(r.status()); }
  });

  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForSelector('visualizer', { timeout: 15000 });

  // The tiled gallery entry (CMU-1) — a .tile whose name contains "CMU-1".
  const cmu = page.locator('.tile', { hasText: 'CMU-1' }).first();
  const tiledTileVisible = await cmu.count();
  await cmu.click();

  // Give OSD time to poll /tiles/info and fetch tiles across a couple of levels.
  await sleep(6000);
  const canvasCount = await page.locator('.viewer canvas').count();
  await page.screenshot({ path: '/tmp/tiled-cmu1.png' });

  console.log(`tiled entry present: ${tiledTileVisible} | tiles/info reqs: ${tileReqs.info} | tile reqs: ${tileReqs.tile} | statuses: ${[...tileReqs.statuses]} | viewer canvases: ${canvasCount}`);
  if (!tiledTileVisible) { console.log('FAIL: no CMU-1 tiled entry'); failed = true; }
  if (tileReqs.info < 1) { console.log('FAIL: OSD never polled /tiles/info'); failed = true; }
  if (tileReqs.tile < 4) { console.log('FAIL: too few /tile fetches (expected many)'); failed = true; }
  if (errors.length) { console.log('ERRORS:\n  ' + errors.join('\n  ')); failed = true; }
  await browser.close();
} catch (e) {
  console.error('check crashed:', e.message); failed = true;
} finally {
  preview.kill('SIGTERM');
}
console.log(failed ? 'TILED CHECK: FAIL' : 'TILED CHECK: PASS');
process.exit(failed ? 1 : 0);
