import type { ChannelView } from 'napari-js';

import { IImageInfo } from '../../contracts/image.contract';
import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import { bt601Luminance } from '../../contracts/intensity';
import { NAPARI_DEFAULT_DECIMATE } from '../../contracts/plot-type';

/**
 * Pure helpers and constants of the napari-js backend: no viewer, no store, no network. Shared by
 * the service and its scenes (review Appendix B, step 1).
 */

/**
 * A short, stable id for a colormap value, for cache keys.
 *
 * Half the library's colormaps are NAMES and half are inline `[stop, colour]`
 * arrays of 256 entries. Stringifying the array kind would put 6 KB in a key that
 * is rebuilt and compared on every view change; hashing it keeps the key small,
 * and it only has to distinguish one colormap from another.
 */
export function colormapId(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '?';
  // FNV-1a over the stops. A collision would leave a stale colouring on screen,
  // not corrupt anything, and 32 bits over a few hundred colormaps will not.
  let hash = 0x811c9dc5;
  const text = value.map((stop) => String(stop)).join(',');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `#${(hash >>> 0).toString(36)}`;
}

export const VOLUME_MAX_SLICE = 1024; // "Full" in-plane cap; the default ¼ load uses 256
/** Reference in-plane world size (long side) for the volume/axes box, in arbitrary world units.
 *  The box is anchored to this reference regardless of the chosen decimate factor, so changing the
 *  resolution changes DETAIL, not the volume's proportions (Z no longer appears to shrink when the
 *  in-plane sampling grows). Set to the DEFAULT decimate's in-plane cap so the default view is
 *  unchanged; higher/lower resolutions keep that same shape. */
export const VOLUME_WORLD_INPLANE_REF = VOLUME_MAX_SLICE / NAPARI_DEFAULT_DECIMATE;
/** Max concurrent slice fetches when assembling a volume — keeps the connection pool busy
 *  without flooding it (browsers cap ~6/host) on a deep stack. */
export const VOLUME_FETCH_CONCURRENCY = 8;

/** Volume/isosurface sampling for a decimate factor `scale` (1 = Full 1024, 2 = ½ 512, 4 = ¼ 256
 *  default, 8 = ⅛ 128): the in-plane cap halves each step; slices stay un-subsampled until ⅛, then
 *  subsample. */
export function volumeResolutionFor(scale: number): { maxSlice: number; sliceStep: number } {
  const s = Math.max(1, Math.round(scale));
  return {
    maxSlice: Math.max(8, Math.round(VOLUME_MAX_SLICE / s)),
    sliceStep: Math.max(1, Math.floor(s / 4)),
  };
}
/** Fully-normalized intensity height as a fraction of the in-plane extent — matches the Plotly
 *  SURFACE z-aspect (~0.4) so the relief isn't exaggerated. */
export const SURFACE_Z_ASPECT = 0.4;
/** "Full" mesh grid cap; the decimate factor divides it (default ¼ → 220, ½ → 440, Full → 880). */
export const SURFACE_MAX_GRID = 880;
/** Coefficient scaling the pyramid tile budget with the target resolution — a higher target pulls a
 *  finer pyramid level (more real detail). Shared by the surface plane fetch + volume assembly. */
export const STITCH_BUDGET_COEFF = 16;
/** Surface mesh target grid for a decimate factor `scale`: the grid cap shrinks by `scale` (every
 *  slice is kept — the z-slider needs them all). The source is fetched at a matching resolution. */
export function surfaceResolutionFor(scale: number): { maxGrid: number } {
  const s = Math.max(1, Math.round(scale));
  return { maxGrid: Math.max(16, Math.round(SURFACE_MAX_GRID / s)) };
}

/** 3D scatter: in-plane cap for the assembled voxel grid, and the max number of points emitted
 *  (the grid is flat-strided down to this) — keeps the billboard count interactive. */
export const SCATTER3D_MAX_XY = 64;
export const SCATTER3D_MAX_POINTS = 150000;

/** How long a pan/zoom must settle before the viewport (and, for pixel tools, the canvas
 *  readback) is refreshed — coalesces the camera's per-frame changes. */
export const READBACK_DEBOUNCE_MS = 250;

export const TILE_SIZE = 512; // server tile edge (matches the OSD backend)
/** Max tiles stitched for one displayed slice (512px tiles → up to ~6144² at full res). Beyond
 *  this we step to a coarser pyramid level so a large image stays tractable. */
export const MAX_STITCH_TILES = 144;
/** WebGPU default `maxTextureDimension2D` — a stitched slice's longest side must fit a texture. */
export const MAX_TEXTURE_DIM = 8192;
/** Concurrent tile requests per stitched slice. Firing a whole grid at once (hundreds of requests
 *  for a large level) overwhelmed the tile server (504s); a small pool keeps the pipe full without
 *  flooding it — and slice-level workers already run several stitches in parallel on top of this. */
export const TILE_FETCH_CONCURRENCY = 6;
/** How long to poll `/tiles/info` (202 while the server caches the source) before falling back to
 *  a single tile. Generous like the OSD backend — a cold whole-slide can take minutes to cache. */
export const DESCRIPTOR_TIMEOUT_MS = 120000;
/** Wait between two `/tiles/info` polls while the server answers 202. */
export const DESCRIPTOR_POLL_INTERVAL_MS = 1200;

/** A decoded single-channel uint8 plane. */
export interface LumaPlane {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * RGBA bytes → one BT.601 luminance byte per pixel, written into `out` from `offset`. Rounded,
 * so a grey pixel (R=G=B — every single-band server tile) decodes to itself exactly, while a
 * colour source (an RGB composite) becomes its luminance rather than its red channel.
 */
export function rgbaToLuminance(rgba: ArrayLike<number>, out: Uint8Array, offset = 0): void {
  const n = rgba.length >> 2;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[offset + i] = Math.round(bt601Luminance(rgba[o], rgba[o + 1], rgba[o + 2]));
  }
}

/**
 * `IChannelState.gamma` → the `gamma` a napari-js layer or view takes.
 *
 * The shared channel state follows the ImageJ/Fiji convention the OSD backend draws
 * (`osd/display-pipeline.ts`: output = t^(1/γ), so γ > 1 BRIGHTENS the midtones), while
 * napari-js's shaders apply `pow(t, gamma)` (napari's convention: γ > 1 darkens). Every gamma
 * handed to napari-js goes through here, so one slider in the Channels & Histogram dialog moves
 * both backends the same way. Both backends apply window → invert → gamma, per channel before
 * an additive merge (NAPARI-BOUNDARY-2; pinned by `osd/display-pipeline.cross-backend.spec.ts`).
 */
export function toNapariGamma(gamma: number | undefined): number {
  return gamma != null && gamma > 0 ? 1 / gamma : 1;
}

/** A 2D canvas (an `OffscreenCanvas` where available) and its context; throws, naming `what`,
 *  when no 2D context can be had. */
export function create2dCanvas(
  width: number,
  height: number,
  what: string,
): {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
} {
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error(`[napari-js] ${what}: 2D context unavailable`);
  return { canvas, ctx };
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight — keeps the connection pool busy
 * without flooding the server — starting no further item once `stop()` says so.
 */
export async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
  stop: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && !stop()) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

/** A serverless multichannel stack (`tiled:false` + `channelUrls`): no tile descriptor, so its
 *  channel count comes from `imageMeta`, and each band is fetched from its own plane URLs. */
export function isServerlessMultichannel(simple: boolean, info: IImageInfo | undefined): boolean {
  return simple && !!info?.channelUrls?.length && (info?.imageMeta?.[0]?.channelCount ?? 1) > 1;
}

/** The stack's declared slice count (`imageMeta.z`, else one URL per slice); 0 when unknown. */
export function stackDepth(info: IImageInfo | undefined): number {
  return info?.imageMeta?.[0]?.z || info?.urls?.length || 0;
}

/** A decoded single-channel uint8 plane as a napari-js typed image source. */
export function typedPlane(d: LumaPlane): ChannelView['source'] {
  return { kind: 'typed', width: d.width, height: d.height, channels: 1, dtype: 'uint8', data: d.data };
}

/** Default per-channel tints (Fiji-style) when the store/descriptor offers no colour. */
const DEFAULT_TINTS = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffffff'];

/** Default tint for a channel index, cycling the Fiji palette. */
export function tintFor(channel: number): string {
  return DEFAULT_TINTS[channel % DEFAULT_TINTS.length];
}

/** Convert a napari-js `Histogram` (bin count + min/max) to the pane's `IHistogram` (bin edges). */
export function toIHistogram(h: { counts: Uint32Array; bins: number; min: number; max: number }): IHistogram {
  const span = h.max - h.min || 1;
  const bins = Array.from({ length: h.bins }, (_, i) => h.min + (i * span) / h.bins);
  const counts = Array.from(h.counts);
  return { bins, counts, max: counts.reduce((m, c) => (c > m ? c : m), 0) };
}

/**
 * Additively composite grayscale channel images, each tinted with its display colour —
 * the navigator's picture of a multichannel image.
 */
export function tintedComposite(images: ImageBitmap[], colors: string[]): HTMLCanvasElement {
  const w = images[0]?.width ?? 1;
  const h = images[0]?.height ?? 1;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const t = tmp.getContext('2d')!;
  images.forEach((img, i) => {
    t.globalCompositeOperation = 'source-over';
    t.drawImage(img, 0, 0, w, h);
    t.globalCompositeOperation = 'multiply';
    t.fillStyle = colors[i];
    t.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(tmp, 0, 0);
  });
  return out;
}
