import { Provider } from '@angular/core';

import { RoutingVisualizerService } from './routing-visualizer.service';
import { PlotlyService } from './implementations/plotly/plotly.service';
import { OpenSeadragonVisualizerService } from './implementations/osd/openseadragon-visualizer.service';
import { NapariVisualizerService } from './implementations/napari-js/napari-visualizer.service';
import { VisualizerStore } from './store/visualizer-store.service';
import { RegionStore } from './store/region-store.service';
import { SamToolService } from './toolbar/segmentation/sam-tool.service';
import { SamPointToolService } from './toolbar/segmentation/sam-point-tool.service';
import { CellSegmentToolService } from './toolbar/segmentation/cell-segment-tool.service';
import { SpatialSelectionStore } from './store/spatial-selection.service';
import { IntensityProfileService } from './intensity/intensity-profile.service';
import { VISUALIZER } from './contracts/visualizer.contract';
import { REGION_EDITOR_API } from './contracts/region-editor-api.contract';
import { CHANNEL_HISTOGRAM_API } from './contracts/channel-histogram-api.contract';

/**
 * The three host-facing contracts, all served by the router. Shared by
 * {@link provideVisualization} (component scope) and `VisualizationModule` (root),
 * so both bind them the same way; at each scope they resolve to that scope's router.
 * Package-internal (not exported from the public API).
 */
export const VISUALIZER_TOKEN_BINDINGS: Provider[] = [
  { provide: VISUALIZER, useExisting: RoutingVisualizerService },
  { provide: REGION_EDITOR_API, useExisting: RoutingVisualizerService },
  { provide: CHANNEL_HISTOGRAM_API, useExisting: RoutingVisualizerService },
];

/**
 * A self-contained, isolated visualization backend chain for a component subtree.
 *
 * The chain services are `providedIn: 'root'` singletons, so by default the whole
 * app shares one viewer's state (regions, image, channels, render handles) — which
 * is correct for the single main viewer. A consumer that needs a SECOND, independent
 * viewer (e.g. a modal that mounts `<visualizer>` over the live main view
 * and must not clobber its regions/image) drops this into its component `providers`:
 *
 * ```ts
 * @Component({
 *   ...,
 *   providers: [
 *     ...provideVisualization(),                 // isolated chain instance
 *     // plus the host ports + config for THIS viewer:
 *     { provide: IMAGE_STATE_PORT, useClass: MyImageStateAdapter },
 *     { provide: TILE_ACCESS_PORT, useClass: MyTileAccessAdapter },
 *     { provide: REGION_IO_PORT,   useClass: MyRegionIoAdapter },
 *     { provide: VIZ_CONFIG,       useValue: { slideCropServer: '' } },
 *   ],
 * })
 * ```
 *
 * Component-scoped providers shadow the root singletons for that subtree, so the
 * embedded viewer gets its own router/Plotly/OSD/stores/tools while the rest of the
 * app keeps the default root instance.
 *
 * In an application's own providers (`bootstrapApplication(App, { providers: [
 * provideVisualization(), …] })`) it binds the one app-wide chain instead — the
 * standalone counterpart of importing the deprecated `VisualizationModule`.
 *
 * Lists EVERY stateful service in the chain. Stateless collaborators (HttpClient,
 * MessageService, WandService) deliberately resolve to root — they hold no
 * per-viewer state, so sharing them is correct and keeps this list minimal. The
 * SAM model session (`SamSessionService`) is also root on purpose: every viewer's
 * SAM tools share one model download and Worker/GPU session (see its doc; a host
 * can provide it at a viewer component to get a per-viewer session that is
 * disposed with the viewer). When a
 * new stateful service joins the rendering chain, add it here too —
 * `provide-visualization.spec.ts` fails until it is listed (or allow-listed there as
 * deliberately shared).
 */
export function provideVisualization(): Provider[] {
  return [
    RoutingVisualizerService,
    PlotlyService,
    OpenSeadragonVisualizerService,
    NapariVisualizerService,
    VisualizerStore,
    RegionStore,
    SpatialSelectionStore,
    IntensityProfileService,
    // The canvas tools (wand, brush, eraser, zoom-to-box, SAM point) are not here:
    // each backend above builds its own instances in its CanvasToolManager. The
    // SAM point tools report through the chain's SamPointToolService.
    SamToolService,
    SamPointToolService,
    CellSegmentToolService,
    // The host-facing contracts, bound here at the SAME (component) scope so they
    // resolve to the isolated router instance, not root.
    ...VISUALIZER_TOKEN_BINDINGS,
  ];
}
