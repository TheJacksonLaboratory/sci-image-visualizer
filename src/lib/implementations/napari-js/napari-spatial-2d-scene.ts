import type { ImageLayer, PointsLayer, Viewer } from 'napari-js';

import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import {
  NO_CATEGORY, SpatialColumn, SpatialDataset, SpatialImageRef, SpatialObservations, isCategoricalColumn,
} from '../../contracts/spatial-dataset.contract';
import { SpatialViewState } from '../../contracts/display-types';
import {
  encodeCategorical, markerDiameters, resolveCategoryColors, toRgbaTuples, type RGBA,
} from '../../spatial/spatial-encoding';
import {
  SpatialSelectionMask, emptySelection, maskToIndices, mutedFromSelection,
} from '../../spatial/spatial-selection';
import { framePositions } from '../../spatial/spatial-framing';
import { PIXEL_WORLD_QUANTUM, worldQuantumForExtent } from '../../spatial/world-grid';
import { observationsInSlice, volumeImageRef } from '../../spatial/spatial-volume-image';
import { cellTypeColumnFor } from '../../spatial/spatial-tiles';
import { ExpressionField, colorExpressionField, fieldContrastWindow } from '../../spatial/spatial-expression';
import { computeExpressionFieldAsync } from '../../workers/spatial-math';
import { Supersede } from '../../util/supersede';
import { isAbortError } from '../tile-server';
import { NapariSpatialTileLayers } from './napari-spatial-tiles';
import { Image2dScene } from './napari-image-2d-scene';
import {
  GENE_MAP_MAX_SIDE, GENE_MAP_SIGMA, SPATIAL_FALLBACK_RADIUS, SPATIAL_NEUTRAL_COLOR, SPATIAL_NEUTRAL_HEX,
  SPATIAL_SLICE_MIN_DIAMETER_PX, encodeSpatialContinuous, gatherColors,
} from './napari-spatial-encoding';
import { SpatialSceneBase, SpatialSession, SpatialTileOwner } from './napari-spatial-scene';
import type { NapariScene, SceneContext } from './napari-scene';

/** The plane a volume-backed dataset is showing (see {@link Spatial2dScene.slab}). */
interface Slab {
  ref: SpatialImageRef;
  indices: Uint32Array;
  slice: number;
  minDiameter: number;
}

/**
 * SPATIAL_OMICS (review Appendix B, cluster J): the tissue image (an {@link Image2dScene}) with one
 * marker per observation, coloured by an annotation column or a gene, the gene map under the
 * cells, and the level-of-detail tile layers (outlines, transcripts, density) over them. The
 * markers rebuild whenever the dataset or the view state changes, so switching the colour-by
 * column does not remount the scene.
 *
 * Sets up the full 2D interaction stack — region overlay, pixel tools, readback currency — exactly
 * as the plain image view does. That is NOT optional here: this mode's selection is driven by
 * drawn ROIs, so without the overlay there is no way to make a selection at all.
 */
export class Spatial2dScene extends SpatialSceneBase implements NapariScene, SpatialTileOwner {
  readonly image: Image2dScene;
  /** The observation markers, and which dataset/plane they were built for — so a display-only
   *  change (size, colour, opacity, selection) can update them in place. */
  private points: PointsLayer | null = null;
  private layerKey: string | null = null;
  /** The gene map's layer and the inputs it was coloured for (its field is cached in the session,
   *  on a clock of its own). */
  geneMapLayer: ImageLayer | null = null;
  private geneMapKey: string | null = null;
  /** The dataset the camera has been framed on — see {@link frameOnce}. */
  private framed: string | null = null;
  /** The gene-map estimate in flight (off the main thread past the worker threshold,
   *  SPATIAL-19): a new field key supersedes — and aborts — it; a rebuild that leaves the key
   *  alone lets it finish. */
  private readonly geneMapLoads = new Supersede();

  /** `noImage`: an image-less dataset opened before any image — the observations alone. */
  constructor(ctx: SceneContext, session: SpatialSession, noImage = false) {
    super(ctx, session, false);
    this.image = new Image2dScene(ctx, {
      image: !noImage,
      // Only fit to the image when this dataset actually has one. Otherwise there is nothing to
      // fit, the image size still holds the LAST image's dimensions, and this fits to those — and
      // because it defers to a frame, it lands AFTER the points are added and overwrites the
      // framing they set. That is what left an image-less dataset as a ten-pixel speck.
      fit: () => !!session.latest?.[0]?.imageRef,
      onSlice: () => this.redrawMarkers(),
      onNavigatorInteract: () => this.hover.hide(),
    });
  }

  async mount(): Promise<void> {
    const { ctx } = this;
    await this.image.mount();
    this.hover.install(ctx.host);
    this.session.claimTiles(this)?.attach(ctx.viewer);
    this.subscribeSpatial();
    ctx.tools.scheduleReadback();
  }

  setZ(z: number): void {
    this.image.setZ(z);
  }

  histogram(channel: number, bins: number): IHistogram | null {
    return this.image.histogram(channel, bins);
  }

  setImageSmoothing(enabled: boolean): void {
    this.image.setImageSmoothing(enabled);
  }

  setNavigatorVisible(visible: boolean): void {
    this.image.setNavigatorVisible(visible);
  }

  dispose(): void {
    this.disposeSpatial();
    this.geneMapLoads.cancel();
    this.session.releaseTiles(this);
    this.image.dispose();
  }

  canvasSize(): [number, number] {
    return [this.ctx.canvas.clientWidth ?? 0, this.ctx.canvas.clientHeight ?? 0];
  }

  polygonsShownChanged(): void {
    if (this.points) this.points.visible = this.pointsVisible();
    this.ctx.viewer.requestRender();
  }

  protected override afterChange(): void {
    this.session.tiles?.refresh();
  }

  protected override hoverTiles(): NapariSpatialTileLayers | null {
    return this.session.tiles;
  }

  /**
   * The markers' WORLD positions, indexed by observation, NaN for any not on the displayed plane —
   * the same affine and the same subset the marker layer was built from, so the tooltip cannot
   * point at a cell that is not drawn.
   */
  protected hoverPositions(obs: SpatialObservations): Float32Array | null {
    const dataset = this.session.latest?.[0];
    if (!dataset || obs.count === 0) return null;
    const slab = this.slab(dataset);
    const ref = slab?.ref ?? dataset.imageRef;
    const [sx, sy] = ref?.scale ?? [1, 1];
    const [tx, ty] = ref?.translate ?? [0, 0];
    const drawn = slab?.indices ?? null;
    const out = new Float32Array(obs.count * 2).fill(NaN);
    const n = drawn ? drawn.length : obs.count;
    for (let k = 0; k < n; k++) {
      const i = drawn ? drawn[k] : k;
      out[i * 2] = obs.x[i] * sx + tx;
      out[i * 2 + 1] = obs.y[i] * sy + ty;
    }
    return out;
  }

  /**
   * Whether the markers are drawn: when the user wants them, and not while cell outlines are on
   * screen — then a cell IS its outline, and a circle on top of it is noise. Zoomed out past the
   * outline threshold, the circles stand in for the cells.
   */
  private pointsVisible(): boolean {
    const view = this.session.latest?.[1];
    return (view?.showPoints ?? true) && !this.session.tiles?.outlinesShown;
  }

  /**
   * Redraw the markers over a freshly rendered image. Two reasons, both invisible from the
   * spatial store — which is why a scrub or a re-render never reached the markers on its own:
   *  - the image render CLEARS the layer list, taking the markers with it;
   *  - over a volume-backed dataset the displayed plane decides which observations belong on
   *    screen at all, so the cells have to move with the section rather than hang over another.
   */
  private redrawMarkers(): void {
    const latest = this.session.latest;
    if (!latest?.[0]) return;
    void this.rebuild(...latest);
  }

  /** (Re)build the observation marker layer for the current dataset + view state. */
  protected async rebuild(
    dataset: SpatialDataset | null, view: SpatialViewState,
    selection: SpatialSelectionMask = emptySelection(),
  ): Promise<void> {
    const viewer = this.ctx.viewer;
    const task = this.rebuilds.next();

    // Resolve colours BEFORE touching the scene: a gene fetch can fail or be
    // superseded, and dropping the existing layer first would blank the view.
    let faceColor: RGBA[] | RGBA;
    const endLoading = this.ctx.badge.begin('Observations');
    try {
      faceColor = dataset ? await this.faceColors(dataset, view, selection) : SPATIAL_NEUTRAL_COLOR;
    } catch (err) {
      console.warn('[napari-js] spatial colouring failed — falling back to a flat colour', err);
      faceColor = SPATIAL_NEUTRAL_COLOR;
    } finally {
      endLoading();
    }
    // A newer rebuild (or a teardown) started while the vector was in flight.
    if (!task()) return;

    if (!dataset || dataset.observations.count === 0) {
      if (this.points) {
        viewer.layers.remove(this.points);
        this.points = null;
        this.layerKey = null;
      }
      if (this.geneMapLayer) {
        viewer.layers.remove(this.geneMapLayer);
        this.geneMapLayer = null;
        this.geneMapKey = null;
      }
      return;
    }

    const obs = dataset.observations;
    // A dataset whose image IS its volume shows ONE PLANE at a time, so the
    // markers are the observations in the displayed plane, drawn in that plane's
    // pixel grid. Without the filter the specimen's whole depth piles onto one
    // section and reads as a smear; without the affine the coordinates are read
    // as pixels and land off the slice entirely.
    const slab = this.slab(dataset);
    // The gene map goes UNDER the cells, so it is settled before they are added.
    await this.ensureGeneMap(viewer, dataset, view, selection, slab);
    if (!task()) return;
    const ref = slab?.ref ?? dataset.imageRef;
    const base = markerDiameters(obs, SPATIAL_FALLBACK_RADIUS);
    const scale = view.pointScale > 0 ? view.pointScale : 1;
    const floor = slab?.minDiameter ?? 0;
    const sizeOf = (i: number) =>
      Math.max(typeof base === 'number' ? base : base[i], floor) * scale;
    const size: number | Float32Array =
      typeof base === 'number' && !slab
        ? Math.max(base, floor) * scale
        : Float32Array.from(slab?.indices ?? { length: obs.count }, (_v, i) =>
            sizeOf(slab ? slab.indices[i] : i));

    // napari's image view CLEARS the whole layer list on every render, so the
    // markers go with it whenever the image is re-rendered — a scrub, a contrast
    // change. The cached handle is then detached, and mutating it draws nothing:
    // treat a layer that is no longer in the scene as absent so it gets re-added.
    if (this.points && !viewer.layers.items.includes(this.points)) {
      this.points = null;
      this.layerKey = null;
    }

    const showImage = (!!ref || !!dataset.volume) && view.showImage !== false;
    // A size/colour/opacity/selection change is DISPLAY-only: mutate the layer
    // rather than dropping and re-adding it. Both setters bump the layer's
    // dataVersion, which is what makes napari-js rebuild the instance buffer and
    // redraw — and it avoids rebuilding 84k positions to change one number.
    // The slice is part of the key: a scrub changes WHICH observations are drawn,
    // which is geometry, not display.
    const key = `${dataset.id}:${obs.count}:${slab?.slice ?? ''}`;
    if (this.points && key === this.layerKey) {
      this.points.size = size;
      this.points.visible = this.pointsVisible();
      this.points.faceColor = gatherColors(faceColor, slab?.indices);
      this.hideForeignImage(viewer, showImage);
      this.ctx.tools.regionOverlay?.setRegionsVisible(view.showAnnotations !== false);
      viewer.requestRender();
      return;
    }

    if (this.points) {
      viewer.layers.remove(this.points);
      this.points = null;
    }

    const drawn = slab?.indices;
    const count = drawn ? drawn.length : obs.count;
    const positions = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const o = drawn ? drawn[i] : i;
      positions[i * 2] = obs.x[o];
      positions[i * 2 + 1] = obs.y[o];
    }
    this.layerKey = key;
    this.points = viewer.addPoints(positions, {
      name: 'observations',
      size,
      faceColor: gatherColors(faceColor, drawn),
      // No border: at Visium spot density an outline per marker reads as noise,
      // and it costs a second colour array.
      borderWidth: 0,
      // The dataset's data->world affine. SpatialData records one per coordinate
      // system (Visium spot coords are in the FULL-resolution frame while the
      // served image may be the hires downscale), so without this the markers
      // land in the right shape at the wrong scale. Defaults to identity when
      // the coordinates are already in the image's pixel space.
      scale: ref?.scale ?? [1, 1],
      translate: ref?.translate ?? [0, 0],
      visible: this.pointsVisible(),
    });
    // Outlines, density and transcripts go back over the markers just added.
    this.session.tiles?.afterObservations();
    this.frameOnce(viewer, dataset.id, positions, !!ref);
    this.hideForeignImage(viewer, showImage);
    this.ctx.tools.regionOverlay?.setRegionsVisible(view.showAnnotations !== false);
    this.setRegionGridFor(dataset, positions);
  }

  /**
   * Tell the region overlay how finely a drawn vertex may be placed.
   *
   * Region geometry is stored in whole world units, which is right when the world IS
   * pixels — a region should align to them. It is wrong for a dataset that registers onto
   * no image: seqFISH's observations span about 5 x 7 units in total, so whole-unit
   * vertices leave roughly six by eight placeable positions across the entire sample and
   * an ROI cannot be drawn at any zoom. Nothing errors; the tool just cannot express the
   * shape.
   *
   * Keyed on whether the dataset brings PIXELS rather than on the extent, because the
   * extent cannot tell the two apart — 2,000 units is a small slide or a large section
   * depending only on what the units are, and only the dataset knows.
   */
  private setRegionGridFor(dataset: SpatialDataset, positions: Float32Array): void {
    const overlay = this.ctx.tools.regionOverlay;
    if (!overlay?.setWorldQuantum) return;
    if (dataset.imageRef || dataset.volume) {
      overlay.setWorldQuantum(PIXEL_WORLD_QUANTUM);
      return;
    }
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (let i = 0; i < positions.length; i += 2) {
      const x = positions[i];
      const y = positions[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    overlay.setWorldQuantum(worldQuantumForExtent(maxX - minX, maxY - minY));
  }

  /**
   * Hide the image layer for a dataset that brings no image of its own.
   *
   * The host's viewer keeps whatever image was last loaded, and for a dataset that
   * registers onto none that picture belongs to something else entirely — the example's
   * default slide, say. It is not merely irrelevant: the two live in different coordinate
   * spaces (image pixels against the embedding's own units), so the leftover is magnified
   * roughly a hundredfold. At the fitted zoom the camera sits inside its corner, where it
   * reads as blank background, and it appears only once you zoom out far enough to find
   * it — which is exactly how it gets noticed.
   *
   * Hidden rather than removed, and hidden HERE rather than by clearing the host's image
   * state: that state drives the whole render pipeline, including a Plotly backend whose
   * fields are declared with definite-assignment assertions, so emptying it throws from
   * whichever field the next path happens to read. This touches one layer's visibility
   * and nothing else.
   */
  hideForeignImage(viewer: Pick<Viewer, 'layers' | 'requestRender'>, datasetHasPixels: boolean): void {
    // No image of its own → nothing for an overview to show either.
    this.image.showNavigatorFor(datasetHasPixels);
    const tiles = this.session.tiles;
    for (const layer of viewer.layers.items) {
      if (layer.kind !== 'image') continue;
      // The transcript-density raster and the gene map are image layers too, but they are
      // data, not the tissue: the Images toggle must not take them down with the slide.
      if (tiles?.owns(layer) || layer === this.geneMapLayer) continue;
      // Re-shown when a dataset that owns an image comes back, so switching between
      // datasets does not leave the tissue permanently hidden.
      layer.visible = datasetHasPixels;
    }
    viewer.requestRender();
  }

  /**
   * Frame the camera on the observations, for a dataset that brings no image.
   *
   * The 2D camera is normally fitted to the IMAGE, because the observations are in that
   * image's pixel space and framing the image frames them too. A dataset with no
   * reference image has coordinates in its own units instead — seqFISH's span about
   * 5x7 — so the image framing left over from whatever was on screen before puts the
   * whole cloud offscreen: measured at 9.7 x 13.4 PIXELS, centred 256px from where the
   * camera was looking. The points are all there and drawn; they are a speck. Which
   * looks exactly like the dataset having failed to load.
   *
   * Once per dataset, as napari-js's `fit3d: 'once'` does for the cloud: re-colouring,
   * slicing or picking a gene re-adds this layer, and re-framing on those would move
   * the camera under the user — the camera tools and the canvas drag are meant to be
   * the only things that do.
   */
  private frameOnce(viewer: Viewer, datasetId: string, positions: Float32Array, registered: boolean): void {
    // Gated on whether THIS dataset registers onto an image, not on the image size: that keeps
    // the last plotted image's dimensions after the host clears it, so a stale 512x383 read as
    // "there is an image" and skipped the framing entirely.
    if (registered) return;
    // Once per dataset (see above).
    if (this.framed === datasetId) return;

    const { canvas } = this.ctx;
    const fit = framePositions(positions, canvas.clientWidth ?? 0, canvas.clientHeight ?? 0);
    // Null means there is nothing to frame on; leave the camera where it is rather
    // than moving the view for a dataset we cannot fit.
    if (!fit) return;
    viewer.camera.set(fit.center, fit.zoom ?? viewer.camera.zoom);
    this.framed = datasetId;
  }

  /**
   * The **gene map**: the active gene's expression as a continuous field drawn under
   * the cells.
   *
   * A scatter coloured by a gene says which cells express it; it cannot say where,
   * because the eye will not integrate thousands of dots into a territory. The field
   * is a kernel-weighted MEAN per cell (see `spatial-expression.ts`), so a dense
   * region does not glow merely for being dense, and it is transparent wherever no
   * cell was measured — an unsampled gap must not read as "not expressed".
   *
   * It shares the points' LUT, percentile window and log flag, so the layer under
   * the cells and the cells themselves cannot disagree about what a colour means.
   *
   * Estimated on the DISPLAYED image's pixel grid, coarsened so the long side is at
   * most `GENE_MAP_MAX_SIDE`: a smooth field gains nothing from a slide's full
   * resolution. For a volume-backed dataset that grid is the current slice, and only
   * that plane's observations are included — the same rule the markers follow.
   */
  private async ensureGeneMap(
    viewer: Viewer, dataset: SpatialDataset, view: SpatialViewState,
    selection: SpatialSelectionMask, slab: Slab | null,
  ): Promise<void> {
    const gene = view.geneMap && view.colorBy?.kind === 'feature' ? view.colorBy.name : null;
    const port = this.session.port;
    const cache = this.session.geneMap;
    const smoothing = view.geneMapSmoothing > 0 ? view.geneMapSmoothing : 1;
    const clip = view.percentileClip ?? [0.01, 0.99];

    // Two clocks: the FIELD depends on the gene, the plane and the bandwidth, while
    // the colours depend on the window, the log flag and the opacity. Recolouring a
    // cached field is a fraction of estimating one.
    const fieldKey = gene
      ? [dataset.id, gene, slab?.slice ?? '', smoothing, this.session.selectionRev(selection)].join('|')
      : null;
    const key = fieldKey
      ? [
        fieldKey, clip.join(','), view.logScale ? 'log' : 'lin', view.geneMapOpacity,
        this.ctx.display.continuousColormapKey(view),
      ].join('|')
      : null;
    if (key === this.geneMapKey) return;

    if (this.geneMapLayer) {
      viewer.layers.remove(this.geneMapLayer);
      this.geneMapLayer = null;
    }
    // ANY change here changes the order the cells have to sit above — including the
    // first one, where there is no previous layer to remove — and the layer list is
    // append-only. So drop the markers unconditionally and let the rebuild below put
    // them back on top; otherwise the field is appended over the measurement.
    if (this.points) {
      viewer.layers.remove(this.points);
      this.points = null;
      this.layerKey = null;
    }
    this.geneMapKey = key;
    if (!key || !gene || !port) {
      cache.field = null;
      cache.key = null;
      return;
    }

    // The raster covers the displayed image; without one there is nothing to
    // overlay and the cloud is the 3D mode's business, not this one's. Gated on the
    // DATASET bringing pixels, not on the image size: that keeps the last plotted image's
    // size after the host clears it, which would size the map over the wrong extent.
    if (!slab && !dataset.imageRef) return;
    const size = this.ctx.imageSize();
    const imageW = slab ? dataset.volume!.width : size.width;
    const imageH = slab ? dataset.volume!.height : size.height;
    if (!imageW || !imageH) return;
    const step = Math.max(1, Math.ceil(Math.max(imageW, imageH) / GENE_MAP_MAX_SIDE));

    if (fieldKey !== cache.key) {
      const load = this.geneMapLoads.next();
      let values: Float32Array;
      try {
        values = await port.getFeatureVector(gene);
      } catch (err) {
        console.warn(`[napari-js] gene map: "${gene}" unavailable`, err);
        this.geneMapKey = null;
        return;
      }
      if (!load() || this.geneMapKey !== key) return;
      const inSelection = selection.count > 0 ? maskToIndices(selection.mask) : undefined;
      let estimated: ExpressionField | null;
      try {
        estimated = await computeExpressionFieldAsync(dataset.observations, {
          ref: slab?.ref ?? dataset.imageRef,
          width: Math.ceil(imageW / step),
          height: Math.ceil(imageH / step),
          step,
          sigma: GENE_MAP_SIGMA * smoothing,
          values,
          // A plane wins over a selection: the 2D view is showing one section, so a
          // field spanning the specimen's depth would not be the thing on screen.
          indices: slab?.indices ?? inSelection,
        }, { signal: load.signal });
      } catch (err) {
        if (isAbortError(err)) return; // superseded by a newer map, or the scene went away
        throw err;
      }
      if (!load() || this.geneMapKey !== key) return;
      cache.field = estimated;
      cache.key = fieldKey;
    }
    const field = cache.field;
    if (!field) return;

    const lut = this.ctx.display.spatialLut(view);
    // Over the measured pixels only: unmeasured ones are 0 and would drag the low end down.
    const [lo, hi] = fieldContrastWindow(field, clip[0], clip[1]);
    const rgba = colorExpressionField(field, lut, [lo, hi], {
      log: view.logScale,
      // The MAP's own opacity: reading a field under the cells means turning the
      // cells down, which must not take the field with them.
      opacity: view.geneMapOpacity,
    });
    this.geneMapLayer = viewer.addImage(
      { kind: 'typed', width: field.width, height: field.height, channels: 4, dtype: 'uint8', data: rgba },
      {
        name: `gene map · ${gene}`,
        scale: [step, step],
        translate: [0, 0],
        blending: 'translucent',
      },
    );
    // A newer rebuild that kept this map's key drew the cells while the field was computing, so
    // the map just landed OVER them: put the cells back on top.
    if (this.points) {
      viewer.layers.remove(this.points);
      this.points = null;
      this.layerKey = null;
      this.redrawMarkers();
    }
    viewer.requestRender();
  }

  /**
   * The plane a volume-backed dataset is currently showing: its pixel affine, the
   * observations that fall in it, and the marker floor that grid needs.
   *
   * Null for a dataset with a real `imageRef` (its coordinates are already the
   * image's pixels and every observation belongs to the one section) and for one
   * with no volume at all — both of which draw exactly as before.
   */
  private slab(dataset: SpatialDataset): Slab | null {
    const volume = dataset.volume;
    if (dataset.imageRef || !volume) return null;
    const slice = this.ctx.z();
    return {
      ref: volumeImageRef(volume, dataset.micronsPerUnit),
      indices: observationsInSlice(dataset.observations, volume, slice),
      slice,
      minDiameter: SPATIAL_SLICE_MIN_DIAMETER_PX * volume.voxelSize[0],
    };
  }

  /**
   * Per-observation colours for the current view state, or a single flat colour when nothing is
   * selected to colour by. Categorical columns use the column's own palette; continuous columns
   * and gene vectors go through the active colormap with a percentile-clipped window.
   */
  private async faceColors(
    dataset: SpatialDataset, view: SpatialViewState, selection: SpatialSelectionMask,
  ): Promise<RGBA[] | RGBA> {
    const port = this.session.port;
    const colorBy = view.colorBy;
    // Everything NOT selected is muted; with nothing selected, nothing is muted
    // and the whole tissue reads normally (the CosMx highlight-vs-mute rule).
    const muted = mutedFromSelection(selection);

    if (!port || !colorBy) {
      // Genuinely uniform: one broadcast tuple, so a flat 84k-observation view
      // does not allocate 84k of them.
      if (!muted && view.opacity >= 1) return SPATIAL_NEUTRAL_COLOR;
      // Not uniform — the opacity control or a selection varies the alpha, so it
      // has to be per-point. Returning the constant tuple here is what made the
      // Opacity slider do nothing in the default state, which is the state anyone
      // lands in before picking a colour source.
      return toRgbaTuples(encodeCategorical(new Uint16Array(dataset.observations.count), {
        colors: [SPATIAL_NEUTRAL_HEX],
        opacity: view.opacity,
        muted,
      }));
    }

    if (colorBy.kind === 'column') {
      const column: SpatialColumn = await port.getColumn(colorBy.name);
      if (isCategoricalColumn(column)) {
        const rgba = encodeCategorical(column.codes, {
          colors: resolveCategoryColors(column.meta),
          opacity: view.opacity,
          muted,
        });
        // Groups switched off in the Cells panel hide their dots too, when the dots are
        // coloured by that same grouping.
        const groupColumn = cellTypeColumnFor(dataset, view);
        if (view.hiddenGroups?.length && groupColumn === colorBy.name) {
          const off = new Set(view.hiddenGroups);
          const hide = column.meta.categories.map((c) => off.has(c));
          for (let i = 0; i < column.codes.length; i++) {
            const c = column.codes[i];
            if (c !== NO_CATEGORY && hide[c]) rgba[4 * i + 3] = 0;
          }
        }
        return toRgbaTuples(rgba);
      }
      // A continuous column may carry its own log hint (counts); the view's
      // toggle wins once the user has set it.
      return toRgbaTuples(this.encodeContinuous(column.values, view, muted));
    }

    const values = await port.getFeatureVector(colorBy.name);
    return toRgbaTuples(this.encodeContinuous(values, view, muted));
  }

  /** Continuous values → RGBA through the active colormap and a clipped window. */
  encodeContinuous(values: Float32Array, view: SpatialViewState, muted: Uint8Array | null = null): Float32Array {
    return encodeSpatialContinuous(
      values, view, this.ctx.display.spatialLut(view), this.session.contrastWindows, muted,
    );
  }
}
