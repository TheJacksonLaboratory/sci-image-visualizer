import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';

import { buildTileUrl, fetchTileBitmap } from './tile-client';
import { DisplayPipeline } from './display-pipeline';
import { TileDescriptor } from '../tile-server';
import { IChannelState } from '../../contracts/channel-histogram-api.contract';

/** Largest level an export stitches (~32 MP) — bounds memory for whole-slide images. */
const EXPORT_PIXEL_CAP = 32_000_000;

/** What {@link renderCompositePng} draws. */
export interface CompositeExportInput {
  http: HttpClient;
  api: string;
  descriptor: TileDescriptor;
  infoB64: string;
  z: number;
  /** Drawn per channel (one TiledImage per channel), from the real levels only. */
  multiChannel: boolean;
  realLevels: number;
  channelStates: IChannelState[];
  display: DisplayPipeline;
}

/**
 * Render the current slice as a publication-ready PNG composited with the
 * active display settings (window / gamma / colormap or per-channel pseudo-
 * colours / invert). Picks the largest pyramid level under a pixel cap (the
 * coarser overview for huge whole-slides), fetches that level's tile grid,
 * stitches it into one canvas and runs the shared display pipeline. A
 * per-channel (multichannel) image is exported the way it is drawn: each
 * visible channel's tiles are stitched and merged additively with its tint.
 * Null when there is nothing to export.
 */
export async function renderCompositePng(input: CompositeExportInput): Promise<Blob | null> {
  const { descriptor: desc, http, api, infoB64, z, display } = input;
  // Per-channel tiles exist only at the real Bio-Formats levels.
  const levels = input.multiChannel ? desc.levels.slice(0, input.realLevels) : desc.levels;
  if (!infoB64 || !levels.length) return null;
  let res = levels.length - 1; // coarsest fallback
  for (let i = 0; i < levels.length; i++) {
    if (levels[i].width * levels[i].height <= EXPORT_PIXEL_CAP) { res = i; break; }
  }
  const lw = levels[res].width;
  const lh = levels[res].height;
  const t = desc.tileSize;
  const cols = Math.max(1, Math.ceil(lw / t));
  const rows = Math.max(1, Math.ceil(lh / t));
  const canvas = document.createElement('canvas');
  canvas.width = lw;
  canvas.height = lh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  /** Stitch the level's tile grid (server composite, or one channel) into the canvas. */
  const stitch = async (channel?: number): Promise<void> => {
    ctx.clearRect(0, 0, lw, lh);
    const jobs: Promise<void>[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const url = buildTileUrl(api, infoB64, { res, col, row, z, tileSize: t, channel });
        jobs.push(
          (async () => {
            try {
              const bmp = await fetchTileBitmap(http, url, 30000);
              ctx.drawImage(bmp, col * t, row * t);
              bmp.close?.();
            } catch (err) {
              // Skip a failed tile — the exported composite has a gap there.
              console.warn('[viz:export] composite tile fetch failed, skipping', url, err);
            }
          })(),
        );
      }
    }
    await Promise.all(jobs);
  };
  try {
    if (input.multiChannel) {
      const states = input.channelStates;
      const nCh = Math.max(1, states.length || (desc.channels ?? 1));
      let out: Uint8ClampedArray | null = null;
      let imageData: ImageData | null = null;
      for (let c = 0; c < nCh; c++) {
        if (states[c]?.visible === false) continue;
        await stitch(c);
        imageData = ctx.getImageData(0, 0, lw, lh);
        out ??= new Uint8ClampedArray(imageData.data.length);
        display.addChannel(out, imageData.data, states[c]);
      }
      if (imageData && out) {
        for (let i = 3; i < out.length; i += 4) out[i] = 255; // opaque
        imageData.data.set(out);
        ctx.putImageData(imageData, 0, 0);
      } else {
        ctx.clearRect(0, 0, lw, lh); // every channel hidden
      }
    } else {
      await stitch();
      const imageData = ctx.getImageData(0, 0, lw, lh);
      if (display.applyToRgba(imageData.data)) ctx.putImageData(imageData, 0, 0);
    }
  } catch (err) {
    // Keep the un-recolored composite if readback fails — but say why.
    console.warn('[viz:export] composite recolor readback failed — exporting raw tiles', err);
  }
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * Fetch the data-preserving multi-band TIFF from `GET /export/tiff` (the server
 * reads the raw native-bit-depth planes — the client never sees them). Null
 * while the file is still caching (202) or on failure, which is logged.
 */
export async function fetchTiffExport(http: HttpClient, url: string): Promise<Blob | null> {
  try {
    const resp = await firstValueFrom(
      http
        .get(url, { observe: 'response', responseType: 'blob' })
        .pipe(timeout(600000)), // large exports stream slowly; generous deadline
    );
    if (resp.status === 202) {
      console.warn('[OSD] 16-bit export: file still caching — try again shortly.');
      return null;
    }
    return resp.body;
  } catch (err) {
    console.warn('[OSD] 16-bit TIFF export failed', err);
    return null;
  }
}

/** `name.tif` → `name` (the export file stem; `image` when there is no name). */
export function fileStem(fileName: string | undefined): string {
  return (fileName || 'image').replace(/\.[^.]+$/, '');
}
