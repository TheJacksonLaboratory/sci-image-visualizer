// Headless smoke test: build the example first (`npm run build:example`), then
// `node examples/browser-image/smoke.mjs`. Serves the built dist and loads it in
// chromium, failing on any console/page error or if <visualizer> doesn't render.
// Catches white-page runtime failures (JIT-unavailable, CJS-interop) that a green
// build hides.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const config = fileURLToPath(new URL('./vite.config.mts', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 4173;
const URL_ = `http://localhost:${PORT}/`;

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
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
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
  await page.screenshot({ path: '/tmp/smoke.png', fullPage: true }).catch(() => {});
  await browser.close();
  console.log(`rendered <visualizer>: ${rendered} | gallery tiles: ${tiles} | dropdown options: ${overlayOpts}`);
  if (errors.length) { console.log('ERRORS:\n  ' + errors.join('\n  ')); failed = true; }
  if (bad.length) { console.log('BAD RESPONSES (missing assets):\n  ' + [...new Set(bad)].join('\n  ')); failed = true; }
  if (!rendered) { console.log('FAIL: <visualizer> did not render'); failed = true; }
  if (!overlayOpts) { console.log('FAIL: plot-mode dropdown overlay did not open'); failed = true; }
  if (!failed) console.log('SMOKE OK');
} catch (e) {
  console.log('SMOKE ERROR:', e.message);
  failed = true;
} finally {
  preview.kill('SIGTERM');
}
process.exit(failed ? 1 : 0);
