/**
 * Public API of the jax-image-visualization library. External consumers import
 * ONLY from here (`@jax-image/visualization`); everything else under `lib/` is
 * internal. The surface is contracts + tokens + neutral models + the Angular
 * module, plus the routing service the host's composition root binds the tokens
 * to (`useExisting`).
 */

// ── Contracts & DI tokens ────────────────────────────────────────────────
export * from './lib/contracts/visualizer.contract';
export * from './lib/contracts/region-editor-api.contract';
export * from './lib/contracts/ports/image-state.port';
export * from './lib/contracts/ports/tile-access.port';
export * from './lib/contracts/ports/region-io.port';
export * from './lib/contracts/channel-histogram-api.contract';
export * from './lib/contracts/viz-config';
export * from './lib/contracts/image.contract';
export * from './lib/contracts/plot-type';
export * from './lib/contracts/capabilities.contract';
export * from './lib/contracts/region-overlay.contract';

// ── Neutral data models ──────────────────────────────────────────────────
export * from './lib/models/region';
export { ShapeSelection } from './lib/models/shape';

// ── Angular module + composition-root service ────────────────────────────
export { VisualizationModule } from './lib/visualization.module';
export { RoutingVisualizerService } from './lib/routing-visualizer.service';

// ── Public components (exported by VisualizationModule) ───────────────────
// ng-packagr requires module-exported components to be reachable from the
// entry point so consumers get their types; these are the embeddable elements
// (`<visualization>`, `<region-editor>`, `<hex-color-picker>`).
export { VisualizationComponent } from './lib/visualization.component';
export { RegionEditorComponent } from './lib/region-editor/region-editor.component';
export { HexColorPickerComponent } from './lib/hex-color-picker/hex-color-picker.component';
export { ChannelHistogramComponent } from './lib/channel-histogram/channel-histogram.component';
