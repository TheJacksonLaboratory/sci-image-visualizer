import type * as OpenSeadragon from 'openseadragon';

import { readRgba } from './tile-client';
import { DisplayPipeline } from './display-pipeline';
import { HistogramSampler } from './histogram-sampler';
import { TileDescriptor, throwIfAborted } from '../tile-server';
import { IImageInfo } from '../../contracts/image.contract';
import { IChannelState } from '../../contracts/channel-histogram-api.contract';
import { SimpleSliceAccessService } from '../simple-slice-access.service';

/** One decoded single-band channel plane (serverless multichannel). */
export interface SimplePlane { data: Uint8ClampedArray; width: number; height: number; }

/** What `load()` hands to `plot()`. `load()` only computes it: the image on
 *  screen keeps its own state until `plot()` commits this payload. */
export interface OsdLoaded {
  descriptor: TileDescriptor | null;
  infoB64: string;
  z: number;
  /** Mirrors the loaded image's filename — the diagram's render pipeline
   *  guards on `loaded.filename === phaseInfo.fileName` before calling plot(). */
  filename: string | undefined;
  /** Simple (non-tiled) image: `plot()` opens {@link url} directly via OSD's
   *  single-image source — no tile pyramid, no server. Set when the image
   *  carries `tiled === false` (see {@link IImageInfo.tiled}). */
  simple?: boolean;
  /** The directly-loadable image URL (`blob:`/`data:`/`http`) for simple mode. */
  url?: string;
  /** Serverless multichannel only: every slice's per-channel plane URLs, and
   *  the loaded slice's decoded planes ({@link url} is their composite). */
  channelUrls?: string[][];
  channelPlanes?: SimplePlane[];
}

/** The service state the simple source reads and drives. */
export interface SimpleSourceHost {
  viewer(): OpenSeadragon.Viewer | null;
  descriptor(): TileDescriptor | null;
  isGrayscale(): boolean;
  currentZ(): number;
  /** Show slice `z`: the service records it and drops its slice-specific readback. */
  setCurrentZ(z: number): void;
  sampler(): HistogramSampler;
  display(): DisplayPipeline;
  channelStates(): IChannelState[];
  /** Whether display round `token` is still the current one (see OsdTileRecolorer). */
  isCurrentDisplay(token: number): boolean;
  /** Queue a coalesced display round (for the serverless multichannel recomposite). */
  scheduleInvalidate(): void;
}

/** OSD's single-image source for a directly-loadable URL. */
function imageSource(url: string): Parameters<OpenSeadragon.Viewer['open']>[0] {
  return { type: 'image', url } as unknown as Parameters<OpenSeadragon.Viewer['open']>[0];
}

/** Skip the full-res upscale above this longest-side dimension — a folder
 *  stack is per-file previews (well under this); this only guards against an
 *  accidental enormous canvas allocation. */
const SIMPLE_UPSCALE_MAX_DIM = 8192;

/**
 * The "simple" (`tiled: false`) image source: self-contained per-slice URLs and
 * no tile server — e.g. a numbered image series assembled client-side into a
 * stack, or the processing-pipeline preview. Each slice is resampled to the
 * full-resolution size so regions align and opened as OSD's single-image source;
 * a SERVERLESS multichannel image is composited client-side from its per-channel
 * planes (kept OFF the tiled per-channel path).
 *
 * Owns every piece of simple-mode state and is the single place that resets it,
 * so none of it can outlive the simple image (OSD-PLOTLY-1).
 */
export class OsdSimpleSource {
  /** True while the mounted image is simple: setZIndex re-opens the viewer on
   *  the new slice's URL instead of toggling a tiled slice. */
  active = false;
  /** urls[] of the mounted simple image, for the slice being scrubbed to. */
  urls: string[] = [];
  /** preview blob URL → full-res resampled blob URL (see toFullResUrl), so
   *  re-visiting a slice doesn't re-resample. Revoked on file change. */
  private readonly fullResUrls = new Map<string, string>();
  /** SERVERLESS multichannel (tiled:false + channelCount>1): the stack's
   *  per-slice per-channel plane URLs, the current slice's decoded planes, and
   *  the displayed composite blob URL. */
  multichannel = false;
  channelUrls: string[][] = [];
  channelPlanes: SimplePlane[] = [];
  compositeUrl: string | null = null;

  constructor(private readonly host: SimpleSourceHost, private readonly simpleStack: SimpleSliceAccessService) {}

  /** Forget the simple image's state: mode, slice URLs and the serverless-
   *  multichannel flag, URLs and decoded planes. Called when a tiled image is
   *  mounted and on teardown; {@link commit} sets it from an {@link OsdLoaded}. */
  reset(): void {
    this.active = false;
    this.urls = [];
    this.multichannel = false;
    this.channelUrls = [];
    this.channelPlanes = [];
  }

  /** Revoke every blob URL this source created (a different file was selected). */
  revokeUrls(): void {
    for (const u of this.fullResUrls.values()) URL.revokeObjectURL(u);
    this.fullResUrls.clear();
    if (this.compositeUrl) { URL.revokeObjectURL(this.compositeUrl); this.compositeUrl = null; }
  }

  /** Build the `plot()` payload for a simple (tiled:false) image: a single-level
   *  descriptor sized from `trueImageSize`, plus the directly-loadable URL —
   *  resolved and fetched via {@link SimpleSliceAccessService} (shared with
   *  napari-js; see its docs for why this can't be a raw `fetch()`/`<img>`).
   *  Those fetches take no signal, so an abort is honoured once they settle. */
  async load(imageInfo: IImageInfo, zIndex: number, signal?: AbortSignal): Promise<OsdLoaded> {
    const z = zIndex || 0;
    const filename = imageInfo?.fileName;
    const [width, height] = imageInfo.trueImageSize ?? [0, 0];
    const meta = imageInfo.imageMeta?.[0];
    // SERVERLESS MULTICHANNEL: composite the slice's per-channel planes
    // client-side (no tile server), driven by the channel pane.
    // Everything is computed into locals and returned: the image on screen keeps
    // its state until plot() commits this payload.
    const chUrls = imageInfo.channelUrls;
    const multichannel = !!chUrls?.length && (meta?.channelCount ?? 1) > 1;
    let url: string | undefined;
    let channelPlanes: SimplePlane[] | undefined;
    if (multichannel) {
      try {
        channelPlanes = await this.loadChannelPlanes(chUrls![z] ?? chUrls![0]);
        url = await this.composite(channelPlanes);
        // NB: histograms are binned in plot(), AFTER destroyViewer clears the
        // sampler — computing them here would be wiped by that clear.
      } catch (err) {
        console.warn('[OSD] simple multichannel composite failed', err);
      }
    } else {
      const rawUrl = this.simpleStack.urlFor(imageInfo, z);
      if (rawUrl) {
        try {
          const previewUrl = await this.simpleStack.fetchAsBlobUrl(rawUrl);
          // Resample the (downscaled) preview to full resolution so OSD's world
          // matches the full-res ROI coordinate space — see toFullResUrl.
          url = await this.toFullResUrl(previewUrl, width, height);
        } catch (err) {
          console.warn('[OSD] simple-mode slice fetch failed', err);
        }
      }
    }
    throwIfAborted(signal);
    // No loadable URL (empty urls[] or the fetch failed): signal "couldn't
    // load" with a null descriptor — same as the tiled path when there's no
    // selected-file info — so plot() returns false (its `if (!d)` guard) and
    // the router can fall back, instead of mounting an <img> with an undefined
    // src that throws at runtime.
    if (!url) {
      console.warn('[OSD] simple-mode slice has no loadable URL; skipping OSD render', filename);
      return { descriptor: null, infoB64: '', z, filename };
    }
    const descriptor: TileDescriptor = {
      width,
      height,
      tileSize: 0,            // unused: simple mode never calls buildTileSource
      z: 1,                   // single frame
      channels: meta?.rgbChannels ?? (imageInfo.isGrayscale ? 1 : 3),
      multichannel: false,
      realLevels: 1,
      levels: [{ res: 0, width, height }],
      mppX: meta?.mppX ?? 0,
      mppY: meta?.mppY ?? 0,
    };
    return {
      descriptor,
      infoB64: '',
      z,
      filename,
      simple: true,
      url,
      ...(multichannel ? { channelUrls: chUrls as string[][], channelPlanes: channelPlanes ?? [] } : {}),
    };
  }

  /** Commit a mounted image's simple-mode state from its {@link OsdLoaded}
   *  payload (cleared for a tiled one). */
  commit(loaded: OsdLoaded, imageInfo: IImageInfo): void {
    this.active = !!loaded.simple;
    this.urls = loaded.simple ? (imageInfo?.urls ?? []) : [];
    this.commitMultichannel(loaded);
  }

  /** The simple image's new viewer is about to open `loaded.url` (the old viewer
   *  is gone): take ownership of its composite and bin its histograms — after
   *  the service's destroyViewer, whose last act is clearing the sampler. */
  mount(loaded: OsdLoaded): void {
    // The new viewer opens this image's composite (serverless multichannel):
    // the old viewer is gone, so its composite can go now.
    if (this.compositeUrl && this.compositeUrl !== loaded.url) {
      URL.revokeObjectURL(this.compositeUrl);
    }
    this.compositeUrl = this.multichannel ? (loaded.url ?? null) : null;
    // Multichannel bins each cached channel plane; single-band / RGB bins the
    // decoded frame's own pixels.
    if (this.multichannel) {
      this.host.sampler().computeSimpleMultichannelHistograms(loaded.z, this.channelPlanes);
    } else {
      void this.sampleHistogram(loaded.url, loaded.z);
    }
  }

  /**
   * The in-place (large-tier) pass for a mounted simple image. Simple mode has
   * no pyramid to fall back on: it displays literally whatever URL was last
   * opened, so without this swap the small tier's 128px placeholder would stay
   * on screen forever (pixelated, never "sharpening" like the tiled path).
   */
  refreshInPlace(loaded: OsdLoaded, imageInfo: IImageInfo): void {
    const viewer = this.host.viewer();
    if (!viewer || !loaded.simple || !loaded.url) return;
    // Also refresh urls to THIS phase's (large-tier) urls[] — it was set from
    // the small tier's 128px urls on the initial mount, which never runs again
    // for the in-place pass. Without this, setZIndex's later slider scrubs would
    // keep reading the small tier's low-res URLs forever, even though the
    // initial slice was correctly swapped to full resolution here.
    this.urls = imageInfo?.urls ?? this.urls;
    if (loaded.channelPlanes) {
      this.commitMultichannel(loaded);
      this.openComposite(loaded.url);
    } else {
      viewer.open(imageSource(loaded.url));
    }
  }

  /**
   * Show slice `z` of the mounted simple image. Each slice is its own complete
   * image (no pyramid to toggle opacity on), so this re-opens the viewer on the
   * new slice's URL; the viewer's preserveViewport keeps the current zoom/pan.
   * Scrubs can resolve out of order: only the current slice may land.
   */
  setZIndex(z: number): void {
    if (this.multichannel) {
      const urls = this.channelUrls[z] ?? this.channelUrls[0];
      if (!urls) return;
      this.host.setCurrentZ(z);
      // A different image commits a new channelUrls array (see commit()).
      const image = this.channelUrls;
      void (async () => {
        const planes = await this.loadChannelPlanes(urls);
        // Only the current slice's planes may land, or a later recomposite
        // would show the wrong slice.
        if (this.host.currentZ() !== z || this.channelUrls !== image || !this.host.viewer()) return;
        this.channelPlanes = planes;
        this.host.sampler().computeSimpleMultichannelHistograms(z, planes);
        this.host.scheduleInvalidate(); // recomposite + open, coalesced with slider changes
      })();
      return;
    }
    const rawUrl = this.urls[z] ?? this.urls[0];
    if (!rawUrl) return;
    this.host.setCurrentZ(z);
    // Fetched via SimpleSliceAccessService (auth interceptor applies) then
    // resampled to full-res (same as the initial load — see toFullResUrl) so
    // the world stays full-res across slices and ROIs keep aligning. Guard
    // against a newer scrub landing first.
    const d = this.host.descriptor();
    this.simpleStack.fetchAsBlobUrl(rawUrl)
      .then((previewUrl) => this.toFullResUrl(previewUrl, d?.width ?? 0, d?.height ?? 0))
      .then((url) => {
        const viewer = this.host.viewer();
        if (this.host.currentZ() !== z || !viewer) return;
        viewer.open(imageSource(url));
        void this.sampleHistogram(url, z); // re-bin the scrubbed slice
      })
      .catch((err) => console.warn('[OSD] slice fetch failed', err));
  }

  /**
   * OSD's `{type:'image'}` source sizes its coordinate world to the image's
   * NATURAL pixels. A folder-stack slice is a server `/preview` whose pixel size
   * needn't match the full-resolution image — it may be downscaled (large
   * images) OR larger than the dimensions `/metadata` reports. Either way OSD's
   * world would differ from the full-res ROI coordinate space (QuPath geojson,
   * in level-0 pixels): a smaller preview renders ROIs oversized, a larger one
   * renders them undersized/offset. Resample the preview to EXACTLY the
   * full-resolution dimensions (blurry but positionally exact — scaling up or
   * down as needed) so OSD's world matches the ROI coordinate space, while still
   * using OSD's reliable single-image renderer. Cached per preview URL (revoked
   * on file change); a no-op when the preview is already exactly full-res (small
   * images, in-memory pipeline blobs), when the dims are unknown, or when
   * they're implausibly large (guards against an enormous canvas). (jit-ui#93)
   */
  async toFullResUrl(previewUrl: string, width: number, height: number): Promise<string> {
    if (!width || !height || Math.max(width, height) > SIMPLE_UPSCALE_MAX_DIM) return previewUrl;
    const cached = this.fullResUrls.get(previewUrl);
    if (cached) return cached;
    let img: HTMLImageElement;
    try {
      img = await this.loadImageEl(previewUrl);
    } catch {
      return previewUrl; // couldn't decode — let OSD try the URL as-is
    }
    // Already the exact full-res world — no resample needed. (A preview that is
    // larger OR smaller than full-res must still be resized so OSD's world ==
    // the ROI coordinate space; only an exact match is skippable.)
    if (img.naturalWidth === width && img.naturalHeight === height) return previewUrl;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return previewUrl;
    ctx.drawImage(img, 0, 0, width, height); // scale preview (up or down) to full-res
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve));
    if (!blob) return previewUrl;
    const fullResUrl = URL.createObjectURL(blob);
    this.fullResUrls.set(previewUrl, fullResUrl);
    return fullResUrl;
  }

  /** Sample a slice's own decoded pixels into the histogram — the serverless
   *  analog of the tiled samplers (no tile server). Fire-and-forget; a decode
   *  failure just leaves the pane empty rather than throwing. */
  private async sampleHistogram(url: string | undefined, z: number): Promise<void> {
    if (!url) return;
    try {
      const px = await this.decodeUrlToRgba(url);
      if (px) this.host.sampler().computeSimpleHistogram(z, px.data, this.host.isGrayscale());
    } catch (err) {
      console.warn('[OSD] simple-mode histogram sample failed', err);
    }
  }

  /** Fetch + decode a slice's per-channel planes (single-band grayscale) into
   *  pixel buffers, for the serverless multichannel compositor. Auth-safe: goes
   *  through SimpleSliceAccessService (blob:/data: as-is; http via HttpClient).
   *  The channels are fetched in parallel; plane c stays at index c, and a
   *  plane that fails to load is empty (the compositor skips it). */
  async loadChannelPlanes(urls: string[] | undefined): Promise<SimplePlane[]> {
    const empty = (): SimplePlane => ({ data: new Uint8ClampedArray(0), width: 0, height: 0 });
    return Promise.all((urls ?? []).map(async (u) => {
      try {
        const px = await this.decodeUrlToRgba(await this.simpleStack.fetchAsBlobUrl(u));
        return px ? { data: px.data, width: px.width, height: px.height } : empty();
      } catch (err) {
        console.warn('[OSD] channel plane decode failed', err);
        return empty();
      }
    }));
  }

  /** Composite per-channel planes into ONE RGBA image using the current channel
   *  states (colour/window/gamma/visibility) — the client-side analog of the
   *  tiled per-channel 'lighter' compositor (same display.channelRgbLut math as
   *  the channel-tile recolor, applied per-plane). Returns a new blob: URL of the
   *  composite PNG, owned by the caller (see {@link openComposite}). */
  async composite(planes: SimplePlane[]): Promise<string | undefined> {
    if (!planes.length) return undefined;
    const w = planes[0].width, h = planes[0].height;
    if (!w || !h) return undefined;
    const out = this.host.display().compositeChannels(
      planes.map((p) => (p.width === w && p.height === h ? p.data : null)),
      this.host.channelStates(),
    );
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.putImageData(new ImageData(out, w, h), 0, 0);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) return undefined;
    return URL.createObjectURL(blob);
  }

  /** Re-composite the current slice from its cached planes (new channel states)
   *  and re-open — the serverless analog of the tiled invalidate-on-channel-change.
   *  Runs from the recolorer's invalidateDisplay, so it is coalesced per frame,
   *  and drops its composite once a newer display round (`token`) has started. */
  async recompositeAndOpen(token: number): Promise<void> {
    const url = await this.composite(this.channelPlanes);
    if (!url) return;
    if (!this.host.isCurrentDisplay(token) || !this.host.viewer()) {
      URL.revokeObjectURL(url); // superseded — never displayed
      return;
    }
    this.openComposite(url);
  }

  /** Open a serverless-multichannel composite and take ownership of its URL. The
   *  previously displayed composite is revoked only once this open settles: an
   *  `open()` still decoding a revoked blob: URL fails. */
  private openComposite(url: string): void {
    const viewer = this.host.viewer();
    if (!viewer) return;
    const prev = this.compositeUrl;
    this.compositeUrl = url;
    if (prev && prev !== url) {
      const revokePrev = () => {
        viewer.removeHandler('open', revokePrev);
        viewer.removeHandler('open-failed', revokePrev);
        URL.revokeObjectURL(prev);
      };
      viewer.addHandler('open', revokePrev);
      viewer.addHandler('open-failed', revokePrev);
    }
    viewer.open(imageSource(url));
  }

  /** Commit the serverless-multichannel part of an {@link OsdLoaded} payload. */
  private commitMultichannel(loaded: OsdLoaded): void {
    this.multichannel = !!loaded.channelPlanes;
    this.channelUrls = loaded.channelUrls ?? [];
    this.channelPlanes = loaded.channelPlanes ?? [];
  }

  /** Decode an image URL to RGBA pixels (null for an empty image or no 2d
   *  context). Throws when the URL can't be decoded. */
  async decodeUrlToRgba(url: string): Promise<ImageData | null> {
    const img = await this.loadImageEl(url);
    const w = img.naturalWidth, h = img.naturalHeight;
    return w && h ? readRgba(img, w, h) : null;
  }

  /** Load a URL into an HTMLImageElement (resolves once decoded). */
  loadImageEl(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = document.createElement('img');
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
      img.src = url;
    });
  }
}
