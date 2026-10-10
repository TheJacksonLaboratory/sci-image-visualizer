import { colormapFromLut } from 'napari-js';
import type { Points3DLayer, ProjectedPoints, Viewer, VolumeLayer } from 'napari-js';

import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import {
  SpatialColumn,
  SpatialDataset,
  SpatialObservations,
  findColumnMeta,
  isCategoricalColumn,
} from '../../contracts/spatial-dataset.contract';
import { SpatialViewState } from '../../contracts/display-types';
import { DEFAULT_MUTED_OPACITY, resolveCategoryColors } from '../../spatial/spatial-encoding';
import { SpatialSelectionMask, emptySelection, maskToIndices } from '../../spatial/spatial-selection';
import { defaultSigma, densityGrid } from '../../spatial/spatial-density';
import { observationsInSection, sectionsOf } from '../../spatial/spatial-sections';
import {
  ExpressionVolumeField,
  encodeExpressionVolume,
  fieldContrastWindow,
} from '../../spatial/spatial-expression';
import { computeExpressionVolumeAsync, rasterizeDensityAsync } from '../../workers/spatial-math';
import { Supersede } from '../../util/supersede';
import { isAbortError } from '../tile-server';
import { NapariScaleBar, ScaleBarCamera } from './napari-scale-bar';
import {
  DensityGroup,
  GENE_MAP_SIGMA,
  GENE_MAP_VOLUME_STRIDE,
  SPATIAL_3D_BASE_SIZE,
  SPATIAL_SELECTED_SIZE_SCALE,
  Spatial3dEncoding,
  encodeSpatial3dCategorical,
  encodeSpatial3dContinuous,
  rankDensityGroups,
  spatialFlatColormap,
  totalDensityGroup,
} from './napari-spatial-encoding';
import { SpatialSceneBase, SpatialSession } from './napari-spatial-scene';
import type { NapariScene, SceneContext } from './napari-scene';

/**
 * SPATIAL_OMICS_3D (review Appendix B, cluster K): observations as a 3D point cloud under the
 * orbit camera, with the dataset's reference volume around it, per-cluster density volumes and the
 * 3D gene map.
 *
 * Thinner than the 2D scene: there is no tissue image to render (a registered volume like the
 * Allen CCF has no single reference plane), so no readback and no navigator; the 3D scale bar
 * follows the dataset (see {@link installScaleBar}). The region tools work in SCREEN space through
 * the tool bridge's 3D interaction — a lasso selects the cells under it, and an orbit clears the
 * shape while keeping the selection. The first 3D layer added frames the camera (`fit3d: 'once'`).
 */
export class Spatial3dScene extends SpatialSceneBase implements NapariScene {
  /** The 3D point cloud. One layer: selection is a per-point alpha on it, not a second. */
  private points: Points3DLayer | null = null;
  private layerKey: string | null = null;
  /** Interleaved x,y,z, cached so a colour change does not re-walk 3.7M observations. */
  private positions: Float32Array | null = null;
  /** Identity of the scalars currently uploaded — see {@link rebuild}. */
  private scalarKey: string | null = null;
  /** Observation indices the cached positions belong to, in the same order; null when every
   *  observation is drawn. Without it a projection built from the positions is indexed by DRAWN
   *  order and silently attributes each point to the wrong observation as soon as a section is
   *  isolated. */
  private drawn: Uint32Array | null = null;
  /** The anatomical volume the cloud sits inside, when the dataset has one. */
  private volume: VolumeLayer | null = null;
  private volumeKey: string | null = null;
  /** Per-cluster density volumes drawn alongside the cloud, and what they were
   *  built from — rasterising is seconds of work, so it must not repeat for a
   *  change that cannot affect the field. */
  private densityLayers: VolumeLayer[] = [];
  private densityKey: string | null = null;
  /** The 3D gene map's volume layer and the inputs it was coloured for (its field is cached in
   *  the session, on a clock of its own). */
  private geneMapLayer: VolumeLayer | null = null;
  private geneMapKey: string | null = null;
  /** Offset applied to observation coordinates to sit them in the volume's box. */
  private origin: [number, number, number] = [0, 0, 0];
  /** Reused projection buffers — see {@link screenProjection}. */
  private projection: ProjectedPoints | undefined = undefined;
  /** Per-observation depth from the last projection, for the depth-aware hover pick. */
  private depths: Float32Array | null = null;
  private scaleBar: NapariScaleBar | null = null;
  /** Dataset the scale bar was built for. */
  private scaleBarKey: string | null = null;
  /** The density rasterisation and the 3D gene-map estimate in flight (off the main thread
   *  past the worker threshold, SPATIAL-19): a new key supersedes — and aborts — the previous
   *  one; a rebuild that leaves the key alone lets it finish. */
  private readonly densityLoads = new Supersede();
  private readonly geneMapLoads = new Supersede();

  constructor(ctx: SceneContext, session: SpatialSession) {
    super(ctx, session, true);
  }

  async mount(): Promise<void> {
    this.ctx.tools.install3dInteraction(this.ctx.viewer, this.ctx.host);
    this.hover.install(this.ctx.host);
    this.subscribeSpatial();
  }

  /** The observations' own z is on screen: there is no plane to step. */
  setZ(): void {
    /* nothing to step */
  }

  /** A cloud has no intensity distribution for the histogram pane. */
  histogram(): IHistogram | null {
    return null;
  }

  screenProjection(obs: SpatialObservations): Float32Array | null {
    return this.project(obs);
  }

  dispose(): void {
    this.disposeSpatial();
    this.densityLoads.cancel();
    this.geneMapLoads.cancel();
    this.scaleBar?.destroy();
    this.scaleBar = null;
    // Drop the cached interleaved coordinates too: holding 3.7M x 3 floats after
    // a teardown is ~45MB of retained heap for a scene that no longer exists.
    this.positions = null;
  }

  protected hoverPositions(obs: SpatialObservations): Float32Array | null {
    return this.project(obs);
  }

  protected override hoverDepths(): Float32Array | null {
    return this.depths;
  }

  /**
   * Project every observation to canvas pixels under the current 3D camera.
   *
   * The projection itself is the renderer's: `viewer.projectPoints` owns the camera, the
   * viewport in CSS pixels, the perspective divide and the y-flip. What is left is the part
   * that is genuinely this adapter's: SCATTERING the drawn subset back into observation order.
   * The cloud holds only the points of the displayed section, in its own packing; every consumer
   * indexes by observation. NaN stands for "not on screen", which is also the right answer for
   * an observation whose section is hidden.
   *
   * Null before the cloud is built.
   */
  private project(obs: SpatialObservations): Float32Array | null {
    if (!this.positions) return null;
    const projected = this.ctx.viewer.projectPoints(this.positions, this.projection);
    if (!projected) return null;
    // Reused across camera changes: at 3.7M observations this is a 30 MB allocation that
    // would otherwise happen on every orbit.
    this.projection = projected;

    const drawn = this.drawn;
    const { screen, depth } = projected;
    const count = screen.length >> 1;
    const out = new Float32Array(obs.count * 2).fill(NaN);
    const depths = new Float32Array(obs.count).fill(NaN);
    for (let k = 0; k < count; k++) {
      const i = drawn ? drawn[k] : k;
      if (i >= obs.count) continue;
      out[i * 2] = screen[k * 2];
      out[i * 2 + 1] = screen[k * 2 + 1];
      depths[i] = depth[k];
    }
    // Kept beside the screen positions so the hover pick can prefer the FRONT-most point
    // under the cursor rather than the one nearest its centre — which in a dense cloud is
    // regularly something the renderer drew another point over.
    this.depths = depths;
    return out;
  }

  /**
   * Scale bar for the cloud, measured at the ORBIT PIVOT.
   *
   * A perspective camera has no single scale — things farther away are smaller — so a bar can
   * only be true at one depth. The pivot is the honest choice: it is what the camera is framing,
   * what a zoom moves towards, and where the eye is anyway. napari's own 3D scale bar works the
   * same way.
   *
   * `NapariScaleBar` needs CSS px per world unit, which an orbit camera does not expose, but at
   * the pivot it is exactly `viewportHeight / (2 * distance * tan(fov / 2))` — the same
   * relationship `Camera3D.pan` uses to track the cursor. The bar then converts through
   * `micronsPerUnit`, and draws nothing at all when the dataset does not declare one, because a
   * bar labelled in microns over unknown units would read as a measurement.
   */
  private installScaleBar(dataset: SpatialDataset | null): void {
    this.scaleBar?.destroy();
    this.scaleBar = null;
    const micronsPerUnit = dataset?.micronsPerUnit;
    if (!micronsPerUnit || micronsPerUnit <= 0) return;

    const canvas = this.ctx.canvas;
    const cam = this.ctx.viewer.camera3d;
    const shim: ScaleBarCamera = {
      get zoom(): number {
        const h = canvas?.clientHeight || canvas?.height || 0;
        const worldPerPx = (2 * cam.distance * Math.tan(cam.fov / 2)) / (h || 1);
        return worldPerPx > 0 ? 1 / worldPerPx : 0;
      },
      changed: cam.changed,
    };
    this.scaleBar = new NapariScaleBar(this.ctx.host, shim, micronsPerUnit);
  }

  /** (Re)build the 3D point cloud for the current dataset + view state. */
  protected async rebuild(
    dataset: SpatialDataset | null,
    view: SpatialViewState,
    selection: SpatialSelectionMask = emptySelection(),
  ): Promise<void> {
    const viewer = this.ctx.viewer;
    const task = this.rebuilds.next();

    // Resolve the scalar encoding BEFORE touching the scene, for the same reason
    // the 2D path does: a gene fetch can fail or be superseded, and dropping the
    // layer first would blank the view.
    let enc: Spatial3dEncoding | null = null;
    if (dataset) {
      const endLoading = this.ctx.badge.begin('Observations');
      try {
        enc = await this.scalarEncoding(view);
      } catch (err) {
        console.warn('[napari-js] spatial 3D colouring failed — falling back to a flat colour', err);
        enc = null;
      } finally {
        endLoading();
      }
    }
    if (!task()) return;

    const obs = dataset?.observations;
    // No z means nothing to draw in 3D. The plot type is gated on `requiresSpatial3d`
    // so this should be unreachable from the UI, but a host can set the type directly.
    if (!dataset || !obs || obs.count === 0 || !obs.z) {
      this.removeLayers(viewer);
      return;
    }

    // Anatomy first: on a scene's FIRST layer napari frames the orbit camera, and
    // the reference volume is the framing we want — the brain, not the outermost
    // stray segmentation. Every later add keeps the pose instead (napari-js `fit3d: 'once'`).
    await this.ensureVolume(viewer, dataset, view);
    if (!task()) return;
    // Then the cluster density volumes, which can set the centring offset when
    // there is no reference volume — so before any position is computed from it.
    await this.ensureDensityVolumes(viewer, dataset, view, selection);
    if (!task()) return;
    // Then the gene map, which shares the reference volume's lattice — so it goes
    // after anything that can still move the centring offset.
    await this.ensureGeneMap(viewer, dataset, view, selection);
    if (!task()) return;
    // Scale depends on the dataset's declared unit, so it waits for the dataset
    // rather than being set up at mount time.
    if (dataset.id !== this.scaleBarKey) {
      this.scaleBarKey = dataset.id;
      this.installScaleBar(dataset);
    }

    // The reference volume is hidden, not removed: it also fixes the centring
    // offset every position is computed from, and re-fetching a 100 MB template
    // to un-hide it would make a checkbox feel like a load.
    if (this.volume) {
      this.volume.visible = view.showVolume;
      this.volume.opacity = view.volumeOpacity;
    }

    const scale = view.pointScale > 0 ? view.pointScale : 1;
    const size = SPATIAL_3D_BASE_SIZE * scale;
    const scalars = enc?.values ?? new Float32Array(obs.count);
    const colormap = enc?.colormap ?? spatialFlatColormap();
    const contrastLimits: [number, number] = enc?.contrastLimits ?? [0, 1];

    // One imaged section, or the whole stack. The subset IS the geometry, so it
    // belongs in the geometry key rather than being re-derived per frame — and an
    // out-of-range index is clamped rather than dropping the cloud, because the
    // section count changes with the dataset while the view state persists.
    const sections = sectionsOf(obs);
    const section =
      view.pointSection != null && sections && sections.length > 0
        ? sections[Math.max(0, Math.min(sections.length - 1, view.pointSection))]
        : null;
    const shown = section != null ? observationsInSection(obs, section) : null;
    const shownCount = shown ? shown.length : obs.count;

    const key = `${dataset.id}:${obs.count}:${section ?? 'all'}`;
    // Track the scalars' identity separately from the geometry's (`colorBy` plus the
    // transforms feeding the encoding): a new colour source swaps `values` in place
    // (napari-js ≥ 0.14), while a new geometry needs a new layer.
    const clip = view.percentileClip ?? [0.01, 0.99];
    const scalarKey = [
      key,
      view.colorBy ? `${view.colorBy.kind}:${view.colorBy.name}` : 'flat',
      view.logScale ? 'log' : 'lin',
      clip.join(','),
    ].join('|');

    if (key !== this.layerKey) {
      // New geometry: interleave x,y,z (the layer's documented layout, x-fastest)
      // and cache it, so later colour changes rebuild the layer without walking
      // the observations again.
      const [ox, oy, oz] = this.origin;
      const positions = new Float32Array(shownCount * 3);
      for (let k = 0; k < shownCount; k++) {
        const i = shown ? shown[k] : k;
        positions[k * 3] = obs.x[i] + ox;
        positions[k * 3 + 1] = obs.y[i] + oy;
        positions[k * 3 + 2] = obs.z[i] + oz;
      }
      this.positions = positions;
      this.drawn = shown;
    }

    // The scalars have to follow the geometry: a per-observation vector against one
    // section's positions would colour each cell by a stranger's value.
    const valuesFor = () => (shown ? Float32Array.from(shown, (i) => scalars[i]) : scalars);

    if (!this.points || key !== this.layerKey) {
      // New GEOMETRY — a different dataset, or a different section — so a new layer.
      if (this.points) viewer.layers.remove(this.points);
      this.layerKey = key;
      this.scalarKey = scalarKey;
      this.points = viewer.addPoints3D(this.positions!, valuesFor(), {
        name: 'observations',
        colormap,
        contrastLimits,
        size,
      });
    } else {
      if (scalarKey !== this.scalarKey) {
        // A change of colour SOURCE, which used to mean discarding the layer and building
        // another — and, because adding a 3D layer reframes, a camera jump to undo as well.
        // napari-js ≥ 0.14 lets the scalars be replaced in place — the setter bumps the
        // layer's dataVersion so the visual re-uploads — and the positions have not moved,
        // so there is nothing for the camera to reframe.
        this.scalarKey = scalarKey;
        this.points.values = valuesFor();
      }
      this.points.colormap = colormap;
      this.points.contrastLimits = contrastLimits;
      this.points.size = size;
    }

    // Selection is a PER-POINT alpha, in the one layer.
    //
    // It used to be a second layer: with a single opacity for the whole cloud, the only way
    // to highlight a subset was to draw it again on top at full opacity while the parent
    // dropped to the muted level. That second layer had to be kept in step through every
    // colormap, window and size change, and the two then depth-sorted against each other as
    // separate draws. Per-point alphas and sizes give the same reading — muted cloud, bright
    // selection, slightly larger so a small one is findable inside 3.7M points — in one.
    const hasSelection = selection.count > 0 && selection.mask.length === obs.count;
    const cloud = this.points;
    if (cloud) {
      cloud.opacity = view.opacity;
      if (!hasSelection) {
        cloud.alphas = null;
        cloud.sizes = null;
      } else {
        const alphas = new Float32Array(shownCount);
        const sizes = new Float32Array(shownCount);
        for (let k = 0; k < shownCount; k++) {
          const i = shown ? shown[k] : k;
          const picked = !!selection.mask[i];
          alphas[k] = picked ? 1 : DEFAULT_MUTED_OPACITY;
          sizes[k] = picked ? SPATIAL_SELECTED_SIZE_SCALE : 1;
        }
        cloud.alphas = alphas;
        cloud.sizes = sizes;
      }
    }
    // Last, so it also covers a layer this pass just created.
    if (this.points) this.points.visible = view.showPoints;
    viewer.requestRender();
  }

  /**
   * The **3D gene map**: the active gene's expression over the whole sectioned
   * specimen, as one raymarched volume.
   *
   * Two things it can be, and the panel's `Volume rendering` toggle picks which:
   *
   *  - **sheets** — exactly the planes that were imaged, each carrying that
   *    slide's own 2D gene map, with the gaps between sections empty. A stack of
   *    measured fields, at their true z.
   *  - **volume** — the same fields smoothed along z, so the planes between the
   *    sections carry an interpolated value. An estimate, and drawn as a
   *    translucent cloud for the same reason the density volumes are.
   *
   * One `VolumeLayer` rather than a textured quad per section: an `ImageLayer`
   * renders only at `ndisplay === 2`, so 53 sheets in the orbit view would need a
   * new layer type upstream — while a scalar volume whose z sampling already IS
   * the section spacing expresses the sheets exactly, and the same lattice then
   * gives the interpolated version for free.
   *
   * Estimated on the reference volume's own lattice (`densityGrid` at stride 1),
   * so the field lands voxel-for-voxel on the anatomy and needs no offset — a
   * `VolumeLayer` has no translate, and napari centres both boxes on the world
   * origin.
   */
  private async ensureGeneMap(
    viewer: Viewer,
    dataset: SpatialDataset,
    view: SpatialViewState,
    selection: SpatialSelectionMask,
  ): Promise<void> {
    const gene = view.geneMap && view.colorBy?.kind === 'feature' ? view.colorBy.name : null;
    const port = this.session.port;
    const cache = this.session.geneMapVolume;
    const smoothing = view.geneMapSmoothing > 0 ? view.geneMapSmoothing : 1;
    const clip = view.percentileClip ?? [0.01, 0.99];
    const obs = dataset.observations;
    // A volume built from ONE section would smear that slide through the whole
    // depth, so the section restriction only applies to the sheets.
    const interpolate = !!view.geneMapVolume;
    const sections = sectionsOf(obs);
    const section =
      !interpolate && view.geneMapSection != null && sections && sections.length > 0
        ? sections[Math.max(0, Math.min(sections.length - 1, view.geneMapSection))]
        : null;

    const fieldKey = gene
      ? [
          dataset.id,
          gene,
          smoothing,
          section ?? 'all',
          interpolate ? 'vol' : 'sheets',
          this.session.selectionRev(selection),
        ].join('|')
      : null;
    const key = fieldKey
      ? [
          fieldKey,
          clip.join(','),
          view.logScale ? 'log' : 'lin',
          view.geneMapOpacity,
          this.ctx.display.continuousColormapKey(view),
        ].join('|')
      : null;
    if (key === this.geneMapKey) return;

    if (this.geneMapLayer) {
      viewer.layers.remove(this.geneMapLayer);
      this.geneMapLayer = null;
    }
    this.geneMapKey = key;
    if (!key || !gene || !port) {
      cache.field = null;
      cache.key = null;
      return;
    }

    // Coarsened in-plane but NOT along z: the sheets need one plane per imaged
    // section, while the field they carry is smooth by construction and gains
    // nothing from the template's 40 µm detail. At full resolution the estimate is
    // a 5.7M-voxel pair of blurs — seconds of work for a checkbox; an eighth of the
    // voxels is an eighth of the work.
    const grid = densityGrid(dataset, GENE_MAP_VOLUME_STRIDE, 128, 1);
    if (!grid) return;

    if (fieldKey !== cache.key) {
      const load = this.geneMapLoads.next();
      let values: Float32Array;
      try {
        values = await port.getFeatureVector(gene);
      } catch (err) {
        console.warn(`[napari-js] 3D gene map: "${gene}" unavailable`, err);
        this.geneMapKey = null;
        return;
      }
      if (!load() || this.geneMapKey !== key) return;
      const inSelection = selection.count > 0 ? maskToIndices(selection.mask) : undefined;
      // In-plane σ is a PHYSICAL bandwidth, anchored to the reference volume's own
      // voxel — the resolution the 2D map estimates at — so a sheet and the 2D
      // view of the same section are the same field whatever lattice this is
      // rasterised on. Along z it is the density path's 1.5 voxels: the smallest σ
      // that bridges one section gap.
      const inPlane = dataset.volume?.voxelSize ?? grid.voxelSize;
      let field: ExpressionVolumeField | null;
      try {
        field = await computeExpressionVolumeAsync(
          obs,
          grid,
          {
            sigma: [
              inPlane[0] * GENE_MAP_SIGMA * smoothing,
              inPlane[1] * GENE_MAP_SIGMA * smoothing,
              grid.voxelSize[2] * 1.5 * smoothing,
            ],
            values,
            indices: section != null ? observationsInSection(obs, section) : inSelection,
            interpolate,
          },
          { signal: load.signal },
        );
      } catch (err) {
        if (isAbortError(err)) return; // superseded by a newer map, or the scene went away
        throw err;
      }
      if (!load() || this.geneMapKey !== key) return;
      cache.field = field;
      cache.key = fieldKey;
    }
    const field = cache.field;
    if (!field) return;

    // The high end over the MEASURED voxels only (the unmeasured zeros would pull it down and
    // saturate the map), but the low end stays 0: in a volume the value is also the opacity and
    // 0 reads as "nothing here", so starting at the lowest measured value would erase it.
    const [, hi] = fieldContrastWindow(field, clip[0], clip[1]);
    const lo = 0;
    const data = encodeExpressionVolume(field, [lo, hi], { log: view.logScale });
    const lut = this.ctx.display.spatialLut(view);
    this.geneMapLayer = viewer.addVolume(data, field.width, field.height, field.depth, {
      name: `gene map · ${gene}${interpolate ? ' · volume' : ''}`,
      colormap: colormapFromLut(`gene-map-${gene}`, lut),
      // The encoding already applied the window, so the layer must not apply a
      // second one: 0..255 is the whole of what it was given.
      contrastLimits: [0, 255],
      rendering: 'translucent',
      // Additive like the density volumes, and for the same reason: the sheets
      // have to read THROUGH each other and through the anatomy, which a
      // translucent blend would occlude one sheet at a time.
      blending: 'additive',
      opacity: view.geneMapOpacity,
      voxelSize: grid.voxelSize,
    });
    viewer.requestRender();
  }

  /**
   * Cluster density volumes: each cluster rasterised into a smooth scalar field and
   * raymarched alongside the cloud, tinted with the cluster's own legend colour.
   *
   * This is what makes a serially sectioned dataset readable as an anatomical
   * distribution. The cloud shows measured cells and nothing else — but at 200 µm
   * section spacing the eye cannot integrate a stack of discs into a shape, and
   * every gap reads as absence. A density field is a different object from a cell:
   * an estimate, defined between the imaged planes, drawn as a translucent cloud so
   * it cannot be mistaken for measurement. Individual cells are never interpolated —
   * consecutive sections sample different cells, so there is nothing to interpolate
   * along.
   *
   * One volume per cluster rather than one for everything: additive blending is what
   * makes two clusters' territories comparable, and a single blended field would
   * answer no question anyone asks of a taxonomy. Capped at `DENSITY_MAX_CLUSTERS` by cell
   * count.
   *
   * Keyed so it rebuilds only when the field would actually differ — the dataset,
   * the colour column, the bandwidth, or the selection.
   */
  private async ensureDensityVolumes(
    viewer: Viewer,
    dataset: SpatialDataset,
    view: SpatialViewState,
    selection: SpatialSelectionMask,
  ): Promise<void> {
    const on = !!view.densityVolume && !!dataset.observations.z;
    const smoothing = view.densitySmoothing > 0 ? view.densitySmoothing : 1;
    const column = view.colorBy?.kind === 'column' ? view.colorBy.name : null;
    // The selection enters the key by IDENTITY, not by count: two different ROIs
    // holding the same number of cells would otherwise look like the same key and
    // leave the previous ROI's fields on screen.
    const key = on
      ? [dataset.id, column ?? 'all', smoothing, this.session.selectionRev(selection)].join('|')
      : null;
    if (key === this.densityKey) return;

    for (const layer of this.densityLayers) viewer.layers.remove(layer);
    this.densityLayers = [];
    this.densityKey = key;
    const load = this.densityLoads.next();
    if (!key) return;

    const grid = densityGrid(dataset);
    if (!grid) return;
    // With no reference volume there is no offset yet, and a VolumeLayer has no
    // translate — napari centres its box on the world origin. So the POINTS move by
    // half the density box, exactly as they do for a reference volume, and the
    // cached geometry is invalidated because that offset just changed.
    if (!this.volume) {
      this.origin = [
        -(grid.width * grid.voxelSize[0]) / 2,
        -(grid.height * grid.voxelSize[1]) / 2,
        -(grid.depth * grid.voxelSize[2]) / 2,
      ];
      this.layerKey = null;
    }

    let groups: DensityGroup[];
    try {
      groups = await this.densityGroups(dataset, column, selection);
    } catch (err) {
      console.warn('[napari-js] density volumes: column unavailable', err);
      this.densityKey = null;
      return;
    }
    if (!load() || this.densityKey !== key) return;

    const sigma = defaultSigma(grid, smoothing);
    // Additive blending SUMS, so a fixed per-layer opacity blows out to white as
    // soon as several broad clusters overlap — six subclasses at 0.55 each turned
    // the brain into one cyan mass. Splitting the budget keeps n fully overlapping
    // peaks inside the display's range, so overlap reads as overlap; a single
    // cluster still gets the full 0.55. It only mitigates: a translucent raymarch
    // integrates along the ray, so clusters that are ubiquitous rather than
    // regional (the largest subclasses are glia, which are everywhere) still pile
    // up, and one cluster at a time is the readable way to look at those.
    const opacity = Math.min(0.55, 0.9 / Math.max(1, groups.length));
    let fields: (Uint8Array | null)[];
    try {
      // Off the main thread past the worker threshold; the clusters queue on one worker.
      fields = await Promise.all(
        groups.map((group) =>
          rasterizeDensityAsync(
            dataset.observations,
            grid,
            { sigma, indices: group.indices },
            { signal: load.signal },
          ),
        ),
      );
    } catch (err) {
      if (isAbortError(err)) return; // superseded by a newer key, or the scene went away
      throw err;
    }
    if (!load() || this.densityKey !== key) return;
    groups.forEach((group, i) => {
      const data = fields[i];
      // A cluster with nothing on the grid draws no layer, rather than an empty box.
      if (!data) return;
      this.densityLayers.push(
        viewer.addVolume(data, grid.width, grid.height, grid.depth, {
          name: `density · ${group.name}`,
          colormap: this.ctx.display.channelTintColormap(group.color),
          // Translucent, not MIP: a cluster's interior is the readable part, and MIP
          // would flatten every cloud to its brightest shell.
          rendering: 'translucent',
          opacity,
          // Additive, so two clusters overlapping read as both being there instead
          // of the nearer one hiding the other.
          blending: 'additive',
          voxelSize: grid.voxelSize,
        }),
      );
    });
    viewer.requestRender();
  }

  /**
   * The clusters to rasterise: the categories of the active categorical colouring,
   * biggest first and capped, each with its legend colour, restricted to the current selection
   * when there is one. With no categorical colouring there is one group — total cell density,
   * which is a real question on its own ("where is the tissue dense?") and the honest thing to
   * show when the view is not encoding a taxonomy.
   */
  private async densityGroups(
    dataset: SpatialDataset,
    column: string | null,
    selection: SpatialSelectionMask,
  ): Promise<DensityGroup[]> {
    const port = this.session.port;
    const meta = column ? findColumnMeta(dataset, column) : undefined;
    if (!port || !column || !meta || meta.kind !== 'categorical') return [totalDensityGroup(selection)];
    const loaded = await port.getColumn(column);
    if (!isCategoricalColumn(loaded)) return [];
    return rankDensityGroups(column, loaded, dataset.observations.count, selection);
  }

  /**
   * Add (or keep) the dataset's reference volume, and derive the offset that sits the
   * observations inside it.
   *
   * `VolumeLayer` has no translate: napari-js maps the volume's unit cube to a world box
   * **centred on the origin**, sized `dims x voxelSize`. The observations, by contract, are in
   * the volume's own frame with its near corner at the coordinate origin. So the two only line
   * up if the POINTS move — by half the box — which is what {@link origin} is.
   *
   * A failed or absent volume is not fatal: the cloud renders on its own, at its own
   * coordinates, and the camera frames the points instead.
   */
  private async ensureVolume(viewer: Viewer, dataset: SpatialDataset, view: SpatialViewState): Promise<void> {
    const meta = dataset.volume;
    const port = this.session.port;
    const key = meta ? `${dataset.id}:${meta.width}x${meta.height}x${meta.depth}` : null;
    if (key && key === this.volumeKey) return;

    if (this.volume) {
      viewer.layers.remove(this.volume);
      this.volume = null;
      this.volumeKey = null;
    }
    this.origin = [0, 0, 0];
    if (!meta || !port?.getVolume) return;

    let voxels: Uint8Array;
    try {
      voxels = await port.getVolume();
    } catch (err) {
      console.warn('[napari-js] reference volume unavailable — drawing the cloud alone', err);
      return;
    }
    if (this.ctx.signal.aborted) return;

    const [vx, vy, vz] = meta.voxelSize;
    this.volumeKey = key;
    this.volume = viewer.addVolume(voxels, meta.width, meta.height, meta.depth, {
      name: 'reference volume',
      colormap: 'gray',
      // MIP would draw the brightest voxel along each ray, which for an averaged
      // template means a flat white shell that hides the cloud. Translucent lets
      // the points read through the tissue, which is the entire point of drawing
      // them together.
      rendering: 'translucent',
      opacity: view.volumeOpacity,
      voxelSize: [vx, vy, vz],
    });
    // Half the box, negated: the observations' origin is the box's near corner,
    // and the box is centred on the world origin.
    this.origin = [-(meta.width * vx) / 2, -(meta.height * vy) / 2, -(meta.depth * vz) / 2];
    // Force a geometry rebuild: the offset changed, so cached positions are stale.
    this.layerKey = null;
  }

  /** Drop every layer of the cloud (the dataset went away, or has no z). */
  private removeLayers(viewer: Viewer): void {
    for (const layer of [this.points, this.volume, this.geneMapLayer, ...this.densityLayers]) {
      if (layer) viewer.layers.remove(layer);
    }
    this.geneMapLayer = null;
    this.geneMapKey = null;
    this.session.geneMapVolume.field = null;
    this.session.geneMapVolume.key = null;
    this.densityLayers = [];
    this.densityKey = null;
    // The scene is gone, so the next 3D layer should frame itself again. That used to be
    // `spatialFramed = null` next to a hand-rolled save/restore; the renderer owns the
    // policy now, and this is the same statement addressed to it.
    viewer.resetFit3D();
    this.volume = null;
    this.volumeKey = null;
    this.origin = [0, 0, 0];
    this.points = null;
    this.layerKey = null;
    this.scalarKey = null;
    this.positions = null;
    this.drawn = null;
  }

  /**
   * The per-point scalar + colormap + window that colour the cloud.
   *
   * Continuous data is the natural fit: values go straight through the active colormap with the
   * same percentile window the 2D path uses. Categorical data has to be smuggled through the same
   * scalar channel — see `encodeSpatial3dCategorical`.
   */
  private async scalarEncoding(view: SpatialViewState): Promise<Spatial3dEncoding | null> {
    const port = this.session.port;
    const colorBy = view.colorBy;
    if (!port || !colorBy) return null;

    if (colorBy.kind === 'column') {
      const column: SpatialColumn = await port.getColumn(colorBy.name);
      if (isCategoricalColumn(column)) {
        return encodeSpatial3dCategorical(column.codes, resolveCategoryColors(column.meta));
      }
      return this.encodeContinuous(column.values, view);
    }
    return this.encodeContinuous(await port.getFeatureVector(colorBy.name), view);
  }

  /** Continuous values → the active colormap over a percentile-clipped window. */
  encodeContinuous(source: Float32Array, view: SpatialViewState): Spatial3dEncoding {
    return encodeSpatial3dContinuous(
      source,
      view,
      this.ctx.display.spatialLut(view),
      this.session.contrastWindows,
    );
  }
}
