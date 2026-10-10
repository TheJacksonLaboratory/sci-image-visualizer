import { NgModule } from '@angular/core';

import { VisualizerComponent } from './visualizer.component';
import { RegionEditorComponent } from './region-editor/region-editor.component';
import { HexColorPickerComponent } from './hex-color-picker/hex-color-picker.component';
import { ChannelHistogramComponent } from './channel-histogram/channel-histogram.component';
import { SpatialControlsComponent } from './spatial-controls/spatial-controls.component';
import { SpatialChartsComponent } from './spatial-controls/spatial-charts/spatial-charts.component';
import { VISUALIZER_TOKEN_BINDINGS } from './provide-visualization';

/** The embeddable components, all standalone. */
const PUBLIC_COMPONENTS = [
  VisualizerComponent,
  RegionEditorComponent,
  HexColorPickerComponent,
  ChannelHistogramComponent,
  SpatialControlsComponent,
  SpatialChartsComponent,
];

/**
 * Self-contained plotting UI: the {@link VisualizerComponent} (plot surface
 * + render orchestration, with its toolbar), the {@link RegionEditorComponent}
 * (the Regions table/editor), {@link HexColorPickerComponent}
 * (`<hex-color-picker>`, `[color]` in, `(colorChange)` out),
 * {@link ChannelHistogramComponent}, {@link SpatialControlsComponent} and
 * {@link SpatialChartsComponent}. Consumers embed `<visualizer>` /
 * `<region-editor>` and need know nothing about the toolbar, the rendering
 * backends, or region file I/O (supplied via the REGION_IO_PORT).
 *
 * @deprecated A re-export shim, kept for one minor release: every component is
 * standalone now. Import the components themselves (`imports: [VisualizerComponent]`)
 * and bind the backend chain with {@link provideVisualization} — in the application's
 * providers for one app-wide viewer chain, or a component's for an isolated one —
 * instead of the root bindings this module adds.
 */
@NgModule({
  imports: PUBLIC_COMPONENTS,
  exports: PUBLIC_COMPONENTS,
  providers: [
    // Internal backend wiring. All three host-facing contracts are served by the
    // RoutingVisualizerService (the Plotly/OpenSeadragon selector), so consumers
    // depend only on the tokens and never the concrete router. Owned by the
    // library so importing VisualizationModule is enough — the host supplies only
    // the *ports* (IMAGE_STATE_PORT / TILE_ACCESS_PORT / REGION_IO_PORT) and
    // VIZ_CONFIG, which are app-specific. A consumer needing an isolated instance
    // (e.g. a modal that mustn't share region/image state) uses provideVisualization(),
    // which binds the same set at component scope and shadows these for its subtree.
    VISUALIZER_TOKEN_BINDINGS,
  ],
})
export class VisualizationModule {}
