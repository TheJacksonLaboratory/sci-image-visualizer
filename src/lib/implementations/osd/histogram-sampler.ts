import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom, from, of } from 'rxjs';
import { timeout } from 'rxjs/operators';

import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import { buildTileUrl, fetchTileRgba } from './tile-client';
import { histogram256, maxRgb } from '../../contracts/intensity';

/**
 * Histogram + auto-window sampling for the OSD backend (refactoring plan,
 * Step 4 — a pure move out of the visualizer service). Owns the per-slice
 * 8-bit histograms (sampled from displayed tiles) and the native-bit-depth
 * histograms (fetched from the server `/histogram` endpoint). Read-only with
 * respect to the tile/display pipeline.
 */

/** The descriptor fields the samplers read (structurally satisfied by the
 *  service's TileDescriptor). */
export interface SampledDescriptor {
  width: number;
  height: number;
  tileSize: number;
  channels?: number;
  levels?: Array<{ width: number; height: number }>;
}

export interface HistogramSamplerHost {
  /** Real Bio-Formats levels (per-channel tiles exist only there). */
  realLevels(): number;
  /** Channel count for the multichannel sampler. */
  channelCount(d: SampledDescriptor): number;
  /** Grayscale (intensity histogram + auto-window) vs RGB (R/G/B histograms). */
  isGrayscale(): boolean;
  /** Histograms landed — nudge the pane to re-read (its retry window may have
   *  lapsed). */
  onChannelHistogramsSampled(): void;
  /** A grayscale auto-window was measured from full-res tiles — seed the
   *  Intensity channel (or re-invalidate if the user already windowed). */
  onGrayWindowSampled(min: number, max: number): void;
}

export class HistogramSampler {
  /** 256-bin intensity histogram per z-slice, from sampled tiles. */
  private sliceHistograms = new Map<number, IHistogram[]>();
  /** Native-bit-depth histograms from `/histogram`, keyed `${z}|${channel}`. */
  private nativeHistograms = new Map<string, IHistogram>();
  /** Per-app-load cache-buster for `/histogram` — the server marks the
   *  response cacheable for 24h, and a hard refresh can't bust a post-load
   *  XHR. A token stable within a session but new on each full load keeps the
   *  in-session dedup (via `nativeHistograms`) while always reflecting the
   *  live backend after a reload. */
  private readonly histCacheBuster = Date.now();

  constructor(
    private http: HttpClient,
    private api: string,
    private host: HistogramSamplerHost,
  ) {}

  /** The sampled histogram for one channel of slice z, or null until the
   *  async sampling resolves (or if it was skipped). */
  get(z: number, channelIndex: number): IHistogram | null {
    return this.sliceHistograms.get(z)?.[channelIndex] ?? null;
  }

  /** Drop everything (teardown / image switch). */
  clear(): void {
    this.sliceHistograms.clear();
    this.nativeHistograms.clear();
  }

  /**
   * Per-channel intensity histograms for multichannel images: sample each
   * channel's single-band tiles at the coarsest real level and bin the
   * luminance. Fire-and-forget.
   */
  async computeMultiChannelHistograms(d: SampledDescriptor, infoB64: string, z: number): Promise<void> {
    try {
      const t = d.tileSize;
      // Sample the COARSEST real level (per-channel tiles exist only at real
      // resolutions; the coarsest is small enough to bin even for whole-slides).
      const res = Math.max(0, this.host.realLevels() - 1);
      const lvl = d.levels?.[res];
      const lw = lvl?.width ?? d.width;
      const lh = lvl?.height ?? d.height;
      const cols = Math.max(1, Math.ceil(lw / t));
      const rows = Math.max(1, Math.ceil(lh / t));
      if (cols * rows > 64) return; // even the coarsest real level is too big
      const nCh = this.host.channelCount(d);
      if (nCh < 1) return;
      const counts: number[][] = Array.from({ length: nCh }, () => new Array(256).fill(0));
      const jobs: Array<Promise<void>> = [];
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          for (let c = 0; c < nCh; c++) {
            const url = buildTileUrl(this.api, infoB64, { res, col, row, z, tileSize: t, channel: c });
            jobs.push(
              (async () => {
                try {
                  const img = await fetchTileRgba(this.http, url, 20000);
                  if (!img) return;
                  const data = img.data;
                  const cc = counts[c];
                  for (let i = 0; i < data.length; i += 4) {
                    if (data[i + 3] === 0) continue;
                    cc[maxRgb(data[i], data[i + 1], data[i + 2])]++;
                  }
                } catch (err) {
                  // Skip this tile — the histogram is just missing its counts.
                  console.warn('[viz:histogram] channel tile sample failed, skipping', url, err);
                }
              })(),
            );
          }
        }
      }
      await Promise.all(jobs);
      this.sliceHistograms.set(z, counts.map((c) => histogram256(c)));
      this.host.onChannelHistogramsSampled();
    } catch (err) {
      // Leave histograms unset (the pane shows empty) — but say why.
      console.warn('[viz:histogram] multichannel histogram sampling failed', err);
    }
  }

  /**
   * Compute a per-image intensity window [min,max] for grayscale auto-ranging,
   * mirroring the heatmap's auto-stretch. Two constraints force the sampling
   * strategy:
   *  - The window MUST be in the same value space as the displayed tiles: the
   *    `/preview` endpoint is server-normalized while `/tile` serves raw
   *    un-normalized 8-bit — a window from the preview wouldn't match.
   *  - It must read FULL-RESOLUTION tiles, not a downsampled overview:
   *    averaging sparse low values (label masks) toward 0 wipes the signal.
   * So we sample the full-res level across the whole image — bounded to 64
   * tiles (a huge grayscale image samples the coarsest overview for histograms
   * only). Fire-and-forget; failures leave the window unset (identity 0..255).
   */
  async computeImageWindow(d: SampledDescriptor, infoB64: string, z: number): Promise<void> {
    const gray = this.host.isGrayscale();
    try {
      const t = d.tileSize;
      // Sample full-resolution when the grid is small (accurate for the grayscale
      // auto-window); otherwise sample the coarsest overview just for histograms
      // (whole-slide images). RGB only needs the histograms, not an auto-window.
      let res = 0;
      let cols = Math.max(1, Math.ceil(d.width / t));
      let rows = Math.max(1, Math.ceil(d.height / t));
      let fullRes = true;
      if (cols * rows > 64) {
        res = Math.max(0, (d.levels?.length ?? 1) - 1);
        const lvl = d.levels?.[res];
        cols = Math.max(1, Math.ceil((lvl?.width ?? d.width) / t));
        rows = Math.max(1, Math.ceil((lvl?.height ?? d.height) / t));
        fullRes = false;
        if (cols * rows > 36) return; // even the coarsest is too big — give up
      }
      const coords: Array<[number, number]> = [];
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) coords.push([col, row]);
      }
      let min = 255;
      let max = 0;
      const cR = new Array(256).fill(0);
      const cG = gray ? null : new Array(256).fill(0);
      const cB = gray ? null : new Array(256).fill(0);
      await Promise.all(
        coords.map(async ([col, row]) => {
          const url = buildTileUrl(this.api, infoB64, { res, col, row, z, tileSize: t });
          try {
            const img = await fetchTileRgba(this.http, url, 20000);
            if (!img) return;
            const data = img.data;
            for (let i = 0; i < data.length; i += 4) {
              if (data[i + 3] === 0) continue; // skip transparent padding
              if (gray) {
                const v = maxRgb(data[i], data[i + 1], data[i + 2]);
                if (v < min) min = v;
                if (v > max) max = v;
                cR[v]++;
              } else {
                cR[data[i]]++;
                cG![data[i + 1]]++;
                cB![data[i + 2]]++;
              }
            }
          } catch (err) {
            // Skip this tile — window/histogram just lose its samples.
            console.warn('[viz:window] tile sample failed, skipping', url, err);
          }
        }),
      );
      // Cache per-channel histograms: grayscale → [intensity]; RGB → [R, G, B].
      this.sliceHistograms.set(
        z, gray ? [histogram256(cR)] : [histogram256(cR), histogram256(cG!), histogram256(cB!)],
      );
      // Grayscale auto-window — only from full-res samples (coarsest averaging
      // is inaccurate); the host seeds the channel or re-invalidates.
      if (gray && fullRes && max > min && (min > 0 || max < 255)) {
        this.host.onGrayWindowSampled(min, max);
      }
    } catch (err) {
      console.warn('[viz:window] per-image window compute failed — using identity 0..255', err);
    }
  }

  /**
   * Client-side histogram for the SIMPLE (`tiled:false`) path: bin an
   * already-decoded RGBA frame's OWN pixels — no tile server, no fetch. Same
   * output shape as {@link computeImageWindow}: grayscale → [intensity];
   * RGB → [R, G, B]. This is what lets the Channels & Histogram pane work for
   * serverless images (the processing-pipeline preview, DICOM/TIFF stacks),
   * which never hit the tile / `/histogram` endpoints.
   */
  computeSimpleHistogram(z: number, data: Uint8ClampedArray | Uint8Array, gray: boolean): void {
    const cR = new Array(256).fill(0);
    const cG = gray ? null : new Array(256).fill(0);
    const cB = gray ? null : new Array(256).fill(0);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue; // skip transparent padding
      if (gray) {
        cR[maxRgb(data[i], data[i + 1], data[i + 2])]++;
      } else {
        cR[data[i]]++;
        cG![data[i + 1]]++;
        cB![data[i + 2]]++;
      }
    }
    this.sliceHistograms.set(
      z, gray ? [histogram256(cR)] : [histogram256(cR), histogram256(cG!), histogram256(cB!)],
    );
    this.host.onChannelHistogramsSampled();
  }

  /**
   * Native-bit-depth histogram for >8-bit images, from the server `/histogram`
   * endpoint (the 8-bit canvas tiles can't carry 16-bit values). Cached per
   * slice+channel for the session.
   */
  native$(infoB64: string, z: number, channel: number, bins: number): Observable<IHistogram | null> {
    const key = `${z}|${channel}`;
    const cached = this.nativeHistograms.get(key);
    if (cached) return of(cached);
    return from(this.fetchNative(infoB64, z, channel, bins, key));
  }

  /** Fetch + cache one channel's native histogram from `GET /histogram`. */
  private async fetchNative(
    infoB64: string, z: number, channel: number, bins: number, key: string,
  ): Promise<IHistogram | null> {
    const url = `${this.api}histogram?info=${infoB64}&channel=${channel}&z=${z}&bins=${bins}&_=${this.histCacheBuster}`;
    try {
      // HttpClient calls get auth via the Angular interceptor (unlike OSD's own
      // ajax tile loader, which needs authHeaders) — mirror the other fetches.
      const hi = await firstValueFrom(
        this.http
          .get<{
            bitDepth: number; rangeMin: number; rangeMax: number;
            observedMin: number; observedMax: number; binWidth: number; counts: number[];
          }>(url)
          .pipe(timeout(45000)),
      );
      if (!hi || !hi.counts) return null;
      const out: IHistogram = {
        // Native bin left-edges: rangeMin + i*binWidth.
        bins: hi.counts.map((_, i) => hi.rangeMin + i * hi.binWidth),
        counts: hi.counts,
        max: hi.counts.reduce((m, c) => (c > m ? c : m), 0),
        bitDepth: hi.bitDepth,
        rangeMin: hi.rangeMin,
        rangeMax: hi.rangeMax,
        observedMin: hi.observedMin,
        observedMax: hi.observedMax,
      };
      this.nativeHistograms.set(key, out);
      return out;
    } catch (err) {
      // 202 (still caching) or a transient error → null; the pane retries.
      console.warn('[viz:histogram] native histogram fetch failed', err);
      return null;
    }
  }
}
