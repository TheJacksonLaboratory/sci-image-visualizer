// Screenshot placeholders for the user guide (docs/user-guide).
//
// docs/user-guide/screenshots.json lists every screenshot the guide shows, with the
// steps to reproduce it. This script writes a labelled placeholder PNG for each one
// whose file is missing, so the site builds (and shows what is still to capture)
// before the real screenshot exists. Placeholders carry a `siv-placeholder` PNG text
// chunk, which is how `--check` tells them apart from real screenshots.
//
//   node scripts/docs-placeholders.mjs           # write placeholders for missing files
//   node scripts/docs-placeholders.mjs --check   # list placeholders still to replace
//   node scripts/docs-placeholders.mjs --force   # rewrite every placeholder (not real shots)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// PNG chunk CRC (ISO 3309 / zlib CRC-32), table-driven. Not `node:zlib`'s `crc32`, which
// only exists from Node 20.15 / 22.2, below the package's `engines` floor (>=20.9.0).
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const root = fileURLToPath(new URL('../docs/user-guide/', import.meta.url));
const shotsDir = join(root, 'docs/assets/screenshots');
const manifest = JSON.parse(readFileSync(join(root, 'screenshots.json'), 'utf8'));
const MARKER = 'siv-placeholder';

const isPlaceholder = (file) => existsSync(file) && readFileSync(file).includes(Buffer.from(MARKER));

if (process.argv.includes('--check')) {
  const pending = manifest.shots.filter((s) => !existsSync(join(shotsDir, s.file)) || isPlaceholder(join(shotsDir, s.file)));
  for (const s of pending) console.log(`${s.id.padEnd(8)} ${s.file}  — ${s.title}`);
  console.log(`${manifest.shots.length - pending.length}/${manifest.shots.length} screenshots captured.`);
  process.exit(0);
}

const force = process.argv.includes('--force');
const todo = manifest.shots.filter((s) => {
  const file = join(shotsDir, s.file);
  return !existsSync(file) || (force && isPlaceholder(file));
});
if (!todo.length) {
  console.log('Every screenshot exists; nothing to do.');
  process.exit(0);
}

/** Insert a tEXt chunk just before IEND. */
function withMarker(png) {
  const data = Buffer.from(`Comment\0${MARKER}`, 'latin1');
  const type = Buffer.from('tEXt', 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0);
  const iend = png.length - 12;
  return Buffer.concat([png.subarray(0, iend), len, type, data, crc, png.subarray(iend)]);
}

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const { chromium } = await import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
for (const s of todo) {
  await page.setContent(`<!doctype html><html><body style="margin:0;font-family:system-ui,sans-serif">
    <div style="box-sizing:border-box;width:960px;height:540px;padding:48px;background:repeating-linear-gradient(45deg,#f3f4f6 0 24px,#e9ebef 24px 48px);display:flex;flex-direction:column;justify-content:center;gap:16px;color:#374151">
      <div style="font-size:18px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">Screenshot pending · ${esc(s.id)}</div>
      <div style="font-size:34px;font-weight:600">${esc(s.title)}</div>
      <div style="font-size:18px;color:#4b5563">${esc(s.capture ?? '')}</div>
      <div style="font-size:15px;color:#6b7280;font-family:ui-monospace,monospace">${esc(s.file)}</div>
    </div></body></html>`);
  const png = await page.screenshot({ type: 'png' });
  const out = join(shotsDir, s.file);
  if (!existsSync(dirname(out))) throw new Error(`missing folder for ${out}`);
  writeFileSync(out, withMarker(png));
  console.log(`placeholder  ${s.file}`);
}
await browser.close();
