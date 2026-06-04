import { InjectionToken } from '@angular/core';

/**
 * Static configuration the visualization library needs from the host, supplied
 * via DI so the library never imports the app's `environment`.
 */
export interface VizConfig {
  /** Use OpenSeadragon for the Image plot type (kill switch; default true). */
  useOsdForImage: boolean;
  /** Base URL of the tile/crop server (`/tile`, `/tiles/info`, zoom). */
  slideCropServer: string;
}

export const VIZ_CONFIG = new InjectionToken<VizConfig>('VIZ_CONFIG');
