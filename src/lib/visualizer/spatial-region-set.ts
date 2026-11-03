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
 * Whether `info` is the dataset's own image, the one its `imageRef` names (the host opens it by
 * that id, a path whose last part is the file's name). Not the reference volume's stack, which a
 * dataset without an `imageRef` is drawn over: the region set's coordinates are not its pixels.
 */
export function isDatasetImage(
  info: IImageInfo | null | undefined,
  dataset: SpatialDataset | null | undefined,
): boolean {
  const id = dataset?.imageRef?.imageId;
  const name = info?.fileName;
  if (!id || !name) return false;
  return id === name || id.slice(id.lastIndexOf('/') + 1) === name;
}

/**
 * Attaches a spatial dataset's region set to its image in the region editor, once both are there:
 * the dataset (the port's) and its image, landed. Each time either changes it asks again; the
 * target attaches once per image and set.
 */
export class SpatialRegionSetLink {
  private dataset: SpatialDataset | null = null;
  private image: IImageInfo | null = null;

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
    this.sync();
  }

  private sync(): void {
    const port = this.port;
    const id = datasetRegionSet(this.dataset);
    if (!id || !port?.openRegionSet || !isDatasetImage(this.image, this.dataset)) return;
    void this.target.attachDatasetRegionSet?.(() => port.openRegionSet!(id), id);
  }
}
