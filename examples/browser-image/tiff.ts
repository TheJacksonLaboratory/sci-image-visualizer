/**
 * Lightweight in-browser multi-page TIFF decode for the example — the serverless
 * counterpart to how Jax Image Tools reads TIFF hyperstacks server-side. Uses the
 * `tiff` package (image-js's own underlying decoder), lazy-imported so it stays
 * off the app's init path. Every TIFF page becomes one PNG blob; a multi-page
 * file (a z-stack / hyperstack) is loaded as a z-stack the viewer can scrub.
 *
 * Renders 8-bit and (min/max-normalized to 8-bit, like ImageJ auto-contrast)
 * higher-bit grayscale, plus interleaved RGB. Per-channel compositing of a true
 * multi-channel hyperstack is beyond a lightweight demo — each page is shown as
 * stored, which is how ImageJ browses hyperstack frames.
 */
export interface DecodedTiff {
  width: number;
  height: number;
  isGrayscale: boolean;
  /** One PNG object URL per TIFF page (length 1 for a flat TIFF). */
  slices: string[];
}

export async function decodeTiffStack(buffer: ArrayBuffer): Promise<DecodedTiff> {
  const mod: any = await import('tiff');
  const decode = mod.decode ?? mod.default?.decode;
  const ifds: any[] = decode(new Uint8Array(buffer));
  if (!ifds.length) throw new Error('TIFF: no image pages');
  const spp = ifds[0].samplesPerPixel || 1;
  const slices: string[] = [];
  for (const ifd of ifds) slices.push(await ifdToPngUrl(ifd));
  return { width: ifds[0].width, height: ifds[0].height, isGrayscale: spp === 1, slices };
}

async function ifdToPngUrl(ifd: any): Promise<string> {
  const w: number = ifd.width;
  const h: number = ifd.height;
  const spp: number = ifd.samplesPerPixel || 1;
  const data: ArrayLike<number> = ifd.data;
  const count = w * h;

  // 8-bit → identity; anything wider → min/max normalize the whole page to 0..255.
  const bps = Array.isArray(ifd.bitsPerSample) ? ifd.bitsPerSample[0] : ifd.bitsPerSample;
  let lo = 0, span = 255;
  if (bps !== 8) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < data.length; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    lo = mn; span = Math.max(1, mx - mn);
  }
  const norm = (v: number): number => (bps === 8 ? v : ((v - lo) / span) * 255);

  const rgba = new Uint8ClampedArray(count * 4);
  if (spp >= 3) {
    // Interleaved RGB(A) — the common planarConfiguration=1 layout.
    for (let i = 0; i < count; i++) {
      const o = i * 4, s = i * spp;
      rgba[o] = norm(data[s]); rgba[o + 1] = norm(data[s + 1]); rgba[o + 2] = norm(data[s + 2]); rgba[o + 3] = 255;
    }
  } else {
    for (let i = 0; i < count; i++) {
      const g = norm(data[i]), o = i * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = g; rgba[o + 3] = 255;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('TIFF: 2D canvas unavailable');
  ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('TIFF: PNG encode failed');
  return URL.createObjectURL(blob);
}
