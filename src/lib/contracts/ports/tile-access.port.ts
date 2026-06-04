import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { Rectangle } from '../../models/region';

/**
 * File/tile/zoom backend, inverted as a port so the visualization library doesn't
 * import the app's `FilesService` (nor its `ZoomRequest`/`DisplayType` request
 * models). The host supplies an adapter that builds the concrete request from
 * these library-native arguments and the currently-selected file.
 */
export interface TileAccessPort {
  /** Base64-encoded info for the currently-selected file (used for `/tile` and
   *  `/tiles/info` requests), or null when nothing is selected. Collapses the
   *  host's `getSelectedFileInfo()` + `encode(rawData)`. */
  getSelectedInfoB64(): string | null;

  /** Server-side crop/zoom of the current image to `roi`; resolves to raw image
   *  bytes. `screen` is the on-screen diagram rectangle. The host builds the
   *  request (including the selected file) internally. */
  zoomOnRegion(roi: Rectangle, screen: Rectangle, zIndex: number): Observable<ArrayBuffer>;

  /** Switch the host's display back to the diagram view (replaces the app's
   *  `selectDisplayType(DisplayType.Diagram)`). */
  selectDiagramDisplay(): void;

  /** Auth headers (e.g. `Authorization: Bearer …`) for OSD's own tile fetches
   *  (its AJAX loader + prefetch bypass Angular's HttpClient interceptor, so the
   *  host supplies them). Hides the app's Auth0 dependency from the library. */
  getAuthHeaders(): Promise<Record<string, string>>;
}

export const TILE_ACCESS_PORT = new InjectionToken<TileAccessPort>('TILE_ACCESS_PORT');
