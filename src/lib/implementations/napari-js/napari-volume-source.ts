import type { ServerTileDescriptor, TileFetchConfig } from './napari-tile-source';

export interface VolumeData {
  data: Uint8Array;
  width: number;
  height: number;
  depth: number;
}

/**
 * POC (jit-ui#102): assemble a coarse `uint8` volume from the tile server's z-stack by
 * fetching the **coarsest** pyramid level (a single tile) per slice and reading its
 * luminance. Intended for a tractable 3D preview (MIP / isosurface), not full resolution.
 *
 * NOTE: needs verification against a live tile server — it assumes the coarsest level fits in
 * one tile. Full-res / chunked volume streaming is a follow-up.
 */
export async function loadVolumeFromStack(
  desc: ServerTileDescriptor,
  cfg: TileFetchConfig,
): Promise<VolumeData> {
  const coarsest =
    [...desc.levels].sort((a, b) => a.width - b.width)[0] ??
    ({ res: 0, width: desc.width, height: desc.height } as const);
  const width = coarsest.width;
  const height = coarsest.height;
  const depth = Math.max(1, desc.z);
  const data = new Uint8Array(width * height * depth);
  const tileSize = Math.max(width, height, desc.tileSize);

  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('napari-js volume assembly: 2D context unavailable');

  const headers = await cfg.authHeaders();
  for (let z = 0; z < depth; z++) {
    const url =
      `${cfg.apiBase}tile?info=${encodeURIComponent(cfg.infoB64)}` +
      `&res=${coarsest.res}&col=0&row=0&z=${z}&tileSize=${tileSize}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) continue;
    const bitmap = await createImageBitmap(await resp.blob());
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const base = z * width * height;
    for (let i = 0; i < width * height; i++) {
      // Rec.601 luminance of the server-composited slice.
      data[base + i] =
        (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0;
    }
  }
  return { data, width, height, depth };
}
