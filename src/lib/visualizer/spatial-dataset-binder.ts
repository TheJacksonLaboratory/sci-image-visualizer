import { Observable } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { IImageInfo } from '../contracts/image.contract';
import { PlotType, PlotTypeId, isSpatialOmics3d } from '../contracts/plot-type';
import { SpatialDataPort } from '../contracts/ports/spatial-data.port';
import { SpatialDataset } from '../contracts/spatial-dataset.contract';
import { SpatialGates } from '../plot-mode/plot-type-menu';
import { buildVolumeStackImage } from '../spatial/spatial-volume-image';

/** What a dataset switch asks of the viewer. */
export interface SpatialBinderHost {
  /** The plot-type gates changed: recompute the selector. */
  gatesChanged(): void;
  /** The selector's current id, and the built-in type rendered for it. */
  selectedId(): PlotTypeId;
  basePlotType(): PlotType;
  /** Whether an image is loaded. */
  hasImage(): boolean;
  selectPlotType(type: PlotType): void;
  /** Re-plot the current mode. */
  replot(): void;
  /** Publish an image as the host's current one. */
  publishImage(info: IImageInfo): void;
  setImageLoading(loading: boolean): void;
  /** The switch is handled: reconcile the selection with the new gates and re-render. */
  settled(): void;
  detectChanges(): void;
}

/**
 * Binds the viewer to the spatial-omics dataset on `SPATIAL_DATA_PORT`: the gates it
 * puts on the plot-type selector ({@link gates}), the mode an image-less dataset opens
 * on, and publishing a dataset's registered volume AS the image.
 *
 * No-op when the host provides no port — the spatial types then stay hidden.
 */
export class SpatialDatasetBinder implements SpatialGates {
  /** The dataset on offer, for drawing one that brings no image. */
  dataset: SpatialDataset | null = null;
  /** A dataset is published — gates the spatial plot types; the toolbar binds it too. */
  hasDataset = false;
  /** Its observations carry a z, gating the 3D spatial mode. */
  has3d = false;
  /** It brings pixels of its own (see {@link SpatialGates.hasPixels}). */
  hasPixels = false;
  /** Dataset identity + capability shape the last emission was handled at, so a
   *  switch between two datasets of the same shape is not mistaken for a repeat. */
  private key: string | null = null;
  /** Dataset + geometry the published volume image was built from, so a re-emitted
   *  dataset doesn't re-fetch megabytes or reset the user's scrub. */
  private volumeImageKey: string | null = null;
  /** Blob URLs backing that image — ours to revoke. */
  private volumeImageUrls: string[] = [];

  constructor(private readonly port: SpatialDataPort | undefined, private readonly host: SpatialBinderHost) {}

  /** Follow the port's dataset until `until$` emits. */
  bind(until$: Observable<unknown>): void {
    this.port?.getDataset$().pipe(takeUntil(until$)).subscribe((dataset) => this.onDataset(dataset ?? null));
  }

  /** Revoke the published volume image's blob URLs (teardown). */
  dispose(): void {
    this.revokeVolumeImageUrls();
  }

  private onDataset(dataset: SpatialDataset | null): void {
    this.dataset = dataset;
    // Only a dataset whose observations carry a z can be drawn as a cloud, so the 3D
    // mode is gated on the coordinates, not merely on a dataset being present.
    const has3d = !!dataset?.observations.z;
    const hasVolume = !!dataset?.volume;
    // The port publishes its current value on subscribe, so the initial `null` would
    // otherwise recompute the selector for no change. Keyed by dataset IDENTITY as well
    // as capability shape: two 3D datasets that both carry a volume have the same
    // shape, and comparing only that skipped the switch — leaving the previous
    // dataset's volume image on screen underneath the new one's observations.
    const key = dataset
      ? `${dataset.id}|${has3d}|${hasVolume}|${dataset.volume
        ? `${dataset.volume.width}x${dataset.volume.height}x${dataset.volume.depth}` : ''}`
      : null;
    if (key === this.key) return;
    this.key = key;
    this.hasDataset = !!dataset;
    this.has3d = has3d;
    // Whether the dataset brings pixels: it registers onto a tissue image (which may
    // still be on its way — the pixel modes must not flicker out while it arrives), or
    // its volume is published AS a grayscale z-stack image. Either way the pixel modes
    // stay on offer — Volume and Isosurface are exactly how a 3D omics dataset is read.
    this.hasPixels = !!dataset?.imageRef || hasVolume;
    this.host.gatesChanged();
    if (dataset && !dataset.imageRef && hasVolume) {
      // No section to draw observations over (a cloud registered into a common frame,
      // the Allen CCF), but a registered VOLUME: make that the image and open on it,
      // slice bar and all. Ordered after the gates so the type is on offer first.
      void this.showVolumeAsImage(dataset);
    } else {
      // Anything else means a published volume image is no longer what is on screen.
      // Forget it, or coming BACK to the volume dataset would short-circuit on a
      // matching key and leave the other dataset's slide up.
      this.dropVolumeImage();
      if (dataset && !dataset.imageRef) {
        // No reference image and no volume: the observations are all there is, so open
        // on whichever spatial mode their coordinates support — leaving the type alone
        // strands the host on the previous slide. A one-plane assay has no z and
        // cannot be a cloud.
        const target = has3d ? PlotType.SPATIAL_OMICS_3D : PlotType.SPATIAL_OMICS;
        if (this.host.selectedId() !== target) this.host.selectPlotType(target);
        // Same mode, another image-less dataset, nothing loaded: re-plot so its
        // placeholder image info (and with it the regions' key) is this dataset's.
        else if (!this.host.hasImage()) this.host.replot();
      }
    }
    // Clearing the dataset while a spatial mode is active leaves a type that is no
    // longer offered — the host falls back, as turning test mode off does.
    this.host.settled();
  }

  /**
   * Publish a dataset's reference volume AS the image, and open the 2D Image view on it:
   * the slice bar scrubs z, and the contrast window, colormaps and region tools all work
   * because the volume genuinely is the image now. The 3D cloud stays one pick away.
   *
   * Keyed by dataset + geometry: the dataset stream re-emits on things like a
   * colour-column change, and rebuilding then would re-fetch the voxels and throw the
   * user back to the middle slice.
   */
  private async showVolumeAsImage(dataset: SpatialDataset): Promise<void> {
    const meta = dataset.volume;
    if (!meta || !this.port?.getVolume) return;
    const key = `${dataset.id}:${meta.width}x${meta.height}x${meta.depth}`;
    if (key === this.volumeImageKey) return;
    // Claim the key BEFORE awaiting: the stream can emit again while the voxels are in
    // flight, and two builds of the same volume would race to publish.
    this.volumeImageKey = key;
    this.host.setImageLoading(true);
    try {
      const built = await buildVolumeStackImage(dataset, await this.port.getVolume());
      // A different dataset was selected while this one encoded: drop what we built.
      if (this.volumeImageKey !== key) {
        built?.urls.forEach((u) => URL.revokeObjectURL(u));
        return;
      }
      if (!built) {
        this.volumeImageKey = null;
        return;
      }
      // Pick the mode first so the image lands in the view that will show it.
      if (this.host.selectedId() !== PlotType.IMAGE) this.host.selectPlotType(PlotType.IMAGE);
      this.revokeVolumeImageUrls();
      this.volumeImageUrls = built.urls;
      this.host.publishImage(built.info);
    } catch (err) {
      // No volume served after all: the cloud is still renderable, so fall back to it.
      console.warn('[visualizer] reference volume unavailable — falling back to the 3D cloud', err);
      this.volumeImageKey = null;
      if (this.has3d && !isSpatialOmics3d(this.host.basePlotType())) {
        this.host.selectPlotType(PlotType.SPATIAL_OMICS_3D);
      }
    } finally {
      // Only the build still on screen (or one that failed and released its key) may
      // drop the overlay: a newer volume build that superseded this one is still encoding.
      if (this.volumeImageKey === key || this.volumeImageKey === null) this.host.setImageLoading(false);
      this.host.detectChanges();
    }
  }

  /** Forget the published volume image so re-selecting the dataset rebuilds it. The
   *  URLs deliberately stay alive: the host may still be displaying that image, and
   *  revoking under it would break every later tile read. They are freed when the next
   *  volume replaces them, or on {@link dispose}. */
  private dropVolumeImage(): void {
    this.volumeImageKey = null;
  }

  private revokeVolumeImageUrls(): void {
    this.volumeImageUrls.forEach((u) => URL.revokeObjectURL(u));
    this.volumeImageUrls = [];
  }
}
