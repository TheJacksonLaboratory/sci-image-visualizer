import { Subscription } from 'rxjs';

import { ColormapNode, SpatialViewState } from '../../contracts/display-types';
import { PlotModeViewport } from '../../contracts/plot-type-contribution.contract';
import { SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import { ExpressionField, colorExpressionField, fieldContrastWindow } from '../../spatial/spatial-expression';
import { SpatialSelectionMask, emptySelection, maskToIndices } from '../../spatial/spatial-selection';
import { SpatialSelectionStore } from '../../store/spatial-selection.service';
import { VisualizerStore } from '../../store/visualizer-store.service';
import { Supersede } from '../../util/supersede';
import { computeExpressionFieldAsync } from '../../workers/spatial-math';
import { isAbortError } from '../tile-server';
import { NapariDisplayState } from '../napari-js/napari-display-state';
import {
  GENE_MAP_MAX_SIDE,
  GENE_MAP_SIGMA,
  SPATIAL_MARKER_MIN_SCREEN_PX,
  SPATIAL_NEUTRAL_COLOR,
  PointColors,
  gatherColors,
  hideUnshown,
  isPerPoint,
} from '../napari-js/napari-spatial-encoding';
import { Slab, markerSizes, observationPositions, slabAt } from '../napari-js/napari-spatial-2d-scene';
import { SpatialHover } from '../napari-js/napari-spatial-hover';
import { SpatialSession } from '../napari-js/napari-spatial-scene';
import { MarkerStyleDeps, markerFilterMask, markerStyle } from '../napari-js/spatial-marker-style';
import { GlMarkerRenderer, GlTransform } from './gl-marker-renderer';
import { PointGrid } from './point-grid';

/** What the WebGL spatial layer reads from the viewer it draws over. */
export interface WebGlSpatialHost {
  /** The image viewport (OpenSeadragon's): image↔client transforms and its redraw frames. */
  readonly viewport: PlotModeViewport;
  /**
   * Call `redraw` in the viewer's own redraw, so the markers move in the same frame as the tiles
   * (`viewport.frame$` lands a frame later, and the markers then trail a pan). Returns the
   * unsubscribe. Optional: without it the layer follows `frame$`.
   */
  onRedraw?(redraw: () => void): () => void;
  /**
   * The element the layer's canvas goes in: over the image tiles, under the region overlay (so a
   * drawn ROI stays visible over a dense field of markers). Null: the viewer is not mounted.
   */
  container(): HTMLElement | null;
  /** The element the hover listens on (the plot host, so it hears over the region overlay). */
  pointerHost(): HTMLElement | null;
  readonly store: VisualizerStore;
  readonly port: SpatialDataPort | null;
  readonly selection: SpatialSelectionStore | null;
  /** Level-0 size of the image on screen (the gene map's grid). */
  imageSize(): { width: number; height: number } | null;
  /** The stack slice on screen (a volume-backed dataset draws that plane's observations). */
  z(): number;
  /** A region tool owns the pointer: a still click is the tool's, not a class selection. */
  toolActive(): boolean;
  outsideZone<T>(fn: () => T): T;
  inZone<T>(fn: () => T): T;
}

/**
 * The 2D spatial-omics view without WebGPU: the observation markers and the gene map drawn with
 * WebGL2 over OpenSeadragon's tissue image, coloured, selected, filtered and hovered by the same
 * code as napari-js's {@link Spatial2dScene} (`spatial-marker-style.ts`, `SpatialHover`), so the
 * two renderers agree on what every colour and click means.
 *
 * What it does NOT draw (napari-js only, for now): the level-of-detail cell outlines and fills, the
 * transcripts and their density, the per-gene marker icons (every marker is a disc), and the
 * region set's planes over a single-plane image.
 */
export class WebGlSpatialLayer {
  private readonly session: SpatialSession;
  private readonly display: NapariDisplayState;
  private readonly hover: SpatialHover;
  private readonly rebuilds = new Supersede();
  private readonly geneMapLoads = new Supersede();
  private renderer: GlMarkerRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private subs = new Subscription();
  private resize: ResizeObserver | null = null;
  private drawFrame = 0;

  /** What the markers on the GPU were built for (dataset, count, slice): a recolour keeps them. */
  private markerKey: string | null = null;
  /** Image-px x,y of each drawn marker (the pick's grid indexes these). */
  private positions: Float32Array | null = null;
  /** The observation each drawn marker is; null when every observation is drawn, in order. */
  private drawn: Uint32Array | null = null;
  private diameters: number | Float32Array = 0;
  private colors: PointColors = SPATIAL_NEUTRAL_COLOR;
  private grid: PointGrid | null = null;
  private markersVisible = true;
  private geneMapKey: string | null = null;

  constructor(private readonly host: WebGlSpatialHost) {
    this.display = new NapariDisplayState(host.store);
    this.session = new SpatialSession(host.port, host.selection, {
      // The tile layers are napari-js's: the fallback has none to report on.
      continuousLut: (view) => this.display.spatialLut(view),
      estimateChanged: () => undefined,
      geneCountsChanged: () => undefined,
      densityChanged: () => undefined,
      loadingChanged: () => undefined,
    });
    this.hover = new SpatialHover({
      is3d: false,
      viewer: null,
      port: host.port,
      selection: host.selection,
      dataset: () => this.session.latest?.[0] ?? null,
      pick: (x, y, slack) => this.pick(x, y, slack),
      tiles: () => null,
      toolActive: () => host.toolActive(),
      outsideZone: (fn) => host.outsideZone(fn),
      inZone: (fn) => host.inZone(fn),
    });
  }

  /** Whether the layer is drawing. */
  get attached(): boolean {
    return !!this.renderer;
  }

  /**
   * Put the canvas over the viewer and follow the dataset, the view and the camera. False when it
   * cannot draw — no viewer mounted, no spatial port, or no WebGL2 — and the tissue image then
   * shows alone, as before.
   */
  attach(): boolean {
    this.detach();
    const container = this.host.container();
    const changes = this.session.changes$(this.host.store);
    if (!container || !changes) return false;

    const canvas = document.createElement('canvas');
    canvas.className = 'siv-spatial-webgl';
    Object.assign(canvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
    });
    // Over the tiles, under the region overlay's SVG (which OpenSeadragon's canvas element also holds).
    const svg = Array.from(container.children).find((el) => el.tagName.toLowerCase() === 'svg') ?? null;
    container.insertBefore(canvas, svg);
    let renderer: GlMarkerRenderer;
    try {
      renderer = new GlMarkerRenderer(canvas, () => this.reupload());
    } catch (err) {
      console.warn('[webgl] spatial markers unavailable — the tissue image shows alone.', err);
      canvas.remove();
      return false;
    }
    this.canvas = canvas;
    this.renderer = renderer;

    this.host.outsideZone(() => {
      const off = this.host.onRedraw?.(() => this.draw());
      if (off) this.subs.add(off);
      else this.subs.add(this.host.viewport.frame$.subscribe(() => this.draw()));
      if (typeof ResizeObserver !== 'undefined') {
        this.resize = new ResizeObserver(() => this.requestDraw());
        this.resize.observe(canvas);
      }
    });
    // Installed BEFORE the subscription: install() starts from a clean hover, which would cancel
    // the colour source the subscription's first emission starts resolving.
    const pointerHost = this.host.pointerHost();
    if (pointerHost) this.hover.install(pointerHost, { capture: true });
    this.subs.add(
      changes.subscribe(([dataset, view, selection, colormap, reverse]) => {
        this.display.record((colormap as ColormapNode) ?? null, !!reverse);
        this.session.latest = [dataset, view, selection];
        void this.hover.resolveSource(dataset, view);
        void this.rebuild(dataset, view, selection);
      }),
    );
    return true;
  }

  /** Another slice is on screen: a volume-backed dataset's markers follow it. */
  setZ(): void {
    const latest = this.session.latest;
    if (this.renderer && latest?.[0]?.volume) void this.rebuild(...latest);
  }

  /** Take the canvas down and stop following anything. */
  detach(): void {
    this.subs.unsubscribe();
    this.subs = new Subscription();
    this.rebuilds.cancel();
    this.geneMapLoads.cancel();
    this.hover.dispose();
    this.resize?.disconnect();
    this.resize = null;
    if (this.drawFrame) cancelAnimationFrame(this.drawFrame);
    this.drawFrame = 0;
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas?.remove();
    this.canvas = null;
    this.markerKey = null;
    this.positions = null;
    this.drawn = null;
    this.grid = null;
    this.geneMapKey = null;
    this.session.latest = null;
  }

  // ── building ─────────────────────────────────────────────────────────

  private styleDeps(): MarkerStyleDeps {
    return {
      port: this.session.port,
      lut: (view) => this.display.spatialLut(view),
      windows: this.session.contrastWindows,
      tag: '[webgl]',
    };
  }

  /** (Re)build the markers and the gene map for the current dataset, view and selection. */
  private async rebuild(
    dataset: SpatialDataset | null,
    view: SpatialViewState,
    selection: SpatialSelectionMask = emptySelection(),
  ): Promise<void> {
    const task = this.rebuilds.next();
    // Colours are resolved BEFORE touching what is drawn: a gene fetch can fail or be superseded,
    // and dropping the markers first would blank the view (as in the napari-js scene).
    let colors: PointColors;
    let shown: Uint8Array | null;
    try {
      shown = dataset ? await markerFilterMask(this.session.port, dataset, view) : null;
    } catch (err) {
      console.warn('[webgl] gene filter could not be applied — keeping the observations as drawn', err);
      return;
    }
    try {
      colors = dataset
        ? (await markerStyle(this.styleDeps(), dataset, view, selection)).colors
        : SPATIAL_NEUTRAL_COLOR;
    } catch (err) {
      console.warn('[webgl] spatial colouring failed — falling back to a flat colour', err);
      colors = SPATIAL_NEUTRAL_COLOR;
    }
    if (!task() || !this.renderer) return;
    if (shown && dataset) colors = hideUnshown(colors, shown);

    if (!dataset || dataset.observations.count === 0) {
      this.clearMarkers();
      this.renderer.setRaster(null);
      this.geneMapKey = null;
      this.requestDraw();
      return;
    }
    const slab = slabAt(dataset, this.host.z(), null);
    // A dataset that registers onto no image has coordinates in its own units, not the pixels of
    // the image on screen (napari-js hides that image and frames the cloud instead); drawn over it,
    // the markers would sit in a corner at the wrong scale and read as a broken overlay.
    if (!slab && !dataset.imageRef) {
      console.warn('[webgl] this dataset registers onto no image — its markers need WebGPU (napari-js).');
      this.clearMarkers();
      this.renderer.setRaster(null);
      this.geneMapKey = null;
      this.requestDraw();
      return;
    }
    await this.ensureGeneMap(dataset, view, selection, slab);
    if (!task() || !this.renderer) return;
    this.setMarkers(dataset, view, colors, slab);
    this.requestDraw();
  }

  private clearMarkers(): void {
    this.renderer?.setMarkers(null);
    this.markerKey = null;
    this.positions = null;
    this.drawn = null;
    this.grid = null;
  }

  /** Upload the markers: positions (and the pick's grid) only when WHICH observations are drawn
   *  changed; sizes and colours every time, since they are display state. */
  private setMarkers(
    dataset: SpatialDataset,
    view: SpatialViewState,
    colors: PointColors,
    slab: Slab | null,
  ): void {
    const renderer = this.renderer;
    if (!renderer) return;
    const obs = dataset.observations;
    const ref = slab?.ref ?? dataset.imageRef;
    const [sx, sy] = ref?.scale ?? [1, 1];
    const [tx, ty] = ref?.translate ?? [0, 0];
    const key = `${dataset.id}:${obs.count}:${slab?.slice ?? ''}:${sx},${sy},${tx},${ty}`;
    if (key !== this.markerKey || !this.positions) {
      const drawn = slab?.indices;
      // The data→image affine applied once here, so the GPU and the pick work in image px.
      const positions = observationPositions(obs, drawn);
      for (let i = 0; i < positions.length; i += 2) {
        positions[i] = positions[i] * sx + tx;
        positions[i + 1] = positions[i + 1] * sy + ty;
      }
      this.positions = positions;
      this.drawn = drawn ?? null;
      this.grid = new PointGrid(positions, positions.length / 2);
      this.markerKey = key;
    }
    // Diameters are data units; the image's are those times the affine's scale.
    const size = markerSizes(obs, view, slab);
    const k = Math.min(Math.abs(sx), Math.abs(sy));
    this.diameters = typeof size === 'number' ? size * k : size.map((d) => d * k);
    this.colors = gatherColors(colors, slab?.indices);
    // The observations are shown as markers here at every zoom: the cell outlines that replace
    // them in napari-js are not drawn by the fallback.
    this.markersVisible = view.showPoints ?? true;
    renderer.setVisible(true);
    renderer.setMarkers({
      positions: this.positions,
      count: this.positions.length / 2,
      diameters: this.markersVisible ? this.diameters : 0,
      colors: this.markersVisible ? toGlColors(this.colors) : [0, 0, 0, 0],
      minScreenPx: SPATIAL_MARKER_MIN_SCREEN_PX,
    });
  }

  /** The re-created context needs everything again. */
  private reupload(): void {
    const latest = this.session.latest;
    this.markerKey = null;
    this.geneMapKey = null;
    if (latest) void this.rebuild(...latest);
  }

  /**
   * The gene map under the markers — the same field, window, LUT and opacity as napari-js's
   * (see `Spatial2dScene.ensureGeneMap`), drawn as a raster over the image.
   */
  private async ensureGeneMap(
    dataset: SpatialDataset,
    view: SpatialViewState,
    selection: SpatialSelectionMask,
    slab: Slab | null,
  ): Promise<void> {
    const renderer = this.renderer;
    const port = this.session.port;
    if (!renderer) return;
    const gene = view.geneMap && view.colorBy?.kind === 'feature' ? view.colorBy.name : null;
    const cache = this.session.geneMap;
    const smoothing = view.geneMapSmoothing > 0 ? view.geneMapSmoothing : 1;
    const clip = view.percentileClip ?? [0.01, 0.99];
    const fieldKey = gene
      ? [dataset.id, gene, slab?.slice ?? '', smoothing, this.session.selectionRev(selection)].join('|')
      : null;
    const key = fieldKey
      ? [
          fieldKey,
          clip.join(','),
          view.logScale ? 'log' : 'lin',
          view.geneMapOpacity,
          this.display.continuousColormapKey(view),
        ].join('|')
      : null;
    if (key === this.geneMapKey) return;
    this.geneMapKey = key;
    renderer.setRaster(null);
    if (!key || !gene || !port) {
      cache.field = null;
      cache.key = null;
      return;
    }
    if (!slab && !dataset.imageRef) return;
    const size = this.host.imageSize();
    const imageW = slab?.grid ? slab.grid.width : (size?.width ?? 0);
    const imageH = slab?.grid ? slab.grid.height : (size?.height ?? 0);
    if (!imageW || !imageH) return;
    const step = Math.max(1, Math.ceil(Math.max(imageW, imageH) / GENE_MAP_MAX_SIDE));

    if (fieldKey !== cache.key) {
      const load = this.geneMapLoads.next();
      let values: Float32Array;
      try {
        values = await port.getFeatureVector(gene);
      } catch (err) {
        console.warn(`[webgl] gene map: "${gene}" unavailable`, err);
        this.geneMapKey = null;
        return;
      }
      if (!load() || this.geneMapKey !== key) return;
      const inSelection = selection.count > 0 ? maskToIndices(selection.mask) : undefined;
      let estimated: ExpressionField | null;
      try {
        estimated = await computeExpressionFieldAsync(
          dataset.observations,
          {
            ref: slab?.ref ?? dataset.imageRef,
            width: Math.ceil(imageW / step),
            height: Math.ceil(imageH / step),
            step,
            sigma: GENE_MAP_SIGMA * smoothing,
            values,
            indices: slab?.indices ?? inSelection,
          },
          { signal: load.signal },
        );
      } catch (err) {
        if (isAbortError(err)) return;
        throw err;
      }
      if (!load() || this.geneMapKey !== key) return;
      cache.field = estimated;
      cache.key = fieldKey;
    }
    const field = cache.field;
    if (!field || !this.renderer) return;
    const lut = this.display.spatialLut(view);
    const [lo, hi] = fieldContrastWindow(field, clip[0], clip[1]);
    const rgba = colorExpressionField(field, lut, [lo, hi], { log: view.logScale, opacity: view.geneMapOpacity });
    this.renderer.setRaster({
      rgba,
      width: field.width,
      height: field.height,
      rect: { x: 0, y: 0, width: field.width * step, height: field.height * step },
    });
  }

  // ── drawing and picking ──────────────────────────────────────────────

  /** Draw on the next frame (a data change; the camera's frames draw through `frame$`). */
  private requestDraw(): void {
    if (this.drawFrame || !this.renderer) return;
    this.drawFrame = this.host.outsideZone(() =>
      requestAnimationFrame(() => {
        this.drawFrame = 0;
        this.draw();
      }),
    );
  }

  /** The image→canvas transform now, or null while the viewport cannot convert. */
  private transform(): { t: GlTransform; width: number; height: number } | null {
    const canvas = this.canvas;
    const vp = this.host.viewport;
    if (!canvas || !vp.isReady()) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const origin = vp.clientToData(rect.left, rect.top);
    const scale = vp.dataLengthToScreen(1);
    if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !(scale > 0)) return null;
    return {
      t: { origin: [origin.x, origin.y], scale: [scale, scale], offset: [0, 0] },
      width: rect.width,
      height: rect.height,
    };
  }

  private draw(): void {
    const renderer = this.renderer;
    if (!renderer) return;
    const view = this.transform();
    if (!view) return;
    renderer.resize(view.width, view.height, globalThis.devicePixelRatio || 1);
    renderer.draw(view.t, view.width, view.height);
  }

  /** The observation drawn under a client position, or -1 (see `SpatialHoverHost.pick`). */
  private pick(clientX: number, clientY: number, slackPx: number): number {
    const grid = this.grid;
    const vp = this.host.viewport;
    if (!grid || !this.markersVisible || !vp.isReady()) return -1;
    const scale = vp.dataLengthToScreen(1);
    if (!(scale > 0)) return -1;
    const p = vp.clientToData(clientX, clientY);
    const floor = SPATIAL_MARKER_MIN_SCREEN_PX / scale / 2;
    const d = this.diameters;
    const radiusOf =
      typeof d === 'number' ? () => Math.max(d / 2, floor) : (i: number) => Math.max(d[i] / 2, floor);
    const maxRadius = typeof d === 'number' ? Math.max(d / 2, floor) : Math.max(maxOf(d) / 2, floor);
    const c = this.colors;
    const shown = isPerPoint(c) ? (i: number) => c[4 * i + 3] > 0 : () => c[3] > 0;
    const k = grid.pick(p.x, p.y, radiusOf, maxRadius, slackPx / scale, shown);
    if (k < 0) return -1;
    return this.drawn ? this.drawn[k] : k;
  }
}

/** The renderer's colour input: per-point floats as they are, a broadcast tuple as a tuple. */
function toGlColors(colors: PointColors): Float32Array | readonly [number, number, number, number] {
  return isPerPoint(colors) ? colors : [colors[0], colors[1], colors[2], colors[3]];
}

function maxOf(values: Float32Array): number {
  let m = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > m) m = values[i];
  return m;
}
