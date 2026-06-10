/**
 * Library-owned data interfaces for the image the visualization renders.
 *
 * The visualization package must not import the host app's concrete models
 * (`main/models/file-info`), or it can't become a standalone library. These
 * slim interfaces declare only the fields the library reads/writes; the host's
 * `ImageInfo`/`ImageMetadata` classes are pure data holders that satisfy them
 * structurally, so the host keeps passing its own instances unchanged.
 */

/** Per-channel metadata from the server descriptor (issue #76). */
export interface IChannelInfo {
  name: string;
  /** Suggested display tint as "#RRGGBB". */
  color: string;
  /** Embedded 256-entry display LUT as "#RRGGBB" (intensity→color), or
   *  null/undefined when the file has no palette for this channel. */
  lut?: string[] | null;
  bitDepth?: number;
  /** Pixel-type minimum (e.g. 0 for unsigned). Native-unit floor of the window. */
  minAllowed?: number;
  /** Pixel-type maximum (e.g. 65535 for unsigned 16-bit). Native-unit ceiling. */
  maxAllowed?: number;
}

/** Per-series image metadata (physical size + dimensions). */
export interface IImageMetadata {
  channelCount: number;
  rgbChannels: number;
  x: number;
  y: number;
  z: number;
  /** Physical pixel size in µm; null/undefined when the format reports none. */
  mppX?: number | null;
  mppY?: number | null;
  /** Per-channel name/color/LUT for multichannel (non-RGB) images, when known. */
  channelInfo?: IChannelInfo[] | null;
}

/** The image currently being visualized. Field optionality mirrors the host's
 *  `ImageInfo` so its instances are assignable to this interface. */
export interface IImageInfo {
  isGrayscale: boolean;
  trueImageSize: number[];
  urls: string[];
  /** Optional small-tier URLs (fast blurry placeholder), 1:1 with `urls`. */
  smallUrls?: string[];
  isStack: boolean;
  showStack: boolean;
  scaleRatio: boolean;
  fileName: string;
  roiJsonStr?: string;
  imageMeta: IImageMetadata[];
}
