/**
 * A real server, on a real socket, for the route tests.
 *
 * In process would be simpler, but `server.mjs` calls `app.listen` at import time and
 * reads its directories from the environment at module scope — so one import per test
 * would be one server per test, all on the same port, with no way to vary the layout.
 * Spawning is what lets each test own a directory tree.
 *
 * The point of testing through the socket rather than calling the handlers is that the
 * bugs here live in the URL: what `express` decodes, what `path.join` does with it, and
 * what the route hands to the filesystem. A helper called directly would not exercise any
 * of that.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));

/** A port the OS has just confirmed is free. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** The info token the tile routes take: base64url of `{"image": ...}`. */
export function infoToken(image) {
  return Buffer.from(JSON.stringify({ image }), 'utf8').toString('base64url');
}

/**
 * Start a server over a fresh temp tree and return `{ url, dir, stop }`.
 *
 * `dir` is the PARENT of the served directories, so a test can put a file next to
 * $COG_DIR and check that no request reaches it.
 */
export async function startServer(env = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tile-server-test-'));
  for (const name of ['cogs', 'spatial', 'stores', 'st', 'abc', 'h5ad']) {
    await mkdir(path.join(dir, name), { recursive: true });
  }
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      COG_DIR: path.join(dir, 'cogs'),
      SPATIAL_DIR: path.join(dir, 'spatial'),
      ZARR_DIR: path.join(dir, 'stores'),
      ST_DIR: path.join(dir, 'st'),
      ABC_DIR: path.join(dir, 'abc'),
      H5AD_DIR: path.join(dir, 'h5ad'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (b) => logs.push(String(b)));
  child.stderr.on('data', (b) => logs.push(String(b)));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited (${child.exitCode}):\n${logs.join('')}`);
    }
    try {
      const res = await fetch(`${url}/`);
      if (res.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`server never came up:\n${logs.join('')}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const stop = async () => {
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    await rm(dir, { recursive: true, force: true });
  };
  return { url, dir, stop, logs };
}

/** Write the smallest bundle the spatial routes will serve a manifest for. */
export async function writeBundle(spatialDir, id, overrides = {}) {
  const out = path.join(spatialDir, id);
  await mkdir(out, { recursive: true });
  const manifest = {
    version: 1, id, name: id, count: 2, columns: [], ...overrides,
  };
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}
