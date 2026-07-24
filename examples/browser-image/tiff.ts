/**
 * Lightweight in-browser multi-page / hyperstack TIFF decode for the example —
 * the serverless counterpart to how Jax Image Tools reads TIFFs server-side.
 * Uses the `tiff` package (image-js's own underlying decoder), lazy-imported so
 * it stays off the app's init path.
 *
 *  - A flat / z-stack TIFF: every page becomes one PNG blob (grayscale or RGB),
 *    loaded as a scrubbable z-stack.
 *  - An **ImageJ hyperstack** (ImageDescription carries `channels=N slices=Z`,
 *    channels varying fastest → page = z*N + c): each channel plane becomes its
 *    own grayscale PNG, exposed as `channelUrls[z][c]` so the viewer composites
 *    the N channels client-side (per-channel colour/window/gamma + per-channel
 *    histograms) — the serverless analog of jit-service's multichannel path.
 *
 * Renders 8-bit and (min/max-normalized to 8-bit) higher-bit grayscale + RGB.
 */
export interface DecodedTiff {
  width: number;
  height: number;
  /** True only for a single-band, single-channel image. */
  isGrayscale: boolean;
  /** One URL per z-slice — a flat frame, or channel 0 as the multichannel anchor
   *  (drives the scrubber's slice count). */
  slices: string[];
  /** >1 for an ImageJ hyperstack; 1 otherwise. */
  channelCount: number;
  /** [z][c] per-channel grayscale plane URLs (multichannel only). */
  channelUrls?: string[][];
}

export async function decodeTiffStack(buffer: ArrayBuffer): Promise<DecodedTiff> {
  const mod: any = await import('tiff');
  const decode = mod.decode ?? mod.default?.decode;
  const ifds: any[] = decode(new Uint8Array(buffer));
  if (!ifds.length) throw new Error('TIFF: no image pages');
  const width = ifds[0].width;
  const height = ifds[0].height;

  // ImageJ hyperstack dims from the ImageDescription (tag 270), e.g.
  // "ImageJ=1.52d\nchannels=4\nslices=11\nhyperstack=true".
  const desc: string = readField(ifds[0], 270) ?? '';
  const channels = intField(desc, 'channels') ?? 1;
  const slicesN = intField(desc, 'slices') ?? Math.floor(ifds.length / Math.max(1, channels));

  if (channels > 1 && slicesN >= 1) {
    // Channels vary fastest (XYCZT): slice z's channels are pages z*C .. z*C+C-1.
    const channelUrls: string[][] = [];
    const slices: string[] = [];
    for (let z = 0; z < slicesN; z++) {
      const planes: string[] = [];
      for (let c = 0; c < channels; c++) {
        const page = z * channels + c;
        if (page < ifds.length) planes.push(await ifdToPngUrl(ifds[page]));
      }
      if (!planes.length) break;
      channelUrls.push(planes);
      slices.push(planes[0]); // channel-0 anchor → maxIndex / fallback
    }
    return { width, height, isGrayscale: false, slices, channelCount: channels, channelUrls };
  }

  // Flat / z-stack: one PNG per page.
  const slices: string[] = [];
  for (const ifd of ifds) slices.push(await ifdToPngUrl(ifd));
  return { width, height, isGrayscale: (ifds[0].samplesPerPixel || 1) === 1, slices, channelCount: 1 };
}

/** Read a TIFF field across `tiff`-package field shapes (Map or object). */
function readField(ifd: any, tag: number): string | undefined {
  const f = ifd.fields;
  const v = f ? (typeof f.get === 'function' ? f.get(tag) : f[tag]) : undefined;
  return typeof v === 'string' ? v : undefined;
}
/** Pull an integer `key=NN` out of an ImageJ ImageDescription blob. */
function intField(desc: string, key: string): number | undefined {
  const m = new RegExp(`(?:^|\\n)${key}=(\\d+)`).exec(desc);
  return m ? parseInt(m[1], 10) : undefined;
}

async function ifdToPngUrl(ifd: any): Promise<string> {
  const w: number = ifd.width;
  const h: number = ifd.height;
  const spp: number = ifd.samplesPerPixel || 1;
  const data: ArrayLike<number> = ifd.data;
  const count = w * h;

  // 8-bit → identity; wider → min/max normalize the whole page to 0..255.
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
