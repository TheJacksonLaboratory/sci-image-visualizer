// Random-access byte sources: a local file, or an HTTP(S) URL read with Range requests.
//
// Everything the Xenium reader does is "read N bytes at offset O" — zip central
// directories, zarr chunks, a few KB of JSON. Putting that behind one interface is what
// lets the same reader serve a 68 GB bundle from a local disk, from the 10x S3 bucket,
// or from a GCS bucket, with no download and no unzip.
//
// A `gs://bucket/key` URL is read through the GCS JSON API with a bearer token from
// `$GCS_TOKEN`, or from `gcloud auth print-access-token` if that is unset — private
// buckets are the normal case for sample data.

import { open, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * @typedef {object} ByteSource
 * @property {string} label           for error messages
 * @property {number} size            total bytes
 * @property {(offset: number, length: number) => Promise<Buffer>} read
 * @property {() => Promise<void>} close
 */

/** Open a byte source from a path or URL. */
export async function openByteSource(location) {
  if (/^https?:\/\//i.test(location)) return openHttp(location);
  if (location.startsWith('gs://')) return openGcs(location);
  return openFile(location);
}

async function openFile(file) {
  const fh = await open(file, 'r');
  const { size } = await fh.stat();
  return {
    label: file,
    size,
    async read(offset, length) {
      const buf = Buffer.allocUnsafe(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await fh.read(buf, done, length - done, offset + done);
        if (bytesRead === 0) throw new RangeError(`${file}: read past end at ${offset + done}`);
        done += bytesRead;
      }
      return buf;
    },
    close: () => fh.close(),
  };
}

/** Does `location` name something readable? Cheap: a stat or a HEAD. */
export async function byteSourceExists(location) {
  try {
    if (/^(https?|gs):/i.test(location)) {
      const src = await openByteSource(location);
      await src.close();
      return true;
    }
    return (await stat(location)).isFile();
  } catch {
    return false;
  }
}

let gcsToken;
let gcsTokenExpires = 0;

/**
 * A fresh access token: the GCP metadata server when running on GCP (Cloud Run, Cloud
 * Build, GKE, a VM), else the gcloud CLI. Tokens live an hour, so both are refreshed well
 * before that — a long extraction must not die at minute sixty.
 */
async function fetchGcsToken() {
  try {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(800) },
    );
    if (res.ok) {
      // The metadata server hands out a token part-way through its life: trust its own
      // `expires_in`, not an hour from now — the 401 that ended a two-hour build at minute 61.
      const body = await res.json();
      return { token: body.access_token, lifeMs: Math.max(60, Number(body.expires_in) || 0) * 1000 };
    }
  } catch {
    // Not on GCP.
  }
  const { stdout } = await run('gcloud', ['auth', 'print-access-token']);
  return { token: stdout.trim(), lifeMs: 45 * 60_000 };
}

async function gcsAuthHeader() {
  if (process.env.GCS_TOKEN) return { Authorization: `Bearer ${process.env.GCS_TOKEN}` };
  if (!gcsToken || Date.now() > gcsTokenExpires) {
    const { token, lifeMs } = await fetchGcsToken();
    gcsToken = token;
    // Refresh five minutes before it lapses (or half-way, for a token with little left).
    gcsTokenExpires = Date.now() + Math.max(lifeMs / 2, lifeMs - 5 * 60_000);
  }
  return { Authorization: `Bearer ${gcsToken}` };
}

/** Forget the token, so the next request fetches a new one (after a 401). */
function dropGcsToken() {
  gcsToken = undefined;
  gcsTokenExpires = 0;
}

function openGcs(url) {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(url);
  if (!m) throw new RangeError(`bad gs:// url: ${url}`);
  const media = `https://storage.googleapis.com/storage/v1/b/${m[1]}/o/${encodeURIComponent(m[2])}?alt=media`;
  return openHttp(media, { label: url, headers: gcsAuthHeader, onUnauthorized: dropGcsToken });
}

/** Range reads over HTTP(S); exported for tests. */
export async function openHttp(url, { label = url, headers = async () => ({}), onUnauthorized = null } = {}) {
  const head = await fetch(url, { headers: { ...(await headers()), Range: 'bytes=0-0' } });
  if (head.status !== 206) {
    throw new Error(`${label}: server does not honour Range requests (HTTP ${head.status})`);
  }
  await head.arrayBuffer();
  const size = Number(/\/(\d+)$/.exec(head.headers.get('content-range') ?? '')?.[1]);
  if (!Number.isFinite(size)) throw new Error(`${label}: no Content-Range total`);
  return {
    label,
    size,
    async read(offset, length) {
      if (length === 0) return Buffer.alloc(0);
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(url, {
            headers: { ...(await headers()), Range: `bytes=${offset}-${offset + length - 1}` },
          });
          if ((res.status === 401 || res.status === 403) && onUnauthorized) {
            // An expired token: fetch a new one and retry rather than fail the whole run.
            await res.arrayBuffer().catch(() => {});
            onUnauthorized();
            throw new Error(`HTTP ${res.status}`);
          }
          if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length !== length) throw new Error(`short read ${buf.length}/${length}`);
          return buf;
        } catch (err) {
          if (attempt >= 3) throw new Error(`${label}: range ${offset}+${length}: ${err.message}`);
          await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        }
      }
    },
    close: async () => {},
  };
}

/** A window [base, base+size) of another source — a stored member of a zip. */
export function sliceByteSource(src, base, size, label) {
  return {
    label: label ?? `${src.label}@${base}`,
    size,
    read(offset, length) {
      if (offset < 0 || offset + length > size) {
        return Promise.reject(new RangeError(`${this.label}: read ${offset}+${length} outside ${size}`));
      }
      return src.read(base + offset, length);
    },
    close: async () => {},
  };
}
