import type { TiledSource, TileKey, PixelChunk } from 'napari-js';

/**
 * Subset of the `/tiles/info` response the napari-js backend needs to build a pyramidal
 * source. Mirrors the descriptor the OSD backend consumes (osd/openseadragon-visualizer
 * .service.ts), reduced to what drives tiling.
 */
export interface ServerTileDescriptor {
  width: number;
  height: number;
  tileSize: number;
  /** Number of z-slices. */
  z: number;
  channels: number;
  multichannel?: boolean;
  /** Pyramid levels as reported by the server (any order). */
  levels: Array<{ res: number; width: number; height: number }>;
  mppX?: number;
  mppY?: number;
}

export interface TileFetchConfig {
  /** Base URL of the tile service (VizConfig.slideCropServer). */
  apiBase: string;
  /** Base64 file descriptor for the selected image (TileAccessPort.getSelectedInfoB64()). */
  infoB64: string;
  /** Per-request auth headers (TileAccessPort.getAuthHeaders()). */
  authHeaders: () => Promise<Record<string, string>>;
}

/**
 * Build a napari-js {@link TiledSource} backed by the jit-service tile endpoints. Tiles are
 * fetched as server-composited RGBA PNGs and uploaded as `ImageBitmap`s (napari-js >= 0.2.0).
 *
 * NOTE (jit-ui#102): the napari level -> server `res` mapping assumes the server's level list
 * sorts cleanly finest->coarsest and matches napari-js's halving pyramid. This needs
 * verification against a live tile server; per-channel (non-composited) fetching and GPU-side
 * recolouring are follow-ups.
 */
export function buildNapariTiledSource(
  desc: ServerTileDescriptor,
  cfg: TileFetchConfig,
): TiledSource {
  // napari-js level 0 = full resolution; order the server levels finest -> coarsest.
  const levels = [...desc.levels].sort((a, b) => b.width - a.width);

  return {
    kind: 'tiled',
    width: desc.width,
    height: desc.height,
    tileSize: desc.tileSize,
    levels: Math.max(1, levels.length),
    depth: Math.max(1, desc.z),
    channels: 4,
    dtype: 'uint8',
    async fetchTile(key: TileKey): Promise<PixelChunk> {
      const level = levels[Math.min(key.level, levels.length - 1)];
      const url =
        `${cfg.apiBase}tile?info=${encodeURIComponent(cfg.infoB64)}` +
        `&res=${level.res}&col=${key.col}&row=${key.row}&z=${key.z}&tileSize=${desc.tileSize}`;
      const headers = await cfg.authHeaders();
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error(`napari-js tile fetch failed: ${resp.status} ${url}`);
      const bitmap = await createImageBitmap(await resp.blob());
      return { width: bitmap.width, height: bitmap.height, data: bitmap };
    },
  };
}
