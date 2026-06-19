/// <reference lib="webworker" />
import { encode as encodePng } from 'fast-png';

import { WandService } from '../toolbar/wand/wand.service';
import { regionsToMask, MaskPart } from './mask-raster';

/**
 * Mask-export Web Worker (jit-ui#95).
 *
 * Rasterizes the region geometry to a full-resolution label mask and encodes it
 * as an 8-bit grayscale PNG OFF the main thread. For whole-slide images the
 * full-res buffer and the PNG `deflate` are heavy enough to freeze the tab if
 * run inline; here they run in the worker so the UI stays responsive and the
 * job can be cancelled (the main thread terminates the worker). Progress is
 * reported per region while rasterizing, then the encode runs.
 */

interface MaskRequest {
  /** Mask dimensions (already downscaled to the safe budget). */
  width: number;
  height: number;
  /** Full-resolution image dimensions, recorded in the PNG metadata so the mask
   *  can be mapped back even when downscaled. */
  originalWidth: number;
  originalHeight: number;
  scale: number;
  mode: 'binary' | 'multiclass';
  sourceName?: string;
  regions: MaskPart[][];
}

const wand = new WandService();

addEventListener('message', ({ data }: MessageEvent<MaskRequest>) => {
  try {
    const { width, height, originalWidth, originalHeight, scale, mode, sourceName, regions } = data;
    const mask = regionsToMask(
      regions, width, height, mode,
      (xs, ys, w, h, holes) => wand.rasterizePolygon(xs, ys, w, h, holes),
      (done, total) => postMessage({ type: 'progress', done, total }),
    );
    if (!mask) {
      postMessage({ type: 'error', error: 'No regions could be rasterized.' });
      return;
    }
    postMessage({ type: 'encoding' });
    // Embed provenance as PNG tEXt chunks so the (possibly downscaled) mask
    // records the original full-resolution dimensions and scale factor.
    const text: Record<string, string> = {
      MaskType: mode,
      OriginalWidth: String(originalWidth),
      OriginalHeight: String(originalHeight),
      MaskScale: String(scale),
    };
    if (sourceName) text.SourceImage = sourceName;
    const png = encodePng({
      width: Math.round(width), height: Math.round(height),
      data: mask.data, channels: 1, depth: mask.bitDepth, text,
    });
    // Transfer the PNG buffer to avoid a copy.
    (postMessage as (msg: unknown, transfer: Transferable[]) => void)(
      { type: 'done', png }, [png.buffer],
    );
  } catch (err) {
    postMessage({ type: 'error', error: (err as Error)?.message ?? String(err) });
  }
});
