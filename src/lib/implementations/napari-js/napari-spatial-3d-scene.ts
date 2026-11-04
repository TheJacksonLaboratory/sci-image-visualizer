import { cellTypeColumnFor } from '../../spatial/lod';
import { Subscription } from 'rxjs';
import { PointPicker, colormapFromLut } from 'napari-js';
import type { Points3DLayer, Viewer, VolumeLayer } from 'napari-js';
import { ScaleBarOverlay, formatLength } from 'napari-js/overlays';
import type { AxisLabelSpec } from 'napari-js/overlays';

import { IHistogram } from '../../contracts/channel-histogram-api.contract';
import { ISurface3dControls } from '../../contracts/visualizer.contract';
import {
  SpatialColumn,
  SpatialDataset,
  SpatialObservations,
  findColumnMeta,
  isCategoricalColumn,
} from '../../contracts/spatial-dataset.contract';
import { SpatialViewState } from '../../contracts/display-types';
import { DEFAULT_MUTED_OPACITY, categoryColorsFor, groupColorsKey } from '../../spatial/spatial-encoding';
import { SpatialSelectionMask, emptySelection, maskToIndices } from '../../spatial/spatial-selection';
import { defaultSigma, densityGrid } from '../../spatial/spatial-density';
import { observationsInSection, sectionsOf } from '../../spatial/spatial-sections';
import {
  geneFilterKey,
  observationGeneMask,
  observationGeneStyle,
  observationGeneStyleKey,
} from '../../spatial/spatial-gene-filter';
import {
  ExpressionVolumeField,
  encodeExpressionVolume,
  fieldContrastWindow,
} from '../../spatial/spatial-expression';
import { computeExpressionVolumeAsync, rasterizeDensityAsync } from '../../workers/spatial-math';
import { Supersede } from '../../util/supersede';
import type { IImageInfo } from '../../contracts/image.contract';
import { PlanePlacement, RegionMesh3D, VolumeRegionMeshes } from './napari-volume-region-meshes';
import { isAbortError } from '../tile-server';
import {
  DensityGroup,
  GENE_MAP_SIGMA,
  GENE_MAP_VOLUME_STRIDE,
  SPATIAL_3D_BASE_SIZE,
  SPATIAL_SELECTED_SIZE_SCALE,
  Spatial3dEncoding,
  Spatial3dScalars,
  encodeSpatial3dCategorical,
  encodeSpatial3dContinuous,
  gatherColors,
  rankDensityGroups,
  spatialFlatColormap,
  totalDensityGroup,
} from './napari-spatial-encoding';
import { HOVER_RADIUS_PX } from './napari-spatial-hover';
import { Axes3dGizmo, Box3, surface3dControls } from './napari-axes-gizmo';
import { NapariVolumeZHandle } from './napari-volume-z-handle';
import { Spatial3dTranscripts } from './napari-spatial-3d-transcripts';
import { Spatial3dCells } from './napari-spatial-3d-cells';
import { cellColorsFor, cellColorsRgba } from './spatial-tiles/cell-layers';
import { CategoricalLookup } from './spatial-tiles/categorical-lookup';
import { ContrastWindowCache } from './napari-spatial-encoding';
import { NO_CATEGORY } from '../../contracts/spatial-dataset.contract';
import { SpatialSceneBase, SpatialSession } from './napari-spatial-scene';
import type { NapariScene, SceneContext } from './napari-scene';

/** The least Z stretch: a tenth of the true depth. */
export const SPATIAL_Z_SCALE_MIN = 0.1;
/** The most Z stretch a cloud allows, at least: the Volume view's. */
const SPATIAL_Z_SCALE_MAX = 10;
/** Nor more than this, however thin the cloud is. */
const SPATIAL_Z_SCALE_CEILING = 1000;
/**
 * In-plane voxels across the image when a region set's planes are reconstructed over the dataset's
 * own image (see voxelStep): a step of about 5 px on a 5,700 px wide MERFISH section (0.6 µm).
 */
export const REGION_PLANES_VOXELS = 1024;

/**
 * The most a box's Z may be stretched: until it is twice as deep as it is wide, so even a section
 * microns thick and millimetres wide can be stood up into a block — but never less than the
 * Volume view's 10x, nor more than {@link SPATIAL_Z_SCALE_CEILING}.
 */
export function spatialZScaleMax(box: Box3): number {
  const flat = (2 * Math.max(box.width, box.height)) / Math.max(box.depth, 1e-9);
  return Math.min(SPATIAL_Z_SCALE_CEILING, Math.max(SPATIAL_Z_SCALE_MAX, flat));
}

/**
 * The Z handle's drag (px) per doubling: the Volume view's 180 px, less when the range is wider,
 * so going from the true depth to the most stretch is about the same drag (~540 px) either way.
 */
export function spatialZPixelsPerDouble(maxScale: number): number {
  return Math.max(60, Math.min(180, 540 / Math.log2(Math.max(2, maxScale))));
}

/**
 * The X/Y/Z axis-end labels for a box (as drawn: Z stretched by `zScale`), its true lengths in µm
 * when the dataset declares `micronsPerUnit`, else in its own units. A stretched Z says by how much,
 * so its length is never read off the drawing.
 */
export function spatialAxesLabels(drawn: Box3, zScale: number, micronsPerUnit?: number): AxisLabelSpec[] {
  const hx = drawn.width / 2;
  const hy = drawn.height / 2;
  const hz = drawn.depth / 2;
  const mpu = micronsPerUnit && micronsPerUnit > 0 ? micronsPerUnit : 0;
  const len = (n: number): string => (mpu ? formatLength(n * mpu, 'µm') : `${+n.toPrecision(3)} units`);
  const stretch = Math.abs(zScale - 1) > 1e-3 ? ` (×${+zScale.toPrecision(3)})` : '';
  return [
    { anchor: [hx, -hy, -hz], text: `X · ${len(drawn.width)}`, color: '#ed4545' },
    { anchor: [-hx, hy, -hz], text: `Y · ${len(drawn.height)}`, color: '#4dd959' },
    { anchor: [-hx, -hy, hz], text: `Z · ${len(drawn.depth / zScale)}${stretch}`, color: '#668cff' },
  ];
}

/**
 * SPATIAL_OMICS_3D (review Appendix B, cluster K): observations as a 3D point cloud under the
 * orbit camera, with the dataset's reference volume around it, per-cluster density volumes and the
 * 3D gene map.
 *
 * Everything sits in one box centred on the world origin (see {@link ensureFrame}): the reference
 * volume's, else the density grid's. The Volume view's axes gizmo and Z-height handle are drawn on
 * it, and the handle stretches Z: the cloud through its `scale3d`, every volume through its voxel
 * size, so nothing is re-uploaded while dragging (see {@link setZScale}).
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
  /**
   * The reference volume on its way (its key and the load), shared by every rebuild that asks for
   * it meanwhile: each one adding its own left one layer behind, which the view's toggle (bound to
   * {@link volume}) then never hid.
   */
  private volumeLoading: { key: string; done: Promise<void> } | null = null;
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
  /** The box everything sits in, before the Z stretch, centred on the origin (see ensureFrame). */
  private box: Box3 | null = null;
  private boxKey: string | null = null;
  /** The axes gizmo on {@link box} and the handle that stretches its Z (see setZScale). */
  private gizmo: Axes3dGizmo | null = null;
  private zHandle: NapariVolumeZHandle | null = null;
  /** Each volume layer's own voxel size, before the Z stretch. */
  private readonly baseVoxels = new WeakMap<VolumeLayer, [number, number, number]>();
  /**
   * napari-js's depth-aware pick over the cloud, and the projection the ROI selection reads. It
   * owns the caching policy: re-project lazily, on the first pick after the camera, the canvas or
   * the cloud's data moved (never on the camera event, so an orbit drag pays nothing), into
   * reused buffers, with a screen index once the cloud is large enough.
   */
  private picker: PointPicker | null = null;
  private scaleBar: ScaleBarOverlay | null = null;
  /** Dataset the scale bar was built for. */
  private scaleBarKey: string | null = null;
  /** The density rasterisation and the 3D gene-map estimate in flight (off the main thread
   *  past the worker threshold, SPATIAL-19): a new key supersedes — and aborts — the previous
   *  one; a rebuild that leaves the key alone lets it finish. */
  private readonly densityLoads = new Supersede();
  private readonly geneMapLoads = new Supersede();
  /**
   * The region reconstructions (an atlas's structures, imported onto the reference volume's image
   * stack), drawn by the same {@link VolumeRegionMeshes} as the Volume view's, so a structure is the
   * same surface in both. Placed in the reference volume's box, once it is there and the image the
   * regions were drawn on is that volume's stack (see {@link placeRegionMeshes}).
   */
  private readonly regionMeshes: VolumeRegionMeshes;
  /** The transcripts of the genes the Transcripts panel draws, at their own z (see Spatial3dTranscripts). */
  private readonly transcripts3d: Spatial3dTranscripts;
  /** Whether the reference volume lets every region surface through (see setRegionsThroughVolume). */
  private regionsThrough = false;
  /**
   * Each slice's z, in the observations' units, of the region set the surfaces are built from when
   * it says where its slices are (a 3D segmentation's planes, see setRegionPlanes); else null.
   */
  private regionPlanes: readonly number[] | null = null;
  /** The store's invert setting, which the density volumes follow (no other subscription of
   *  this scene carries it). */
  private invertSub: Subscription | null = null;

  /**
   * @param info the image plotted with the cloud: the reference volume's stack (the 2D view's
   *        image, see showVolumeAsImage) when the dataset has a volume, which the regions are on
   */
  constructor(
    ctx: SceneContext,
    session: SpatialSession,
    private readonly info?: IImageInfo,
  ) {
    super(ctx, session, true);
    this.regionMeshes = new VolumeRegionMeshes(ctx.viewer);
    this.transcripts3d = new Spatial3dTranscripts(ctx.viewer, (label) => ctx.badge.begin(label));
    this.cells3d = new Spatial3dCells({
      viewer: ctx.viewer,
      port: session.port,
      beginTask: (label) => ctx.badge.begin(label),
      status: (status) => session.reportCells3d(status),
    });
    this.cellLookup = session.port ? new CategoricalLookup(session.port) : null;
  }

  /** The region set's classes drawn as individual cells (none: the class surfaces only). */
  private readonly cells3d: Spatial3dCells;
  private readonly cellLookup: CategoricalLookup | null;
  private readonly cellWindows = new ContrastWindowCache();
  private cellClasses: readonly string[] | null = null;
  /** What the cells were last coloured for, so a rebuild that changed none of it recolours nothing. */
  private cellStyleKey: string | null = null;
  private cellStyleRequest = 0;

  /**
   * Draw these classes of the dataset's region set as individual cells, each its own surface in
   * the panel's Cell Color (see Spatial3dCells); none: no cells.
   */
  setRegionCells(classes: readonly string[] | null): void {
    this.cellClasses = classes?.length ? classes : null;
    this.cells3d.setClasses(this.cellClasses ? new Set(this.cellClasses) : null);
    this.cellStyleKey = null;
    const latest = this.session.latest;
    if (latest?.[0]) void this.styleCells(latest[0], latest[1], latest[2]);
  }

  /**
   * The cells' colours (the panel's Cell Color, its selection muting), which are shown (its groups
   * switched off and gene filter hide theirs; the Cells switch all), and their opacity.
   */
  private async styleCells(
    dataset: SpatialDataset,
    view: SpatialViewState,
    selection: SpatialSelectionMask,
  ): Promise<void> {
    this.cells3d.setDataset(dataset);
    const port = this.session.port;
    if (!this.cellClasses || !port || !this.cellLookup) return;
    const key =
      JSON.stringify([
        dataset.id,
        view.cellColorMode,
        view.cellColorGene,
        view.cellSingleColor,
        view.cellTypeColumn,
        view.logScale,
        view.percentileClip,
        view.continuousColormap,
        view.groupColors,
        view.hiddenGroups,
        view.showCells,
        view.cellOpacity,
        geneFilterKey(view),
        this.ctx.display.continuousColormapKey(view),
      ]) + `|${selection.count}|${this.cellSelectionRev(selection)}`;
    if (key === this.cellStyleKey) return;
    this.cellStyleKey = key;
    const request = ++this.cellStyleRequest;
    const count = dataset.observations.count;
    try {
      const owners = Uint32Array.from({ length: count }, (_, i) => i);
      const [colors, hidden] = await Promise.all([
        cellColorsFor(
          {
            port,
            lookup: this.cellLookup,
            contrastWindows: this.cellWindows,
            continuousLut: (v) => this.ctx.display.spatialLut(v),
          },
          dataset,
          view,
          // Colours as they are: a selection fades what it leaves out (see Spatial3dCells), not grey.
          emptySelection(count),
          owners,
        ),
        this.cellLookup.hiddenCodes(dataset, view),
      ]);
      if (request !== this.cellStyleRequest) return;
      let visible: Uint8Array | null = null;
      if (view.showCells === false) {
        visible = new Uint8Array(count);
      } else if (hidden) {
        visible = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
          const c = hidden.codes[i];
          visible[i] = c !== NO_CATEGORY && hidden.hidden[c] ? 0 : 1;
        }
      }
      this.cells3d.setStyle(
        cellColorsRgba(colors, count),
        visible,
        view.cellOpacity ?? 1,
        selection.count ? selection.mask : null,
      );
    } catch (err) {
      if (request === this.cellStyleRequest) this.cellStyleKey = null;
      console.warn('[napari-js] the 3D cells could not be coloured', err);
    }
  }

  private lastCellSelection: SpatialSelectionMask | null = null;
  private cellSelectionCount = 0;
  private cellSelectionRev(selection: SpatialSelectionMask): number {
    if (selection !== this.lastCellSelection) {
      this.lastCellSelection = selection;
      this.cellSelectionCount++;
    }
    return this.cellSelectionCount;
  }

  /** Show these region reconstructions with the cloud (replacing the ones shown). */
  setRegionMeshes(meshes: readonly RegionMesh3D[]): void {
    this.regionMeshes.set(meshes);
  }

  setRegionHighlight(keys: readonly string[]): void {
    this.regionMeshes.setHighlight(keys);
  }

  setRegionHidden(keys: readonly string[]): void {
    this.regionMeshes.setHidden(keys);
    // A surface's key is its class's name: a hidden class's cells are hidden too.
    this.cells3d.setHiddenClasses(keys);
  }

  /**
   * Where the region set's slices are, in the observations' units (null: they are the plotted
   * stack's slices): its surfaces then sit at their planes among the observations (see
   * placeRegionMeshes), on an image of one plane too.
   */
  setRegionPlanes(z: readonly number[] | null): void {
    const same =
      z === this.regionPlanes ||
      (!!z &&
        !!this.regionPlanes &&
        z.length === this.regionPlanes.length &&
        z.every((v, i) => v === this.regionPlanes?.[i]));
    if (same) return;
    this.regionPlanes = z?.length ? [...z] : null;
    const dataset = this.session.latest?.[0];
    if (dataset) this.placeRegionMeshes(dataset);
  }

  /** As the Volume view: the reference volume hides the surfaces behind what it shows, or none. */
  setRegionsThroughVolume(through: boolean): void {
    this.regionsThrough = through;
    if (this.volume) this.volume.blending = through ? 'translucent_no_depth' : 'translucent';
    this.ctx.viewer.requestRender();
  }

  /**
   * Place the region surfaces in the reference volume's box, as the Volume view places them in its
   * own: image pixel (x, y) is voxel (x, y), slice k is voxel plane k, and the box is the volume's
   * voxels times its voxel size, centred on the origin as napari centres the volume (and the cloud
   * is offset to sit in it). Only when the plotted image IS that volume's stack: regions drawn on
   * another image (a tissue image) have no place in it, and are not shown - nor are surfaces
   * placed in a volume this one replaced.
   *
   * Unless the region set says where its slices are ({@link setRegionPlanes}: a 3D segmentation's
   * planes) and the plotted image is the dataset's own (`imageRef`): image pixels are then taken
   * back to the observations' units through `imageRef`, slice k to its plane's z, and both moved
   * by the offset the cloud is, so each cell's surface sits around its observation.
   */
  private placeRegionMeshes(dataset: SpatialDataset): void {
    // The individual cells sit where the region set's planes are, as its class surfaces do.
    this.cells3d.setPlacement(this.planePlacement(dataset), this.zScale());
    const meta = dataset.volume;
    if (!meta || !this.isVolumeStack(meta)) {
      const planes = this.planePlacement(dataset);
      if (planes) {
        this.regionMeshes.setFrame({
          size: [1, 1, planes.z.length],
          world: [1, 1, 1],
          zScale: this.zScale(),
          planes,
        });
      } else {
        this.regionMeshes.clearFrame();
      }
      return;
    }
    const [vx, vy, vz] = meta.voxelSize;
    this.regionMeshes.setFrame({
      size: [meta.width, meta.height, meta.depth],
      world: [meta.width * vx, meta.height * vy, meta.depth * vz * this.zScale()],
      zScale: this.zScale(),
    });
  }

  /**
   * Image px per voxel of the volume the surfaces sit in: 1, the reference volume being the stack's
   * own voxels, as the Volume view's is at full resolution, so both reconstruct a class alike (and
   * share its cached surface). Null while there is no volume stack to place them in.
   */
  voxelStep(): number | null {
    const dataset = this.session.latest?.[0];
    const meta = dataset?.volume;
    if (this.volume && meta && this.isVolumeStack(meta)) return 1;
    // A region set's planes over the dataset's image: cells a few microns across, so a step that
    // keeps every cell several voxels wide while a class's mask over the tissue stays small.
    if (dataset && this.planePlacement(dataset)) {
      const width = this.info?.trueImageSize?.[0] ?? 0;
      return Math.max(1, width / REGION_PLANES_VOXELS);
    }
    return null;
  }

  /**
   * Where the region set's slices go (see placeRegionMeshes): only with their planes known, on the
   * dataset's own image (one with an `imageRef`, not the reference volume's stack), once the box
   * the cloud is offset into is there.
   */
  private planePlacement(dataset: SpatialDataset): PlanePlacement | null {
    const z = this.regionPlanes;
    const ref = dataset.imageRef;
    if (!z?.length || !ref || !this.info || !this.box) return null;
    const [sx, sy] = ref.scale ?? [1, 1];
    const [tx, ty] = ref.translate ?? [0, 0];
    if (!sx || !sy) return null;
    const [ox, oy, oz] = this.origin;
    return { z, scale: [1 / sx, 1 / sy], offset: [ox - tx / sx, oy - ty / sy, oz] };
  }

  /** Whether the plotted image is the reference volume's stack: its size and slice count. */
  private isVolumeStack(meta: NonNullable<SpatialDataset['volume']>): boolean {
    const info = this.info;
    const [w, h] = info?.trueImageSize ?? [0, 0];
    return !!info?.isStack && w === meta.width && h === meta.height && (info.urls?.length ?? 0) === meta.depth;
  }

  async mount(): Promise<void> {
    // Before the spatial subscription, so the first build already reads the current value.
    this.invertSub = this.ctx.display.watchInvert((invert) => {
      // A live setter: the volumes restyle, nothing is rasterised again.
      for (const layer of this.densityLayers) layer.invert = invert;
      this.ctx.viewer.requestRender();
    });
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

  /** The toolbar's 3D controls, as the Volume view's: drag mode, re-framing and the axes. */
  surface3dControls(): ISurface3dControls | null {
    return surface3dControls(this.ctx, () => this.gizmo);
  }

  /**
   * Stretch Z by `factor` (1 = the data's true proportions), as the Z handle drags it: the cloud
   * through its `scale3d`, each volume through its voxel size, the axes and the region surfaces
   * with them — all about the world origin, which the box is centred on, so they stay aligned.
   * Nothing is re-uploaded. Kept in the settings, so a re-plot keeps it.
   */
  setZScale(factor: number): void {
    const max = this.box ? spatialZScaleMax(this.box) : SPATIAL_Z_SCALE_MAX;
    this.ctx.settings.spatialZScale = Math.min(max, Math.max(SPATIAL_Z_SCALE_MIN, factor));
    this.applyZScale();
  }

  /** The Z stretch in effect: the setting, within what this box allows. */
  zScale(): number {
    const max = this.box ? spatialZScaleMax(this.box) : SPATIAL_Z_SCALE_MAX;
    const s = this.ctx.settings.spatialZScale;
    return Math.min(max, Math.max(SPATIAL_Z_SCALE_MIN, s > 0 ? s : 1));
  }

  private applyZScale(): void {
    const s = this.zScale();
    if (this.points) this.points.scale3d = [1, 1, s];
    this.transcripts3d.setZScale(s);
    for (const layer of [this.volume, this.geneMapLayer, ...this.densityLayers]) {
      const base = layer && this.baseVoxels.get(layer);
      if (layer && base) layer.voxelSize = [base[0], base[1], base[2] * s];
    }
    const dataset = this.session.latest?.[0];
    if (this.gizmo && this.box) {
      const drawn = this.drawnBox(this.box);
      this.gizmo.setDepth(drawn.depth, spatialAxesLabels(drawn, s, dataset?.micronsPerUnit));
    }
    this.zHandle?.reposition();
    if (dataset) this.placeRegionMeshes(dataset);
    this.ctx.viewer.requestRender();
  }

  /** `box` with its Z stretched as drawn. */
  private drawnBox(box: Box3): Box3 {
    return { width: box.width, height: box.height, depth: box.depth * this.zScale() };
  }

  /**
   * Add a volume layer with its Z stretched as the rest of the scene is, remembering its own
   * voxel size so a later stretch can be applied to it.
   */
  private addVolume(
    viewer: Viewer,
    data: Uint8Array,
    width: number,
    height: number,
    depth: number,
    opts: Parameters<Viewer['addVolume']>[4] & { voxelSize: [number, number, number] },
  ): VolumeLayer {
    const [vx, vy, vz] = opts.voxelSize;
    const layer = viewer.addVolume(data, width, height, depth, {
      ...opts,
      voxelSize: [vx, vy, vz * this.zScale()],
    });
    this.baseVoxels.set(layer, [vx, vy, vz]);
    return layer;
  }

  /**
   * Every observation's position on the canvas under the current 3D camera (for the ROI
   * selection), indexed by observation with NaN for anything not drawn. Null before the cloud
   * is built.
   *
   * The projection is the picker's (see {@link picker}); what is left is the part that is
   * genuinely this adapter's: SCATTERING the drawn subset back into observation order. The cloud
   * holds only the points of the displayed section, in its own packing; every consumer indexes by
   * observation. NaN stands for "not on screen", which is also the right answer for an
   * observation whose section is hidden.
   */
  screenProjection(obs: SpatialObservations): Float32Array | null {
    const projected = this.picker?.projected();
    if (!projected) return null;
    const drawn = this.drawn;
    const { screen } = projected;
    const count = screen.length >> 1;
    const out = new Float32Array(obs.count * 2).fill(NaN);
    for (let k = 0; k < count; k++) {
      const i = drawn ? drawn[k] : k;
      if (i >= obs.count) continue;
      out[i * 2] = screen[k * 2];
      out[i * 2 + 1] = screen[k * 2 + 1];
    }
    return out;
  }

  /** The region surface (a class) under a client position, or null. */
  override pickRegion(clientX: number, clientY: number): { key: string; label?: string } | null {
    const rect = this.ctx.canvas.getBoundingClientRect();
    const mesh = this.regionMeshes.pickAt(clientX - rect.left, clientY - rect.top);
    return mesh ? { key: mesh.key, ...(mesh.label ? { label: mesh.label } : {}) } : null;
  }

  /**
   * With a selection, grey out the class surfaces none of it is in (a class is a category of the
   * cell-type column: a 3D segmentation's cell type), as the observations it leaves out are muted.
   */
  private async muteRegions(
    dataset: SpatialDataset,
    view: SpatialViewState,
    selection: SpatialSelectionMask,
  ): Promise<void> {
    const request = ++this.muteRequest;
    if (!selection.count || !this.cellLookup) {
      this.regionMeshes.setMuted([]);
      return;
    }
    const name = cellTypeColumnFor(dataset, view);
    const col = name ? await this.cellLookup.codes(name).catch(() => null) : null;
    if (request !== this.muteRequest) return;
    if (!col || col.meta.kind !== 'categorical') {
      this.regionMeshes.setMuted([]);
      return;
    }
    const selected = new Set<number>();
    for (let i = 0; i < selection.mask.length; i++) if (selection.mask[i]) selected.add(col.codes[i]);
    const categories = col.meta.categories;
    const keys = this.regionMeshes.shown.map((m) => m.key);
    this.regionMeshes.setMuted(
      keys.filter((k) => {
        const code = categories.indexOf(k);
        return code >= 0 && !selected.has(code);
      }),
    );
  }
  private muteRequest = 0;

  /** The observation of the individual cell drawn under a client position, or -1. */
  override pickCell(clientX: number, clientY: number): number {
    const rect = this.ctx.canvas.getBoundingClientRect();
    return this.cells3d.pick(clientX - rect.left, clientY - rect.top);
  }

  dispose(): void {
    this.cells3d.dispose();
    this.regionMeshes.clear();
    this.transcripts3d.remove();
    this.disposeSpatial();
    this.invertSub?.unsubscribe();
    this.invertSub = null;
    this.densityLoads.cancel();
    this.geneMapLoads.cancel();
    this.scaleBar?.dispose();
    this.scaleBar = null;
    this.removeAxes();
    // Drop the cached interleaved coordinates too: holding 3.7M x 3 floats after
    // a teardown is ~45MB of retained heap for a scene that no longer exists.
    this.positions = null;
    this.setPicker(null);
  }

  /**
   * The observation under a client position: the FRONT-most marker within `slackPx` of the
   * pointer (ties by distance), as napari-js's {@link PointPicker} picks it. That matters more
   * than it sounds: the renderer depth-tests the billboards, and in a 3.7M-point cloud the cursor
   * covers many of them — picking the one nearest the cursor's centre regularly names a cell that
   * something else is drawn over. The picker also takes each point's radius from the layer's
   * per-point `sizes`, so a selected marker, drawn larger, is as large to the pointer.
   */
  protected pickObservation(clientX: number, clientY: number, slackPx: number): number {
    const rect = this.ctx.canvas.getBoundingClientRect();
    // A cell drawn by itself is what is under the pointer before any marker inside it.
    const cell = this.cells3d.pick(clientX - rect.left, clientY - rect.top);
    if (cell >= 0) return cell;
    const picker = this.picker;
    if (!picker) return -1;
    const k = picker.pick(clientX - rect.left, clientY - rect.top, slackPx);
    if (k < 0) return -1;
    return this.drawn ? this.drawn[k] : k;
  }

  /** Replace the cloud's picker (null: no cloud), releasing the old one's camera listener. */
  private setPicker(points: Points3DLayer | null): void {
    this.picker?.dispose();
    this.picker = points
      ? new PointPicker(this.ctx.viewer, points, {
          // The largest radius a pick here can claim: the hover slack times the scale a SELECTED
          // marker is drawn at. It decides whether a marker straddling the canvas edge is found.
          maxReach: HOVER_RADIUS_PX * SPATIAL_SELECTED_SIZE_SCALE,
        })
      : null;
  }

  /**
   * Scale bar for the cloud, measured at the ORBIT PIVOT.
   *
   * A perspective camera has no single scale — things farther away are smaller — so a bar can
   * only be true at one depth. The pivot is the honest choice: it is what the camera is framing,
   * what a zoom moves towards, and where the eye is anyway. napari's own 3D scale bar works the
   * same way.
   *
   * napari-js's `ScaleBarOverlay` in `'3d'` mode measures there: CSS px per world unit is the
   * reciprocal of `Camera3D.worldPerPixel` — the scale `Camera3D.pan` uses to track the cursor.
   * The bar then converts through `micronsPerUnit`, and draws nothing at all when the dataset does
   * not declare one, because a bar labelled in microns over unknown units would read as a
   * measurement.
   */
  private installScaleBar(dataset: SpatialDataset | null): void {
    this.scaleBar?.dispose();
    this.scaleBar = null;
    const micronsPerUnit = dataset?.micronsPerUnit;
    if (!micronsPerUnit || micronsPerUnit <= 0) return;
    this.scaleBar = new ScaleBarOverlay(this.ctx.host, this.ctx.viewer, {
      unitPerWorld: micronsPerUnit,
      mode: '3d',
    });
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
    let geneShown: Uint8Array | null = null;
    if (dataset) {
      const endLoading = this.ctx.badge.begin('Observations');
      const port = this.session.port;
      try {
        // Which observations the gene filter keeps, settled apart from their colours: a colour
        // can fall back to a flat one, the filter cannot. Drawn without it, every observation
        // would show as if it expressed the picked genes. So a failed read keeps the cloud as it
        // was drawn, and the panel says the filter could not be applied.
        try {
          geneShown = port
            ? await observationGeneMask(view, dataset.observations.count, (g) => port.getFeatureVector(g))
            : null;
        } catch (err) {
          console.warn(
            '[napari-js] spatial 3D gene filter could not be applied — keeping the cloud as drawn',
            err,
          );
          if (task()) this.session.reportGeneFilter(true);
          return;
        }
        enc = await this.scalarEncoding(view, dataset.observations.count).catch((err) => {
          console.warn('[napari-js] spatial 3D colouring failed — falling back to a flat colour', err);
          return null;
        });
      } finally {
        endLoading();
      }
    }
    if (!task()) return;
    this.session.reportGeneFilter(false);

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
    // The box everything sits in, before any position is computed from its centring offset.
    this.ensureFrame(dataset);
    // Then the cluster density volumes.
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
    this.drawCloud(viewer, dataset, view, selection, enc, geneShown);
    void this.styleCells(dataset, view, selection);
    void this.muteRegions(dataset, view, selection);
    // The transcripts last: they sit in the box the cloud fixed, and their first read can take a while.
    await this.transcripts3d.sync(dataset, view, this.session.port, {
      origin: this.origin,
      zScale: this.zScale(),
    });
  }

  /**
   * Draw the point cloud: a new layer for new geometry (a dataset or a section), the colour
   * source swapped in place otherwise; then the selection and the visibility.
   */
  private drawCloud(
    viewer: Viewer,
    dataset: SpatialDataset,
    view: SpatialViewState,
    selection: SpatialSelectionMask,
    enc: Spatial3dEncoding | null,
    geneShown: Uint8Array | null = null,
  ): void {
    const obs = dataset.observations;
    const scale = view.pointScale > 0 ? view.pointScale : 1;
    const size = SPATIAL_3D_BASE_SIZE * scale;
    // A categorical colouring is per-point RGBA, which wins over the scalars; the flat colormap
    // and zero scalars stand behind it, as they do for "nothing to colour by".
    const scalar = enc?.kind === 'scalars' ? enc : null;
    const colors = enc?.kind === 'colors' ? enc.colors : null;
    const scalars = scalar?.values ?? new Float32Array(obs.count);
    const colormap = scalar?.colormap ?? spatialFlatColormap();
    const contrastLimits: [number, number] = scalar?.contrastLimits ?? [0, 1];
    const { shown, key, scalarKey } = cloudSubset(dataset, view, geneShown);

    if (key !== this.layerKey) {
      // New geometry: interleave x,y,z (the layer's documented layout, x-fastest)
      // and cache it, so later colour changes rebuild the layer without walking
      // the observations again.
      this.positions = this.cloudPositions(obs, shown);
      this.drawn = shown;
    }

    // The scalars have to follow the geometry: a per-observation vector against one
    // section's positions would colour each cell by a stranger's value. So do the colours.
    const valuesFor = () => (shown ? Float32Array.from(shown, (i) => scalars[i]) : scalars);
    const colorsFor = () => (colors ? (gatherColors(colors, shown ?? undefined) as Float32Array) : null);

    if (!this.points || key !== this.layerKey) {
      // New GEOMETRY — a different dataset, or a different section — so a new layer.
      if (this.points) viewer.layers.remove(this.points);
      this.layerKey = key;
      this.scalarKey = scalarKey;
      this.points = viewer.addPoints3D(this.positions!, valuesFor(), {
        name: 'observations',
        scale3d: [1, 1, this.zScale()],
        colormap,
        contrastLimits,
        size,
        colors: colorsFor() ?? undefined,
      });
      this.setPicker(this.points);
    } else {
      if (scalarKey !== this.scalarKey) {
        // A change of colour SOURCE, which used to mean discarding the layer and building
        // another — and, because adding a 3D layer reframes, a camera jump to undo as well.
        // napari-js ≥ 0.14 lets the scalars be replaced in place — the setter bumps the
        // layer's dataVersion so the visual re-uploads — and the positions have not moved,
        // so there is nothing for the camera to reframe.
        this.scalarKey = scalarKey;
        this.points.values = valuesFor();
        this.points.colors = colorsFor();
      }
      this.points.colormap = colormap;
      this.points.contrastLimits = contrastLimits;
      this.points.size = size;
    }

    const cloud = this.points;
    if (cloud) {
      cloud.opacity = view.opacity;
      this.applySelection(cloud, selection, shown, obs.count);
    }
    // Last, so it also covers a layer this pass just created.
    if (this.points) this.points.visible = view.showPoints;
    viewer.requestRender();
  }

  /** Interleaved x,y,z of the `shown` observations (null: all of them), offset by {@link origin}. */
  private cloudPositions(obs: SpatialObservations, shown: Uint32Array | null): Float32Array {
    // rebuild() draws only a dataset whose observations have a z.
    const z = obs.z!;
    const [ox, oy, oz] = this.origin;
    const count = shown ? shown.length : obs.count;
    const positions = new Float32Array(count * 3);
    for (let k = 0; k < count; k++) {
      const i = shown ? shown[k] : k;
      positions[k * 3] = obs.x[i] + ox;
      positions[k * 3 + 1] = obs.y[i] + oy;
      positions[k * 3 + 2] = z[i] + oz;
    }
    return positions;
  }

  /**
   * Selection is a PER-POINT alpha, in the one layer.
   *
   * It used to be a second layer: with a single opacity for the whole cloud, the only way
   * to highlight a subset was to draw it again on top at full opacity while the parent
   * dropped to the muted level. That second layer had to be kept in step through every
   * colormap, window and size change, and the two then depth-sorted against each other as
   * separate draws. Per-point alphas and sizes give the same reading — muted cloud, bright
   * selection, slightly larger so a small one is findable inside 3.7M points — in one.
   *
   * `shown` is the drawn subset (null: every one of the `total` observations), so the alphas
   * follow the drawn order.
   */
  private applySelection(
    cloud: Points3DLayer,
    selection: SpatialSelectionMask,
    shown: Uint32Array | null,
    total: number,
  ): void {
    if (selection.count === 0 || selection.mask.length !== total) {
      cloud.alphas = null;
      cloud.sizes = null;
      return;
    }
    const shownCount = shown ? shown.length : total;
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
    this.geneMapLayer = this.addVolume(viewer, data, field.width, field.height, field.depth, {
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
      ? [
          dataset.id,
          column ?? 'all',
          smoothing,
          this.session.selectionRev(selection),
          groupColorsKey(column, view.groupColors),
        ].join('|')
      : null;
    if (key === this.densityKey) return;

    for (const layer of this.densityLayers) viewer.layers.remove(layer);
    this.densityLayers = [];
    this.densityKey = key;
    const load = this.densityLoads.next();
    if (!key) return;

    // The density box is the scene's box (ensureFrame), so the cloud already sits in it.
    const grid = densityGrid(dataset);
    if (!grid) return;

    let groups: DensityGroup[];
    try {
      groups = await this.densityGroups(dataset, column, selection, view);
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
        this.addVolume(viewer, data, grid.width, grid.height, grid.depth, {
          name: `density · ${group.name}`,
          colormap: this.ctx.display.channelTintColormap(group.color),
          invert: this.ctx.display.invert,
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
    view: SpatialViewState,
  ): Promise<DensityGroup[]> {
    const port = this.session.port;
    const meta = column ? findColumnMeta(dataset, column) : undefined;
    if (!port || !column || !meta || meta.kind !== 'categorical') return [totalDensityGroup(selection)];
    const loaded = await port.getColumn(column);
    if (!isCategoricalColumn(loaded)) return [];
    return rankDensityGroups(column, loaded, dataset.observations.count, selection, view.groupColors);
  }

  /**
   * Add (or keep) the dataset's reference volume. The offset that sits the observations inside
   * it is {@link ensureFrame}'s.
   *
   * A failed or absent volume is not fatal: the cloud renders on its own, in the same box, and
   * the camera frames the points instead.
   */
  private async ensureVolume(viewer: Viewer, dataset: SpatialDataset, view: SpatialViewState): Promise<void> {
    const meta = dataset.volume;
    const port = this.session.port;
    const key = meta ? `${dataset.id}:${meta.width}x${meta.height}x${meta.depth}` : null;
    if (key && key === this.volumeKey) return;
    // Already on its way for an earlier rebuild: wait for that one, add none of our own.
    if (key && this.volumeLoading?.key === key) return this.volumeLoading.done;
    this.volumeLoading = null;

    if (this.volume) {
      viewer.layers.remove(this.volume);
      this.volume = null;
      this.volumeKey = null;
    }
    // The surfaces sat in the volume just removed (or there was none): down until one is placed.
    this.regionMeshes.clearFrame();
    if (!meta || !port?.getVolume || !key) return;
    const loading = { key, done: this.loadVolume(viewer, dataset, view, key) };
    this.volumeLoading = loading;
    try {
      await loading.done;
    } finally {
      if (this.volumeLoading === loading) this.volumeLoading = null;
    }
  }

  /** Fetch the reference volume and add it, unless another one was asked for meanwhile. */
  private async loadVolume(
    viewer: Viewer,
    dataset: SpatialDataset,
    view: SpatialViewState,
    key: string,
  ): Promise<void> {
    const meta = dataset.volume!;
    let voxels: Uint8Array;
    try {
      voxels = await this.session.port!.getVolume!();
    } catch (err) {
      console.warn('[napari-js] reference volume unavailable — drawing the cloud alone', err);
      return;
    }
    if (this.ctx.signal.aborted || this.volumeLoading?.key !== key) return;

    const [vx, vy, vz] = meta.voxelSize;
    this.volumeKey = key;
    this.volume = this.addVolume(viewer, voxels, meta.width, meta.height, meta.depth, {
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
    if (this.regionsThrough) this.volume.blending = 'translucent_no_depth';
    this.placeRegionMeshes(dataset);
  }

  /**
   * The box everything sits in, centred on the world origin, and the offset that sits the
   * observations in it; with the axes gizmo and the Z handle on it.
   *
   * `VolumeLayer` has no translate: napari-js maps a volume's unit cube to a world box centred on
   * the origin, sized `dims x voxelSize`. The observations, by contract, are in the reference
   * volume's frame with its near corner at the coordinate origin, and the density grid is measured
   * from the coordinate origin the same way (`densityGrid`), so its box is the reference volume's
   * when there is one. So the POINTS move by half that box — {@link origin} — and every volume, the
   * reference, the densities and the gene map, lines up with them and with each other. Without a
   * reference volume this centres the cloud too, which the axes and the Z stretch need: both work
   * about the origin.
   */
  private ensureFrame(dataset: SpatialDataset): void {
    const meta = dataset.volume;
    const key = `${dataset.id}:${dataset.observations.count}:${meta ? `${meta.width}x${meta.height}x${meta.depth}` : '-'}`;
    if (key === this.boxKey) return;
    this.boxKey = key;
    const grid = densityGrid(dataset);
    this.box = grid
      ? {
          width: grid.width * grid.voxelSize[0],
          height: grid.height * grid.voxelSize[1],
          depth: grid.depth * grid.voxelSize[2],
        }
      : null;
    const box = this.box;
    this.origin = box ? [-box.width / 2, -box.height / 2, -box.depth / 2] : [0, 0, 0];
    // Force a geometry rebuild: the offset changed, so cached positions are stale.
    this.layerKey = null;
    this.installAxes(dataset);
    // A stretch chosen for another box may be past what this one allows: draw what is in effect.
    this.applyZScale();
  }

  /**
   * The Volume view's axes gizmo and Z-height handle, on {@link box}. The handle floats past the
   * top of the Z axis (the box's min-XY corner, where the blue axis and its label are), by a share
   * of the box's largest side rather than of its depth, so it clears the label even while a thin
   * section is drawn flat.
   */
  private installAxes(dataset: SpatialDataset): void {
    this.removeAxes();
    const box = this.box;
    if (!box) return;
    const { viewer, host, settings } = this.ctx;
    const drawn = this.drawnBox(box);
    this.gizmo = new Axes3dGizmo(
      viewer,
      host,
      drawn,
      spatialAxesLabels(drawn, this.zScale(), dataset.micronsPerUnit),
      {
        visible: settings.axesVisible,
      },
    );
    const maxScale = spatialZScaleMax(box);
    this.zHandle = new NapariVolumeZHandle(host, viewer.camera3d, {
      topAnchor: () => {
        const d = this.drawnBox(box);
        return [-d.width / 2, -d.height / 2, d.depth / 2 + 0.08 * Math.max(d.width, d.height, d.depth)];
      },
      getScale: () => this.zScale(),
      setScale: (s) => this.setZScale(s),
      minScale: SPATIAL_Z_SCALE_MIN,
      maxScale,
      pixelsPerDouble: spatialZPixelsPerDouble(maxScale),
    });
  }

  private removeAxes(): void {
    if (this.gizmo) {
      this.ctx.viewer.layers.remove(this.gizmo.layer);
      this.gizmo.destroy();
      this.gizmo = null;
    }
    this.zHandle?.destroy();
    this.zHandle = null;
  }

  /** Drop every layer of the cloud (the dataset went away, or has no z). */
  private removeLayers(viewer: Viewer): void {
    this.regionMeshes.clearFrame();
    this.transcripts3d.remove();
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
    this.box = null;
    this.boxKey = null;
    this.removeAxes();
    this.points = null;
    this.setPicker(null);
    this.layerKey = null;
    this.scalarKey = null;
    this.positions = null;
    this.drawn = null;
  }

  /**
   * What colours the cloud.
   *
   * Continuous data goes through the active colormap with the same percentile window the 2D path
   * uses. Categorical data is one RGBA per point from the column's palette, so any number of
   * categories keeps its own colour — see `encodeSpatial3dCategorical`.
   */
  private async scalarEncoding(view: SpatialViewState, count: number): Promise<Spatial3dEncoding | null> {
    const port = this.session.port;
    // Coloured by the gene filter: each observation in its gene's colour.
    // A colour like any other: a failed read falls back to the view's colour source.
    const byGene =
      port && count
        ? await observationGeneStyle(view, count, (g) => port.getFeatureVector(g)).catch((err) => {
            console.warn(
              '[napari-js] spatial 3D colouring by gene failed — falling back to the colour source',
              err,
            );
            return null;
          })
        : null;
    if (byGene) return encodeSpatial3dCategorical(byGene.codes, byGene.colors);
    const colorBy = view.colorBy;
    if (!port || !colorBy) return null;

    if (colorBy.kind === 'column') {
      const column: SpatialColumn = await port.getColumn(colorBy.name);
      if (isCategoricalColumn(column)) {
        return encodeSpatial3dCategorical(
          column.codes,
          categoryColorsFor(colorBy.name, column.meta, view.groupColors),
        );
      }
      return this.encodeContinuous(column.values, view);
    }
    return this.encodeContinuous(await port.getFeatureVector(colorBy.name), view);
  }

  /** Continuous values → the active colormap over a percentile-clipped window. */
  encodeContinuous(source: Float32Array, view: SpatialViewState): Spatial3dScalars {
    return encodeSpatial3dContinuous(
      source,
      view,
      this.ctx.display.spatialLut(view),
      this.session.contrastWindows,
    );
  }
}

/**
 * The observations the cloud draws, and the keys of its geometry and of its colour source.
 *
 * One imaged section, or the whole stack (`shown` null). The subset IS the geometry, so it
 * belongs in the geometry key rather than being re-derived per frame — and an out-of-range
 * index is clamped rather than dropping the cloud, because the section count changes with the
 * dataset while the view state persists. The scalars' identity is tracked separately from the
 * geometry's (`colorBy` plus the transforms feeding the encoding): a new colour source swaps
 * `values` in place (napari-js ≥ 0.14), while a new geometry needs a new layer.
 */
function cloudSubset(
  dataset: SpatialDataset,
  view: SpatialViewState,
  geneShown: Uint8Array | null = null,
): { shown: Uint32Array | null; key: string; scalarKey: string } {
  const obs = dataset.observations;
  const sections = sectionsOf(obs);
  const section =
    view.pointSection != null && sections && sections.length > 0
      ? sections[Math.max(0, Math.min(sections.length - 1, view.pointSection))]
      : null;
  let shown = section != null ? observationsInSection(obs, section) : null;
  // The gene filter leaves its unmatched observations out of the geometry, so they are neither
  // drawn nor picked.
  if (geneShown) shown = keepShown(shown, geneShown, obs.count);
  const key = `${dataset.id}:${obs.count}:${section ?? 'all'}:${geneShown ? geneFilterKey(view) : ''}`;
  const clip = view.percentileClip ?? [0.01, 0.99];
  const scalarKey = [
    key,
    view.colorBy ? `${view.colorBy.kind}:${view.colorBy.name}` : 'flat',
    groupColorsKey(view.colorBy?.kind === 'column' ? view.colorBy.name : null, view.groupColors),
    observationGeneStyleKey(view),
    view.logScale ? 'log' : 'lin',
    clip.join(','),
  ].join('|');
  return { shown, key, scalarKey };
}

/** The observations of `indices` (every one when null) that `shown` keeps. */
function keepShown(indices: Uint32Array | null, shown: Uint8Array, count: number): Uint32Array {
  const out = new Uint32Array(indices ? indices.length : count);
  let n = 0;
  if (indices) {
    for (const i of indices) if (shown[i]) out[n++] = i;
  } else {
    for (let i = 0; i < count; i++) if (shown[i]) out[n++] = i;
  }
  return out.subarray(0, n);
}
