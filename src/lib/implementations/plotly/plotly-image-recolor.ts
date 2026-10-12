import { IChannelState } from '../../contracts/channel-histogram-api.contract';
import { IImageInfo } from '../../contracts/image.contract';
import { PixelData } from '../../contracts/visualizer.contract';
import { DisplayPipeline, rgbNeedsRecolor } from '../osd/display-pipeline';

/** How the Plotly `image` trace of an image follows the Channels & Histogram dialog. */
export type RecolorKind = 'rgb' | 'multichannel';

/** RGBA8 pixels → an `image` trace's `source` (a `data:image/…;base64,` URI). */
export type ImageEncoder = (rgba: Uint8ClampedArray, width: number, height: number) => Promise<string>;

/** A serverless multichannel stack's per-channel plane URLs (`channelUrls[z][c]`), or null: the
 *  criterion OSD's simple source and napari-js's stitch path use. */
export function channelPlaneUrls(info: IImageInfo | undefined): string[][] | null {
  const urls = info?.channelUrls;
  return urls?.length && (info?.imageMeta?.[0]?.channelCount ?? 1) > 1 ? urls : null;
}

/**
 * Which channel display the `image` trace of `info` gets: `multichannel` when the slices'
 * channel planes were loaded, `rgb` for an RGB image (its channels are R, G and B — the store's
 * channel model for `rgbChannels ≥ 3`), else none. A tiled multichannel image is plotted from
 * the server's flat composite preview, with no per-channel pixels to recolour: none.
 */
export function recolorKind(info: IImageInfo | undefined, hasPlanes: boolean): RecolorKind | null {
  if (!info || info.isGrayscale) return null;
  if (hasPlanes) return 'multichannel';
  return (info.imageMeta?.[0]?.rgbChannels ?? 0) >= 3 ? 'rgb' : null;
}

/** A Plotly `image` frame (rows of `[r, g, b(, a)]` cells) as opaque RGBA8 pixels. */
export function matrixToRgba(frame: number[][][], width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0, o = 0; y < height; y++) {
    const row = frame[y];
    for (let x = 0; x < width; x++, o += 4) {
      const cell = row?.[x];
      if (!cell) continue;
      out[o] = cell[0];
      out[o + 1] = cell[1];
      out[o + 2] = cell[2];
      out[o + 3] = 255;
    }
  }
  return out;
}

/** The browser's PNG encoder, off the main thread where it can be (`convertToBlob`/`toBlob`
 *  encode asynchronously), read back as a data URI. */
export const encodePng: ImageEncoder = async (rgba, width, height) => {
  const pixels = new ImageData(rgba, width, height);
  let blob: Blob | null;
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.putImageData(pixels, 0, 0);
    blob = await canvas.convertToBlob({ type: 'image/png' });
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')!.putImageData(pixels, 0, 0);
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  }
  if (!blob) throw new Error('[plotly] image encode failed');
  const image = blob;
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(image);
  });
};

/**
 * The channel display of Plotly's colour `image` trace (#46 browser testing): what OSD's
 * {@link DisplayPipeline} does to its tiles, run on the CPU over the frames Plotly plots, so one
 * channel state draws the same picture on both (window → invert → gamma → tint, additive merge).
 *  - multichannel (a serverless stack's `channelUrls`): the slice's raw channel planes merged by
 *    `compositeChannels`;
 *  - RGB: the raw frame's R, G and B through their channels (`applyToRgba`) — the raw frame as it
 *    is while the channel states leave it so ({@link rgbNeedsRecolor}).
 *
 * Always from the RAW pixels the plot was built from, never from a recoloured frame, so repeated
 * edits never compound. The raw frames stay what the pixel tools, the profiles and the histogram
 * read; only the trace's picture changes.
 *
 * The trace draws a PNG `source`, not a `z` matrix: Plotly paints a `z` image one `fillRect` per
 * pixel (~0.7 s for a 1-megapixel slice, on every edit), while a `source` is drawn by the browser
 * and encoded off the main thread. A stack recolours the slice on screen, and each other slice
 * when it is shown ({@link frame} reports a stale one).
 */
export class PlotlyImageRecolor {
  private kind: RecolorKind | null = null;
  private frames: number[][][][] = [];
  private planes: Array<Uint8Array[] | undefined> = [];
  /** Per frame: the display key of the latest picture asked for it. */
  private shown: string[] = [];
  /** Bumped by every plot/clear: a picture encoded for an older plot is dropped. */
  private generation = 0;
  private readonly pipeline: DisplayPipeline;

  constructor(
    private readonly host: { channelStates(): IChannelState[]; invert(): boolean },
    private readonly encode: ImageEncoder = encodePng,
  ) {
    this.pipeline = new DisplayPipeline({
      isGrayscale: () => false,
      colorLut: () => null,
      channelStates: () => this.host.channelStates(),
      invertBg: () => this.host.invert(),
    });
  }

  /** Whether the traces on screen follow the channel states. */
  get active(): boolean {
    return this.kind !== null;
  }

  /**
   * Start following the channel states for the `image` traces about to be plotted from `frames`
   * (raw, one per slice) and, for `multichannel`, each slice's raw channel `planes`. Resolves to
   * each slice's `source` in the current display; null for `kind` null (the traces draw `z`), or
   * when a newer plot superseded this one.
   */
  async plot(
    kind: RecolorKind | null,
    frames: number[][][][],
    planes: Array<Uint8Array[] | undefined> = [],
  ): Promise<string[] | null> {
    this.generation++;
    this.kind = kind;
    this.frames = kind ? frames : [];
    this.planes = kind ? planes : [];
    this.shown = [];
    if (!kind) return null;
    const sources = await Promise.all(frames.map((_f, i) => this.frame(i)));
    return sources.every((s): s is string => s !== null) ? sources : null;
  }

  /** Stop following (the plot was replaced by a non-image one, or purged). */
  clear(): void {
    this.generation++;
    this.kind = null;
    this.frames = [];
    this.planes = [];
    this.shown = [];
  }

  /** Slice `index`'s `source` in the current channel display, or null when the picture asked for
   *  last already shows it, or a newer picture or plot superseded this one. */
  async frame(index: number): Promise<string | null> {
    if (!this.kind || !this.frames[index]?.length) return null;
    const key = JSON.stringify([this.host.channelStates(), this.host.invert()]);
    if (this.shown[index] === key) return null;
    this.shown[index] = key;
    const generation = this.generation;
    const px = this.pixels(index)!;
    const source = await this.encode(px.rgba, px.width, px.height);
    return generation === this.generation && this.shown[index] === key ? source : null;
  }

  /** Slice `index`'s displayed pixels (`getDisplayedPixelData` of a trace drawn from its `source`),
   *  as `[r, g, b]` like a `z` trace's; null when no trace follows the channel states. */
  displayedPixels(index: number): PixelData | null {
    const px = this.pixels(index);
    if (!px) return null;
    const data = new Uint8ClampedArray(px.width * px.height * 3);
    for (let i = 0, o = 0; o < data.length; i += 4, o += 3) {
      data[o] = px.rgba[i];
      data[o + 1] = px.rgba[i + 1];
      data[o + 2] = px.rgba[i + 2];
    }
    return { width: px.width, height: px.height, channels: 3, data };
  }

  /** Slice `index` in the current channel display, as RGBA8, from its raw pixels. */
  private pixels(index: number): { rgba: Uint8ClampedArray; width: number; height: number } | null {
    const raw = this.frames[index];
    if (!this.kind || !raw?.length) return null;
    const height = raw.length;
    const width = raw[0]?.length ?? 0;
    const states = this.host.channelStates();
    const invert = this.host.invert();
    const planes = this.planes[index];
    // A slice whose planes do not fit its frame (none were loaded) shows the frame as it is.
    if (this.kind === 'multichannel' && planes?.length && planes.every((p) => p.length === width * height)) {
      return { rgba: this.pipeline.compositeChannels(planes, states, 1), width, height };
    }
    const rgba = matrixToRgba(raw, width, height);
    if (this.kind === 'rgb' && rgbNeedsRecolor(states, invert)) this.pipeline.applyToRgba(rgba);
    return { rgba, width, height };
  }
}
