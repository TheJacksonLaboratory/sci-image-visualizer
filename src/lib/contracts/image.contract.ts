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
  /** Per-slice ROI GeoJSON, aligned 1:1 with `urls`, for a folder stack where
   *  each slice is a separate file with its own sibling `<stem>.geojson`
   *  (`null` for slices without one). When present, the component applies
   *  `roiJsonStrs[z]` for the displayed slice and swaps it on scrub — as
   *  opposed to the scalar `roiJsonStr`, which is one ROI set for the whole
   *  image (a single file or a server z-stack). (jit-ui#93) */
  roiJsonStrs?: (string | null)[];
  imageMeta: IImageMetadata[];
  /** How the OpenSeadragon backend should source this image.
   *  - `true`/absent (default): server-tiled — OSD polls `/tiles/info` for a
   *    pyramid and fetches tiles from the slide-crop server (whole-slide path).
   *  - `false`: a self-contained, directly-loadable image — `urls[zIndex]` is a
   *    complete image (e.g. a `blob:` URL built from a client-side pixel buffer),
   *    opened via OSD's single-image source with no tile server. Lets in-memory
   *    images (the processing pipeline) use the OSD viewer without a round-trip. */
  tiled?: boolean;
  /** One-shot hint: open the stack on this slice instead of slice 0 (e.g. the
   *  host clicked a specific file within a numbered image series). The
   *  component consumes and clears this the first time it sees the object, so
   *  re-delivering the same ImageInfo (e.g. a plot-type switch) doesn't reset
   *  the user's current scrub position. */
  initialZIndex?: number;
}
