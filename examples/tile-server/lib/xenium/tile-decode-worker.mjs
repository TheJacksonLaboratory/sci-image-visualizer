// Worker: decode TIFF tiles (JPEG-2000, deflate or raw 16-bit) and window them to 8 bits.
//
// Message in:  { id, file, offset, byteCount, compression, width, height, gain }
// Message out: { id, pixels: Uint8Array(width·height) } or { id, error }
// `gain` maps a 16-bit value v to min(255, v·gain).

import { parentPort } from 'node:worker_threads';
import { openSync, readSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';

// openjpeg narrates every tile on stdout (a pyramid is thousands of tiles), and its
// Emscripten runtime captures console.log when it loads — so silence it first.
console.log = () => {};

const require = createRequire(import.meta.url);
const openjpeg = await require('@cornerstonejs/codec-openjpeg/decodewasmjs')();
const decoder = new openjpeg.J2KDecoder();
const fds = new Map();

function readTile(file, offset, byteCount) {
  let fd = fds.get(file);
  if (fd === undefined) fds.set(file, (fd = openSync(file, 'r')));
  const buf = Buffer.alloc(byteCount);
  readSync(fd, buf, 0, byteCount, offset);
  return buf;
}

function decode16(bytes, compression, width, height) {
  if (compression === 34712) {
    decoder.getEncodedBuffer(bytes.length).set(bytes);
    decoder.decode();
    const info = decoder.getFrameInfo();
    const out = decoder.getDecodedBuffer();
    if (info.bitsPerSample > 8) {
      const bytes = out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
      return { data: new Uint16Array(bytes), w: info.width, h: info.height };
    }
    return { data: Uint16Array.from(out), w: info.width, h: info.height };
  }
  const raw = compression === 8 || compression === 32946 ? inflateSync(bytes) : bytes;
  if (compression !== 1 && compression !== 8 && compression !== 32946) {
    throw new Error(`TIFF compression ${compression} is not supported`);
  }
  return { data: new Uint16Array(raw.buffer, raw.byteOffset, width * height), w: width, h: height };
}

parentPort.on('message', (m) => {
  try {
    const { data, w, h } = decode16(readTile(m.file, m.offset, m.byteCount), m.compression, m.width, m.height);
    const pixels = new Uint8Array(m.width * m.height);
    const rows = Math.min(h, m.height);
    const cols = Math.min(w, m.width);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const v = data[y * w + x] * m.gain;
        pixels[y * m.width + x] = v > 255 ? 255 : v;
      }
    }
    if (m.histogram) {
      const hist = new Uint32Array(65536);
      for (let i = 0; i < data.length; i++) hist[data[i]]++;
      parentPort.postMessage({ id: m.id, pixels, hist }, [pixels.buffer, hist.buffer]);
    } else {
      parentPort.postMessage({ id: m.id, pixels }, [pixels.buffer]);
    }
  } catch (err) {
    parentPort.postMessage({ id: m.id, error: String(err?.message ?? err) });
  }
});
