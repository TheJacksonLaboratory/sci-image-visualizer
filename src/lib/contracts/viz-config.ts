import { InjectionToken } from '@angular/core';

/**
 * Static configuration the visualization library needs from the host, supplied
 * via DI so the library never imports the app's `environment`.
 */
export interface VizConfig {
  /** Base URL of the tile/crop server (`/tile`, `/tiles/info`, zoom). */
  slideCropServer: string;
  /**
   * Optional CSS selector for a host element whose current width the Region
   * Editor dialog should match when it first opens (e.g. the app's right
   * panel). Measured once per open — it does not track later resizes. When
   * absent or the element isn't found, the dialog falls back to a quarter of
   * the page width (25vw).
   */
  regionEditorWidthSelector?: string;
  /**
   * Opt in to the experimental WebGPU **napari-js** backend for the IMAGE plot type
   * (jit-ui#102). When `true`, the router renders images through napari-js with OpenSeadragon
   * as the fallback; when absent/false, OpenSeadragon remains the default. Other plot types
   * are unaffected.
   */
  useNapariRenderer?: boolean;
}

export const VIZ_CONFIG = new InjectionToken<VizConfig>('VIZ_CONFIG');
