/**
 * Lightweight in-browser DICOM → PNG decode for the example — the serverless
 * counterpart to how Jax Image Tools decodes DICOM server-side (jit-service +
 * Bio-Formats). Handles the uncompressed, single-sample MONOCHROME grayscale
 * case that micro-CT / CT slices use (transfer syntax Implicit or Explicit VR
 * Little Endian, 8- or 16-bit), applying the DICOM modality rescale + VOI LUT
 * (window/level) exactly as a viewer would. `dicom-parser` is lazy-imported so
 * it stays off the app's init path (the gallery renders without it).
 *
 * Compressed transfer syntaxes (JPEG / JPEG 2000 / RLE) need codecs and are out
 * of scope for a lightweight demo — that is precisely what the server path is for.
 */
export interface DecodedDicom {
  width: number;
  height: number;
  /** Object URL of a PNG the OSD backend opens directly (tiled: false). */
  blobUrl: string;
}

export async function decodeDicom(buffer: ArrayBuffer): Promise<DecodedDicom> {
  // CJS module: the callable object is on `.default` once bundled (webpack/rollup
  // interop), the namespace itself for Jest/CJS — normalize like the OSD lib does.
  const mod: any = await import('dicom-parser');
  const dicomParser: any = mod.default ?? mod;
  const bytes = new Uint8Array(buffer);
  const ds = dicomParser.parseDicom(bytes);

  const rows = ds.uint16('x00280010');
  const cols = ds.uint16('x00280011');
  const bits = ds.uint16('x00280100') || 16;
  const signed = ds.uint16('x00280103') === 1;
  const samples = ds.uint16('x00280002') || 1;
  const photometric: string = ds.string('x00280004') || 'MONOCHROME2';
  const pixel = ds.elements.x7fe00010;
  if (!rows || !cols || !pixel) throw new Error('DICOM: missing dimensions or pixel data');
  if (samples !== 1) throw new Error(`DICOM: only single-sample grayscale supported (samplesPerPixel=${samples})`);

  const slope = num(ds.string('x00281053'), 1);
  const intercept = num(ds.string('x00281052'), 0);
  // Window center/width may be multi-valued ("a\b") — take the first pair.
  let center = num(firstOf(ds.string('x00281050')), NaN);
  let width = num(firstOf(ds.string('x00281051')), NaN);

  const count = rows * cols;
  const view = new DataView(bytes.buffer, bytes.byteOffset + pixel.dataOffset, count * (bits / 8));
  const raw = (i: number): number =>
    bits === 8 ? (signed ? view.getInt8(i) : view.getUint8(i))
               : (signed ? view.getInt16(i * 2, true) : view.getUint16(i * 2, true));
  // Modality LUT: stored value → output units (e.g. Hounsfield).
  const value = (i: number): number => raw(i) * slope + intercept;

  // No window in the header? derive a full-range one from the data.
  if (!isFinite(center) || !isFinite(width) || width <= 0) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < count; i++) { const v = value(i); if (v < lo) lo = v; if (v > hi) hi = v; }
    center = (lo + hi) / 2;
    width = Math.max(1, hi - lo);
  }

  // DICOM VOI LUT LINEAR (PS3.3 C.11.2.1.2), mapped to 0..255.
  const loBound = center - 0.5 - (width - 1) / 2;
  const hiBound = center - 0.5 + (width - 1) / 2;
  const scale = 255 / (width - 1);
  const invert = photometric === 'MONOCHROME1'; // MONOCHROME1: low value = white
  const rgba = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    const x = value(i);
    let g: number;
    if (x <= loBound) g = 0;
    else if (x > hiBound) g = 255;
    else g = (x - (center - 0.5)) * scale + 127.5; // == ((x-(c-.5))/(w-1)+.5)*255
    if (invert) g = 255 - g;
    const o = i * 4;
    rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
    rgba[o + 3] = 255;
  }

  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('DICOM: 2D canvas unavailable');
  ctx.putImageData(new ImageData(rgba, cols, rows), 0, 0);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('DICOM: PNG encode failed');
  return { width: cols, height: rows, blobUrl: URL.createObjectURL(blob) };
}

function num(s: string | undefined, fallback: number): number {
  const v = s != null ? parseFloat(s) : NaN;
  return isFinite(v) ? v : fallback;
}
function firstOf(s: string | undefined): string | undefined {
  return s != null ? s.split('\\')[0] : undefined;
}
