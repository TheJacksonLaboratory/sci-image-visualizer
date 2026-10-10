import type { Viewer } from 'napari-js';

import { CanvasToolId } from '../../contracts/display-types';
import { ICoordinateTransform } from '../../contracts/coordinate-transform.contract';
import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import { PixelData } from '../../contracts/visualizer.contract';
import { ICellSegmenter } from '../../contracts/cell-segmenter.contract';
import { RegionStore } from '../../store/region-store.service';
import { CachedImageData, CanvasToolHost } from '../../toolbar/tool-kit/canvas-tool';
import { CanvasToolManager } from '../../toolbar/tool-kit/canvas-tool-manager';
import { createCanvasToolManager } from '../../toolbar/canvas-tools';
import { packedFrame } from '../../toolbar/tool-kit/frame-pixels';
import { WandService } from '../../toolbar/wand/wand.service';
import { SamToolService } from '../../toolbar/segmentation/sam-tool.service';
import { SamPointToolService } from '../../toolbar/segmentation/sam-point-tool.service';
import { CellSegmentToolService } from '../../toolbar/segmentation/cell-segment-tool.service';
import { NapariRegionOverlay, OverlayViewer } from './napari-region-overlay';
import { READBACK_DEBOUNCE_MS } from './napari-helpers';

/** A world-space rectangle (x, y = top-left). */
export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** ICoordinateTransform over the napari camera: pointer client coords ↔ image/world coords. */
export class NapariCoordinateTransform implements ICoordinateTransform {
  constructor(
    private readonly viewer: {
      canvasToWorld(clientX: number, clientY: number): [number, number];
      readonly camera: { zoom: number };
    },
    private readonly ready: () => boolean,
  ) {}
  clientToData(clientX: number, clientY: number): { x: number; y: number } {
    const [x, y] = this.viewer.canvasToWorld(clientX, clientY);
    return { x, y };
  }
  dataLengthToScreen(dataLength: number): number {
    return dataLength * this.viewer.camera.zoom; // CSS px per world unit
  }
  isReady(): boolean {
    return this.ready();
  }
}

/** What the bridge reads from the service: the live viewer and its DOM, the image on screen, and
 *  where the viewport and zone-crossing output go. */
export interface ToolBridgeHost {
  viewer(): Viewer | null;
  host(): HTMLElement | null;
  canvas(): HTMLCanvasElement | null;
  /** The image's full-resolution size, or null before one is drawn. */
  imageSize(): { width: number; height: number } | null;
  frameIndex(): number;
  fileName(): string | undefined;
  /** The visible region changed (clamped to the image); called outside the Angular zone. */
  viewportChanged(rect: WorldRect): void;
  /** Run `fn` outside / inside the Angular zone. */
  outsideZone<T>(fn: () => T): T;
  inZone<T>(fn: () => T): T;
}

/** The services the pixel tools and segmentation runs need. */
export interface ToolBridgeDeps {
  regionStore: RegionStore;
  wandService: WandService;
  samTool: SamToolService;
  samPointTool: SamPointToolService;
  cellSegmentTool: CellSegmentToolService;
  cellSegmenter: ICellSegmenter | null;
}

/**
 * The napari backend's side of the shared canvas tools (review Appendix B, step 4): the region
 * overlay, the {@link CanvasToolManager} and its host, the coordinate transform, and the
 * displayed-pixel readback the wand, brush, eraser and SAM/cellpose read — kept current as the
 * camera moves, but only paid for while a pixel tool needs it (NAPARI-SVC-26).
 *
 * One per service; {@link teardown} ends a scene's interaction (overlay, camera hook, timers,
 * pixels) and an `install…Interaction` starts the next one's.
 */
export class NapariToolBridge {
  /** What this backend's canvas tools read and write (one host for every tool). */
  readonly toolHost: CanvasToolHost;
  /** This backend's own wand, brush, eraser, zoom-to-box and SAM point tools. */
  readonly canvasTools: CanvasToolManager;
  /** SVG region-drawing overlay (null until a 2D/3D interaction is installed). */
  regionOverlay: NapariRegionOverlay | null = null;
  /** The pixel tools' pointer ↔ world transform for the current viewer. */
  coordTransform: ICoordinateTransform | null = null;
  /** The last readback of the displayed composite (the pixel tools' source). */
  lastPixels: PixelData | null = null;
  /** Visible world rect captured AT the last readback — must pair with `lastPixels` so the pixel
   *  tools' ratios/origin match the matrix's camera (using the live rect after a pan/zoom would
   *  mis-scale the region). */
  lastPixelsRect: WorldRect | null = null;
  /** Active tools that read the displayed pixels; a pan/zoom re-reads them only while non-empty. */
  readonly pixelTools = new Set<CanvasToolId>();
  /** The camera moved since {@link lastPixels} was read. */
  pixelsStale = false;
  /** Cached CachedImageData built from the last readback (rebuilt when lastPixels changes). */
  private cachedImage: CachedImageData | null = null;
  private cachedImageSource: PixelData | null = null;
  /** Debounced readback timer + camera-change unsubscribe (keep lastPixels current for tools). */
  private readbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Debounced viewport emission for a camera change that needs no pixels. */
  private viewportTimer: ReturnType<typeof setTimeout> | null = null;
  private cameraOff: (() => void) | null = null;

  constructor(private readonly host: ToolBridgeHost, private readonly deps: ToolBridgeDeps) {
    const { regionStore } = deps;
    // The pixel tools read displayed pixels synchronously from the last readback and convert
    // pointer coords via the napari camera, mirroring the OSD host. This backend owns its own tool
    // instances (RT-21); the host reads live state, so it is built once.
    this.toolHost = {
      getRegions: () => regionStore.getRegions(),
      setRegions: (r) => regionStore.setRegions(r),
      getCachedImageData: () => this.cachedImageData(),
      getActiveFrameIndex: () => host.frameIndex(),
      getOverlayContainer: () => host.host(),
      getCoordinateTransform: () => this.coordTransform as ICoordinateTransform,
      getFileName: () => host.fileName(),
      getShapeColor: () => regionStore.getShapeColor(),
      pixelToData: (px, py) => {
        const rect = host.host()?.getBoundingClientRect();
        const viewer = host.viewer();
        if (!viewer || !rect) return { x: 0, y: 0 };
        const [x, y] = viewer.canvasToWorld(rect.left + px, rect.top + py);
        return { x, y };
      },
      applyZoomToBox: (coords) => this.applyZoomToBox(coords),
    };
    this.canvasTools = createCanvasToolManager(this.toolHost, {
      wandService: deps.wandService, regionStore, samPoint: deps.samPointTool,
    });
  }

  /**
   * The interaction stack every 2D mode needs: the region overlay (draw/select/edit), the pixel
   * tools that read back displayed pixels (wand, brush, vertex eraser, zoom-to-box, SAM/cellpose),
   * and a camera hook that keeps that readback current as the view pans/zooms and tiled levels
   * load.
   *
   * One call for all of it because forgetting it is invisible: the toolbar gates its region buttons
   * on 2D-vs-3D rather than on plot type, so a 2D mode that skips this shows every tool and silently
   * does nothing. That is exactly what happened to the spatial and region-centroid scatter modes.
   */
  install2dInteraction(viewer: Viewer, host: HTMLElement): void {
    this.regionOverlay = new NapariRegionOverlay(host, viewer, this.deps.regionStore);
    this.buildCoordinateTransform();
    this.cameraOff = viewer.camera.changed.connect(() => this.onViewChanged());
  }

  /**
   * Region drawing for the 3D cloud.
   *
   * Reuses {@link NapariRegionOverlay} verbatim by handing it a SCREEN-SPACE viewer: the drawn
   * shape is a lasso in canvas pixels, so "world" is the canvas and both transforms are identity
   * (bar the client→canvas offset). Every existing tool — rectangle, polygon, freehand — therefore
   * works in 3D with no new drawing code.
   *
   * A screen-space shape stops meaning anything the moment the camera moves, so an orbit clears
   * the regions drawn in this view (and only those). The SELECTION they produced is kept: that is
   * the durable artefact, and the highlighted points stay highlighted from every angle.
   */
  install3dInteraction(viewer: Viewer, host: HTMLElement): void {
    const { regionStore } = this.deps;
    this.regionOverlay = new NapariRegionOverlay(host, this.screenSpaceViewer(viewer), regionStore);
    this.buildCoordinateTransform();
    // Regions already in the shared store when the 3D view mounted (the image's own, say) are
    // not screen-space shapes and must survive an orbit; only those drawn here are cleared.
    // (No mid-gesture case to guard: the overlay disables the camera controls while drawing.)
    const foreign = new Set(regionStore.getRegions().map((r) => r.id));
    this.cameraOff = viewer.camera3d.changed.connect(() => {
      const drawn = regionStore.getRegions().filter((r) => !foreign.has(r.id)).map((r) => r.id);
      // Not an edit of the user's: no undo step (NAPARI-SVC-11).
      if (drawn.length) this.host.inZone(() => regionStore.removeRegions(drawn, { recordUndo: false }));
    });
  }

  /**
   * The {@link OverlayViewer} the 3D region overlay draws through: "world" is the canvas, in
   * canvas-local CSS pixels. The overlay's contract is CLIENT pixels on both sides (it subtracts
   * its own rect, as for napari-js's `Viewer.worldToCanvas`), so both directions apply the
   * canvas's client offset — returning canvas-local pixels from `worldToCanvas` drew the lasso
   * offset from the cursor whenever the canvas was not at the page origin.
   */
  screenSpaceViewer(viewer: Viewer): OverlayViewer {
    const offset = (): [number, number] => {
      const r = this.host.canvas()?.getBoundingClientRect();
      return r ? [r.left, r.top] : [0, 0];
    };
    return {
      canvasToWorld: (clientX: number, clientY: number) => {
        const [left, top] = offset();
        return [clientX - left, clientY - top];
      },
      worldToCanvas: (x: number, y: number) => {
        const [left, top] = offset();
        return [x + left, y + top];
      },
      setControlsEnabled: (enabled: boolean) => viewer.setControlsEnabled(enabled),
      camera: viewer.camera3d,
    };
  }

  /** End the scene's interaction: the overlay, the camera hook, the pending timers and the
   *  pixels read from the old canvas. The armed tool and the pixel-tool set persist. */
  teardown(): void {
    this.regionOverlay?.destroy();
    this.regionOverlay = null;
    this.cachedImage = null;
    this.cachedImageSource = null;
    this.lastPixelsRect = null;
    if (this.readbackTimer != null) {
      clearTimeout(this.readbackTimer);
      this.readbackTimer = null;
    }
    if (this.viewportTimer != null) {
      clearTimeout(this.viewportTimer);
      this.viewportTimer = null;
    }
    this.pixelsStale = false;
    this.cameraOff?.();
    this.cameraOff = null;
    this.lastPixels = null;
  }

  /** Read the displayed composite into `lastPixels` (the pixel-tools' source) + emit the clamped
   *  visible region. A fresh PixelData object means cachedImageData() rebuilds automatically. */
  async runReadback(): Promise<void> {
    const v = this.host.viewer();
    if (!v) return;
    try {
      const px = await v.readDisplayedPixels();
      if (this.host.viewer() !== v) return;
      const rect = v.visibleWorldRect(); // capture WITH the pixels (same camera)
      this.lastPixels = px;
      this.lastPixelsRect = rect;
      this.pixelsStale = false;
      this.emitViewport(rect);
    } catch {
      /* readback unavailable (no device yet, or it was lost): the tools keep the last pixels */
    }
  }

  /** A readback on the next frame — after a plot or a scene change drew something new. */
  scheduleReadback(): void {
    if (!this.host.viewer()) return;
    this.host.outsideZone(() => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => void this.runReadback());
      else setTimeout(() => void this.runReadback(), 0);
    });
  }

  /** Debounced readback — armed on camera changes while a pixel tool is active, so `lastPixels`
   *  tracks the current view after a pan/zoom settles, which the on-canvas pixel tools
   *  (wand/brush/SAM) read synchronously. Coalesces rapid changes. */
  armReadback(delayMs = READBACK_DEBOUNCE_MS): void {
    if (this.readbackTimer != null) clearTimeout(this.readbackTimer);
    this.readbackTimer = this.host.outsideZone(() => setTimeout(() => {
      this.readbackTimer = null;
      void this.runReadback();
    }, delayMs));
  }

  /** Emit the visible region, clamped to the image. */
  private emitViewport(rect: WorldRect): void {
    const size = this.host.imageSize();
    if (!size || !rect) return;
    const x = Math.max(0, Math.min(size.width, rect.x));
    const y = Math.max(0, Math.min(size.height, rect.y));
    const width = Math.max(1, Math.min(size.width - x, rect.width));
    const height = Math.max(1, Math.min(size.height - y, rect.height));
    this.host.viewportChanged({ x, y, width, height });
  }

  /**
   * A 2D pan/zoom. The full-canvas GPU readback is paid for only while a pixel tool reads it
   * ({@link pixelTools}); otherwise only the viewport rect is emitted (debounced), and the pixels
   * are marked stale for whoever next needs them ({@link rgbHistogram} refreshes lazily, and a
   * tool arms a fresh readback as it activates).
   */
  private onViewChanged(): void {
    this.pixelsStale = true;
    if (this.pixelTools.size > 0) {
      this.armReadback(); // emits the viewport with the pixels
      return;
    }
    if (this.viewportTimer != null) clearTimeout(this.viewportTimer);
    this.viewportTimer = this.host.outsideZone(() => setTimeout(() => {
      this.viewportTimer = null;
      const viewer = this.host.viewer();
      if (viewer) this.emitViewport(viewer.visibleWorldRect());
    }, READBACK_DEBOUNCE_MS));
  }

  /** Build the pixel tools' coordinate transform for the current viewer. */
  private buildCoordinateTransform(): void {
    const viewer = this.host.viewer();
    if (!viewer) return;
    this.coordTransform = new NapariCoordinateTransform(
      viewer,
      () => !!this.host.viewer() && (this.host.imageSize()?.width ?? 0) > 0,
    );
  }

  /** Zoom/pan the camera to fit a data-space rectangle `[xMin, xMax, yMax, yMin]`. */
  private applyZoomToBox(coordinates: number[]): void {
    const v = this.host.viewer();
    const canvas = this.host.canvas();
    if (!v || !canvas || coordinates.length < 4) return;
    const [xMin, xMax, yA, yB] = coordinates;
    const x0 = Math.min(xMin, xMax);
    const x1 = Math.max(xMin, xMax);
    const y0 = Math.min(yA, yB);
    const y1 = Math.max(yA, yB);
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    const vw = canvas.clientWidth || w;
    const vh = canvas.clientHeight || h;
    v.camera.center = [(x0 + x1) / 2, (y0 + y1) / 2];
    v.camera.zoom = Math.min(vw / w, vh / h);
    v.requestRender();
  }

  /** Build CachedImageData from the most recent readback — its RGBA device pixels are the frame
   *  as-is (packed, no per-pixel arrays: NAPARI-SVC-23) — with ratios/origin mapping image coords
   *  ↔ readback pixels. Cached until the readback changes. */
  cachedImageData(): CachedImageData | null {
    const px = this.lastPixels;
    const viewer = this.host.viewer();
    if (!px || !viewer) return null;
    if (this.cachedImage && this.cachedImageSource === px) return this.cachedImage;
    const w = px.width;
    const h = px.height;
    // Use the rect captured WITH this readback (not the live one) so ratios/origin match the
    // matrix's camera — otherwise a pan/zoom since the readback mis-scales the traced region.
    const rect = this.lastPixelsRect ?? viewer.visibleWorldRect();
    this.cachedImage = {
      frames: [packedFrame(px.data, w, h)],
      width: w,
      height: h,
      ratios: [rect.width / w, rect.height / h],
      isGrayscale: false,
      originX: rect.x,
      originY: rect.y,
    };
    this.cachedImageSource = px;
    return this.cachedImage;
  }

  /**
   * The service's `beforeToolChange`: track the pixel-reading tool (see {@link onViewChanged}),
   * gate the camera, and arm a fresh readback for a pixel tool. Nothing is armed without a
   * viewer, nor a pixel tool before a plot built its coordinate transform.
   *
   * Control gating: a tool that ACTIVATES disables the camera controls; deactivation is a no-op
   * because the host always calls the region overlay's setMode FIRST in each toggle (which sets
   * the baseline enabled/disabled), so re-enabling here would fight a freshly-activated draw mode.
   */
  beforeToolChange(next: CanvasToolId | null): boolean {
    this.pixelTools.clear();
    if (next !== null && next !== 'zoomToBox') this.pixelTools.add(next);
    const viewer = this.host.viewer();
    if (!viewer) return false; // no plot yet → nothing to drive
    if (next === null) return true;
    if (next !== 'zoomToBox' && !this.coordTransform) return false;
    viewer.setControlsEnabled(false);
    if (next === 'zoomToBox') return true;
    this.cachedImageSource = null;
    // The eraser only converts coordinates with the readback, so a current one will do.
    if (next !== 'eraseVertex' || this.pixelsStale) this.armReadback(0);
    return true;
  }

  /** SAM over the drawn rectangles — a server round-trip that reads the rectangles from the
   *  RegionStore and the image from a fresh readback. Returns the regions added. */
  async segmentRectangles(): Promise<number> {
    if (!this.host.viewer() || !this.coordTransform) return 0;
    await this.runReadback(); // the SAM embedding samples the currently-displayed image
    this.cachedImageSource = null;
    return this.deps.samTool.segmentBoxes(this.toolHost);
  }

  /** Cellpose over the drawn rectangles (see {@link segmentRectangles}). */
  async segmentRectanglesCellpose(): Promise<number> {
    const segmenter = this.deps.cellSegmenter;
    if (!this.host.viewer() || !this.coordTransform || !segmenter) return 0;
    await this.runReadback();
    this.cachedImageSource = null;
    return this.deps.cellSegmentTool.segmentBoxes(this.toolHost, segmenter);
  }

  /** Per-channel histogram of the displayed RGB composite (R/G/B byte), from the last readback. */
  rgbHistogram(channelIndex: number, bins: number): IHistogram | null {
    // Pans no longer read the canvas back (no pixel tool needs it), so refresh lazily here: this
    // answer may describe the previous view, and the pane's next request gets the current one.
    if (this.pixelsStale) this.armReadback(0);
    const px = this.lastPixels;
    if (!px) return null;
    const band = Math.max(0, Math.min(2, channelIndex));
    const n = Math.max(1, Math.min(256, Math.floor(bins) || 256));
    const counts = new Array(n).fill(0);
    const data = px.data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue; // skip transparent padding
      counts[Math.min(n - 1, (data[i + band] * n) >> 8)]++;
    }
    const binsArr = Array.from({ length: n }, (_, i) => (i * 256) / n);
    return { bins: binsArr, counts, max: counts.reduce((m, c) => (c > m ? c : m), 0) };
  }
}
