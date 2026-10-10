import { Inject, Injectable, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, Subject, Subscription } from 'rxjs';
import { Image } from 'image-js';
import { Buffer } from 'buffer';

import { IIntensityControls, IntensityProfile } from '../contracts/visualizer.contract';
import { IImageInfo } from '../contracts/image.contract';
import { TileAccessPort, TILE_ACCESS_PORT } from '../contracts/ports/tile-access.port';
import { ImageStatePort, IMAGE_STATE_PORT } from '../contracts/ports/image-state.port';
import { Polygon, Rectangle, Region } from '../models/region';
import { RegionStore } from '../store/region-store.service';
import { PlotUtilities } from '../plot.utilities';
import {
  PROFILE_PALETTE, PixelRect, ProfileLine, imageMpp, placeProfileLine, profileLineOf, sampleLine,
} from './intensity-profile';

/** The pixels the profiles are sampled from, and the image they belong to. */
export interface IntensityFrames {
  /** Per-z-plane pixel matrices (grayscale numbers or `[r, g, b]` cells). */
  frames: any[];
  /** [xRatio, yRatio]: image units per frame pixel. */
  ratios: number[];
  /** Image coordinate of the frames' pixel (0,0); [0,0] unless a zoom crop. */
  origin?: [number, number];
}

/** The image the frames come from: its extent (for line placement) and its
 *  metadata (pixel size, grayscale). */
export interface IntensityImage {
  imageInfo: IImageInfo;
  /** [x0, x1, y0, y1] in image units. */
  extent: number[];
  /** The displayed z-plane, when the frames hold a stack. */
  frameIndex?: () => number;
}

/**
 * Intensity profiles along line ROIs (PlotType.LINE), for every backend.
 *
 * Profile lines are ordinary RegionStore regions tagged `kind: 'profile'`; any
 * region change re-samples and re-emits every line's profile. The service owns
 * its OWN sampling frames — a backend's tool readback never doubles as the
 * profile source (OSD-PLOTLY-2) — filled by Plotly when it renders or high-def
 * zooms, and fetched here for the other backends: the displayed slice
 * ({@link ensureIntensitySampling}) and, on zoom/pan, a display-resolution
 * crop of the visible region ({@link refreshIntensitySamplingForRoi}). Every
 * sampling write supersedes the async ones before it.
 *
 * Per viewer: listed in `provideVisualization()` with the RegionStore it
 * listens to.
 */
@Injectable({ providedIn: 'root' })
export class IntensityProfileService implements IIntensityControls, OnDestroy {
  private frames: IntensityFrames | null = null;
  private image: IntensityImage | null = null;
  /** The last visible image-pixel rect a backend reported (new lines go there). */
  private lastVisibleRoi: PixelRect | null = null;
  /** Palette cursor (never reset on delete, so colours keep cycling). */
  private colorSeq = 0;
  /** Bumped by every sampling write request: an async fetch lands only if no
   *  newer one was requested meanwhile. */
  private gen = 0;
  /** The element whose parent sizes a crop request (the viewer's plot div). */
  private elementId = '';
  /** The host's selected file, so a crop for a previous file is dropped. */
  private fileName: string | undefined;
  private readonly profiles$ = new Subject<IntensityProfile[]>();
  private readonly subs = new Subscription();
  private readonly utils = new PlotUtilities();

  constructor(private readonly http: HttpClient,
              @Inject(TILE_ACCESS_PORT) private readonly tiles: TileAccessPort,
              @Inject(IMAGE_STATE_PORT) state: ImageStatePort,
              private readonly regionStore: RegionStore) {
    this.subs.add(state.getFilename$().subscribe((f) => { this.fileName = f; }));
    // Profile lines are store regions: any change (add/drag/delete, on any
    // backend) refreshes the inset. The live-edit stream fires per frame during
    // a drag (OSD coalesces regionUpdate$ until release), so the inset tracks it.
    this.subs.add(regionStore.getRegionUpdateEvent().subscribe(() => this.emitProfiles()));
    this.subs.add(regionStore.getRegionLiveEdit$().subscribe(() => this.emitProfiles()));
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  /** Every profile line's profile, re-emitted whenever one is added, moved or removed. */
  getIntensityProfile$(): Observable<IntensityProfile[]> {
    return this.profiles$.asObservable();
  }

  /** The element (by id) whose size a crop request is made for. */
  setSamplingElement(id: string): void {
    this.elementId = id;
  }

  /** Supersede every sampling fetch in flight; returns the new generation. */
  supersede(): number {
    return ++this.gen;
  }

  /** Whether `gen` (from {@link supersede}) is still the latest sampling request. */
  isCurrent(gen: number): boolean {
    return gen === this.gen;
  }

  /** Sample from these frames from now on — of `image`, or of the image already set. */
  setFrames(frames: IntensityFrames, image?: IntensityImage): void {
    this.frames = { ...frames, origin: frames.origin ?? [0, 0] };
    if (image) this.image = image;
  }

  /**
   * Fetch the displayed slice's preview for sampling (the same pixels a heatmap
   * would sample), for a backend that has no frames of its own (OpenSeadragon,
   * napari-js). Re-emits the profiles once loaded.
   */
  async ensureIntensitySampling(imageInfo: IImageInfo, zIndex: number): Promise<void> {
    if (!imageInfo?.urls?.length) return;
    const gen = this.supersede();
    const slice = await this.loadSlice(imageInfo, zIndex || 0);
    if (!this.isCurrent(gen)) return; // superseded (another image / a crop)
    this.setFrames({ frames: [slice.frame], ratios: slice.ratios }, {
      imageInfo,
      extent: [0, imageInfo.trueImageSize[0], 0, imageInfo.trueImageSize[1]],
    });
    this.emitProfiles();
  }

  /**
   * Re-fetch the given image-pixel ROI at the display resolution and sample from
   * it, so the profile reflects the data at the current zoom level. Also
   * remembers the ROI, so a new line is placed inside it.
   */
  refreshIntensitySamplingForRoi(x: number, y: number, width: number, height: number, zIndex: number): void {
    if (width <= 0 || height <= 0) return;
    this.lastVisibleRoi = { x, y, width, height };
    const roi = Object.assign(new Rectangle(), {
      x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height),
    });
    // Sized from the viewer's own plot div, not a host element id (CORE-24).
    const screen = this.utils.getDomRectangle(this.elementId);
    const reqName = this.fileName;
    const gen = this.supersede();
    this.tiles.zoomOnRegion(roi, screen, zIndex || 0).subscribe({
      next: (zoomData) => {
        Image.load(Buffer.from(new Uint8Array(zoomData))).then((image: any) => {
          if (this.fileName !== reqName || !this.isCurrent(gen)) return;
          const frame = this.toMatrix(image, !!this.image?.imageInfo?.isGrayscale);
          this.setFrames({
            frames: [frame], ratios: [roi.width / image.width, roi.height / image.height], origin: [roi.x, roi.y],
          });
          this.emitProfiles();
        });
      },
      error: () => { /* keep the previous sampling frame on a failed crop fetch */ },
    });
  }

  /**
   * Add another profile line: a horizontal open 2-point polyline in the next
   * palette colour, placed by {@link placeProfileLine}, added to the shared
   * store so every backend renders and drags it (and excluded from the Regions
   * tab and exports by its kind). Null until an image extent is known.
   */
  addProfileLine(): Region | null {
    const extent = this.image?.extent;
    if (!extent) return null;
    const { x0, x1, y } = placeProfileLine(extent, this.lastVisibleRoi, this.profileRegions().length);
    const poly = new Polygon();
    poly.npoints = 2;
    poly.xpoints = [x0, x1];
    poly.ypoints = [y, y];
    poly.coordinates = [[x0, y], [x1, y]];
    poly.closed = false;
    const region = new Region();
    region.bounds = poly;
    region.kind = 'profile';
    region.color = PROFILE_PALETTE[this.colorSeq++ % PROFILE_PALETTE.length];
    // region.label stays undefined so applyClassificationColors won't recolor it.
    this.regionStore.addRegion(region);
    return region;
  }

  /** Recompute and broadcast every profile line's profile (tagged with the
   *  line's id and colour, so the inset trace matches its line). */
  emitProfiles(): void {
    this.profiles$.next(this.profileRegions().map((r) => {
      const line = profileLineOf(r);
      return {
        ...(line ? this.computeIntensityProfile(line) : { positions: [], values: [] }),
        id: r.id,
        color: r.color,
      };
    }));
  }

  /** Sample the active frame along `line` (see sampleLine). */
  computeIntensityProfile(line: ProfileLine): IntensityProfile {
    const empty: IntensityProfile = { positions: [], values: [] };
    const frames = this.frames?.frames;
    if (!frames?.length || !line) return empty;
    const index = frames.length <= 1 ? 0 : (this.image?.frameIndex?.() ?? 0);
    const frame = frames[index] ?? frames[0];
    if (!frame?.length) return empty;
    return sampleLine({ frame, ratios: this.frames!.ratios, origin: this.frames!.origin! }, line,
      imageMpp(this.image?.imageInfo?.imageMeta));
  }

  /** The profile-line regions in the store. */
  private profileRegions(): Region[] {
    return this.regionStore.getRegions().filter((r) => r.kind === 'profile');
  }

  /** Fetch one slice through HttpClient (auth interceptors apply) and decode it. */
  private async loadSlice(imageInfo: IImageInfo, z: number): Promise<{ frame: any[]; ratios: number[] }> {
    const url = imageInfo.urls[z] || imageInfo.urls[0];
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) =>
      this.http.get(url, { responseType: 'arraybuffer' }).subscribe({ next: resolve, error: reject }));
    const image = await Image.load(Buffer.from(buffer));
    return {
      frame: this.toMatrix(image, !!imageInfo.isGrayscale),
      ratios: [imageInfo.trueImageSize[0] / image.width, imageInfo.trueImageSize[1] / image.height],
    };
  }

  private toMatrix(image: any, isGrayscale: boolean): any[] {
    return isGrayscale
      ? this.utils.arrayToMatrix(Array.from(image.grey().data), image.width)
      : this.utils.arrayToMatrix(image.getPixelsArray(), image.width);
  }
}
