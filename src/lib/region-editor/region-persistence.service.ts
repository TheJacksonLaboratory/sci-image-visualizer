import { Inject, Injectable } from '@angular/core';
import { saveAs } from 'file-saver';
import { Observable, Subscription, of } from 'rxjs';
import { catchError, debounceTime, switchMap } from 'rxjs/operators';

import { Region } from '../models/region';
import { withRegionZ } from '../models/region-clone';
import { IRegionEditorApi, REGION_EDITOR_API } from '../contracts/region-editor-api.contract';
import { REGION_IO_PORT, RegionIoPort } from '../contracts/ports/region-io.port';
import { fileStem } from './file-stem';

/** One slice-file's serialized regions (folder stack, jit-ui#93). */
export interface SliceGeoJson {
  z: number;
  geoJsonStr: string;
}

/**
 * Region file I/O for the Region Editor: default file names, GeoJSON download
 * (export), save to the host through {@link RegionIoPort} (with a debounced
 * "file exists" check), per-slice saves for folder stacks, and reading an
 * imported file. Provided by the editor; it holds no state — the editor owns
 * the dialogs, the toasts and the running jobs.
 */
@Injectable()
export class RegionPersistenceService {
  constructor(
    @Inject(REGION_EDITOR_API) private readonly api: IRegionEditorApi,
    @Inject(REGION_IO_PORT) private readonly io: RegionIoPort,
  ) {}

  /** The selected image's file name, if any. */
  selectedFileName(): string | undefined {
    return this.io.getSelectedFileName();
  }

  /** `<image-stem>.geojson` for a server save; undefined with no image selected. */
  defaultSaveName(): string | undefined {
    const name = this.io.getSelectedFileName();
    return name ? `${fileStem(name, name)}.geojson` : undefined;
  }

  /** `<image-stem>.geojson` (or `rois.geojson`) for a download. */
  defaultExportName(): string {
    return `${fileStem(this.io.getSelectedFileName(), 'rois')}.geojson`;
  }

  /** `<image-stem>_mask.png` (or `regions_mask.png`) for a mask download. */
  defaultMaskName(): string {
    return `${fileStem(this.io.getSelectedFileName(), 'regions')}_mask.png`;
  }

  /** True when a save writes one geojson per slice-file (folder stack, jit-ui#93). */
  savesPerSlice(): boolean {
    return this.api.isStackMode() && this.api.getStackSaveLayout() === 'per-slice-file';
  }

  /**
   * Regions to serialize on save/export. For a single-file z-stack the store
   * keeps only the current slice live, so take EVERY slice's annotations (each
   * tagged with its zero-based Region.z) for one combined z-indexed geojson
   * (jit-ui#93); otherwise `live` (single plane, or a folder stack whose slices
   * save to their own files).
   */
  regionsForSave(live: Region[]): Region[] {
    if (this.api.isStackMode() && this.api.getStackSaveLayout() === 'combined') {
      return this.api.getSliceAnnotationRegions();
    }
    return live;
  }

  /**
   * Whether each file name in `names` already exists on the host, debounced
   * 400 ms; a newer name supersedes an in-flight check. A failed check reads as
   * "does not exist" and later checks keep working.
   */
  fileExists(names: Observable<string>): Observable<boolean> {
    return names.pipe(
      debounceTime(400),
      switchMap((name) => this.io.roiFileExists(name).pipe(catchError(() => of(false)))),
    );
  }

  /** Download `regions` as a GeoJSON file named `filename`. */
  download(regions: Region[], filename: string): void {
    const blob = new Blob([this.api.getGeoJsonString(regions)], { type: 'application/json' });
    saveAs(blob, filename);
  }

  /**
   * Save `regions()` to the host as `filename`. Serializing is deferred one
   * tick (so a progress indicator paints before a large synchronous
   * serialize); unsubscribing before then cancels the save entirely, and after
   * it cancels the upload. A serialize failure is an error, like an upload one.
   */
  save(regions: () => Region[], filename: string): Observable<void> {
    return new Observable<void>((subscriber) => {
      let upload: Subscription | undefined;
      const timer = setTimeout(() => {
        let geoJsonStr: string;
        try {
          geoJsonStr = this.api.getGeoJsonString(regions());
        } catch (err) {
          subscriber.error(err);
          return;
        }
        upload = this.io.saveGeoJson(geoJsonStr, filename).subscribe(subscriber);
      });
      return () => {
        clearTimeout(timer);
        upload?.unsubscribe();
      };
    });
  }

  /**
   * A folder stack's regions as one geojson per slice-file (jit-ui#93), each
   * serialized on the default plane (z=0): every slice-file is one plane, and
   * the loader re-derives the slice index from the file's position. Slices
   * cleared since load are included (empty) so their file is overwritten.
   */
  sliceGeoJsons(): SliceGeoJson[] {
    const out: SliceGeoJson[] = [];
    for (const [z, regs] of this.api.getStackSaveAnnotationSlices()) {
      out.push({ z, geoJsonStr: this.api.getGeoJsonString(regs.map((r) => withRegionZ(r, 0))) });
    }
    return out;
  }

  /** Write per-slice geojsons through the host port. */
  saveSlices(slices: SliceGeoJson[]): Observable<void> {
    return this.io.saveSliceGeoJsons(slices);
  }

  /** Read the file chosen in a file input's change event as text, then call
   *  `onText`. No-op when no file was chosen. */
  readChosenFile(event: Event, onText: (text: string) => void): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onText(reader.result as string);
    reader.readAsText(file);
  }
}
