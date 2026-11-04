import { Observable } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { IImageInfo } from '../contracts/image.contract';
import { SpatialDataPort } from '../contracts/ports/spatial-data.port';
import { SpatialDataset } from '../contracts/spatial-dataset.contract';
import type { RegionSourceOpener } from '../store/region-source-scope';

/** What {@link SpatialRegionSetLink} attaches a dataset's region set through (the router). */
export interface DatasetRegionSetTarget {
  attachDatasetRegionSet?(open: RegionSourceOpener, key: string): Promise<boolean>;
}

/**
 * The region set a spatial dataset's boundaries name (a 3D segmentation's cells, see
 * `SpatialPolygonTilesMeta.sets`): the default set's when it names one, else the first that does.
 */
export function datasetRegionSet(dataset: SpatialDataset | null | undefined): string | null {
  const tiles = dataset?.polygonTiles;
  if (!tiles) return null;
  const named = tiles.sets.filter((s) => !!s.regionSource);
  const set = named.find((s) => s.name === tiles.defaultSet) ?? named[0];
  return set?.regionSource ?? null;
}

/**
 * Whether `info` is the dataset's own image, the one its `imageRef` names. Exactly, when the host
 * gives the image's id ({@link IImageInfo.imageId}); otherwise by the file name the id ends in (the
 * host opens the image by that id, a path), which images of other datasets can share: then the link
 * only takes an image that landed after the dataset was selected (see {@link SpatialRegionSetLink}).
 * Not the reference volume's stack, which a dataset without an `imageRef` is drawn over: the region
 * set's coordinates are not its pixels.
 */
export function isDatasetImage(
  info: IImageInfo | null | undefined,
  dataset: SpatialDataset | null | undefined,
): boolean {
  const id = dataset?.imageRef?.imageId;
  if (!id || !info) return false;
  if (info.imageId) return info.imageId === id;
  const name = info.fileName;
  if (!name) return false;
  return id === name || id.slice(id.lastIndexOf('/') + 1) === name;
}

/**
 * Attaches a spatial dataset's region set to its image in the region editor, once both are there:
 * the dataset (the port's) and its image, landed. Each time either changes it asks again; the
 * target attaches once per image and set.
 *
 * An image that landed while another dataset was selected is not taken for this one by its file name,
 * only by its id ({@link IImageInfo.imageId}): a host selects the dataset and then opens its image,
 * and until that lands the image on screen is the previous dataset's, though its file name may be the
 * same (every converted bundle's is `plate.ome.tif`). One that landed with no dataset selected may be.
 */
export class SpatialRegionSetLink {
  private dataset: SpatialDataset | null = null;
  private image: IImageInfo | null = null;
  /** The dataset selected when the image landed (its id), or null: none was. */
  private imageDataset: string | null = null;

  constructor(
    private readonly port: SpatialDataPort | undefined,
    private readonly target: DatasetRegionSetTarget,
  ) {}

  /** Follow the port's dataset until `until$` emits. */
  bind(until$: Observable<unknown>): void {
    this.port
      ?.getDataset$()
      .pipe(takeUntil(until$))
      .subscribe((dataset) => {
        this.dataset = dataset ?? null;
        this.sync();
      });
  }

  /** An image landed (its render settled): the dataset's own, perhaps. */
  imageLanded(info: IImageInfo): void {
    this.image = info;
    this.imageDataset = this.dataset?.id ?? null;
    this.sync();
  }

  /**
   * Whether the landed image may be the dataset's: by its id when the host gives one, else only when
   * it landed under this dataset or under none (see the class's note).
   */
  private imageOf(dataset: SpatialDataset | null): boolean {
    if (!dataset || !isDatasetImage(this.image, dataset)) return false;
    return !!this.image?.imageId || this.imageDataset === null || this.imageDataset === dataset.id;
  }

  private sync(): void {
    const port = this.port;
    const id = datasetRegionSet(this.dataset);
    if (!id || !port?.openRegionSet || !this.imageOf(this.dataset)) return;
    void this.target.attachDatasetRegionSet?.(() => port.openRegionSet!(id), id);
  }
}
