import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';

/**
 * Region file I/O, inverted as a port so the visualization library's region
 * editor doesn't import the app's `FilesService` (the library performs no backend
 * requests itself). The host supplies an adapter that delegates to its file
 * service; the editor only needs the selected file's name (to derive default ROI
 * filenames), an existence check, and a save. Bound to {@link REGION_IO_PORT}.
 */
export interface RegionIoPort {
  /** Name of the currently selected file (e.g. "image.tif"), or undefined when
   *  none is selected. Used to derive a default ROI filename stem. */
  getSelectedFileName(): string | undefined;
  /** Whether an ROI file named `name` already exists for the selected file. */
  roiFileExists(name: string): Observable<boolean>;
  /** Persist the regions (already serialized to a GeoJSON string) as `filename`. */
  saveGeoJson(geoJsonStr: string, filename: string): Observable<void>;
}

export const REGION_IO_PORT = new InjectionToken<RegionIoPort>('REGION_IO_PORT');
