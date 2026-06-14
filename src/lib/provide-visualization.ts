import { Provider } from '@angular/core';

import { RoutingVisualizerService } from './routing-visualizer.service';
import { PlotlyService } from './implementations/plotly/plotly.service';
import { OpenSeadragonVisualizerService } from './implementations/osd/openseadragon-visualizer.service';
import { VisualizerStore } from './store/visualizer-store.service';
import { RegionStore } from './store/region-store.service';
import { WandToolService } from './toolbar/wand/wand-tool.service';
import { VertexEraserToolService } from './toolbar/vertex-eraser/vertex-eraser-tool.service';
import { ZoomToBoxToolService } from './toolbar/zoom-to-box/zoom-to-box-tool.service';
import { VISUALIZER } from './contracts/visualizer.contract';
import { REGION_EDITOR_API } from './contracts/region-editor-api.contract';
import { CHANNEL_HISTOGRAM_API } from './contracts/channel-histogram-api.contract';

/**
 * A self-contained, isolated visualization backend chain for a component subtree.
 *
 * The chain services are `providedIn: 'root'` singletons, so by default the whole
 * app shares one viewer's state (regions, image, channels, render handles) — which
 * is correct for the single main viewer. A consumer that needs a SECOND, independent
 * viewer (e.g. a modal that mounts `<jaxviz-visualization>` over the live main view
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
 *     { provide: VIZ_CONFIG,       useValue: { useOsdForImage: true, slideCropServer: '' } },
 *   ],
 * })
 * ```
 *
 * Component-scoped providers shadow the root singletons for that subtree, so the
 * embedded viewer gets its own router/Plotly/OSD/stores/tools while the rest of the
 * app keeps the default root instance.
 *
 * Lists EVERY stateful service in the chain. Stateless collaborators (HttpClient,
 * MessageService, WandService) deliberately resolve to root — they hold no
 * per-viewer state, so sharing them is correct and keeps this list minimal. When a
 * new stateful service joins the rendering chain, add it here too.
 */
export function provideVisualization(): Provider[] {
  return [
    RoutingVisualizerService,
    PlotlyService,
    OpenSeadragonVisualizerService,
    VisualizerStore,
    RegionStore,
    WandToolService,
    VertexEraserToolService,
    ZoomToBoxToolService,
    // The three host-facing contracts are all served by the router — bound here at
    // the SAME (component) scope so they resolve to the isolated instance, not root.
    { provide: VISUALIZER, useExisting: RoutingVisualizerService },
    { provide: REGION_EDITOR_API, useExisting: RoutingVisualizerService },
    { provide: CHANNEL_HISTOGRAM_API, useExisting: RoutingVisualizerService },
  ];
}
