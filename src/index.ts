/**
 * Public API of `@jax-data-science/sci-image-visualizer`. External consumers import
 * ONLY from here; everything else under `lib/` is internal. The surface is
 * contracts + tokens + neutral models + the Angular module and components, plus
 * `provideVisualization()` for an isolated, component-scoped viewer. The library
 * binds the tokens itself (VisualizationModule / provideVisualization), so a host
 * injects `VISUALIZER`, `REGION_EDITOR_API` and `CHANNEL_HISTOGRAM_API` and supplies
 * only the ports and `VIZ_CONFIG`.
 */

// ── Contracts & DI tokens ────────────────────────────────────────────────
export * from './lib/contracts/visualizer.contract';
export * from './lib/contracts/region-editor-api.contract';
export * from './lib/contracts/ports/image-state.port';
export * from './lib/contracts/ports/tile-access.port';
export * from './lib/contracts/ports/region-io.port';
export * from './lib/contracts/ports/preferences.port';
export * from './lib/contracts/ports/spatial-data.port';
export * from './lib/contracts/spatial-dataset.contract';
export * from './lib/contracts/channel-histogram-api.contract';
export * from './lib/contracts/viz-config';
export * from './lib/contracts/image.contract';
export * from './lib/contracts/plot-type';
export * from './lib/contracts/toolbar-config';
export * from './lib/contracts/toolbar-tool.contract';
export * from './lib/contracts/plot-type-contribution.contract';
export * from './lib/contracts/capabilities.contract';
export * from './lib/contracts/region-overlay.contract';
export * from './lib/contracts/display-types';
export * from './lib/contracts/sam.contract';
export * from './lib/contracts/cell-segmenter.contract';
export { CellposeSegmenterService } from './lib/toolbar/segmentation/cellpose-segmenter.service';

// ── Spatial-omics data plane ─────────────────────────────────────────────
// The wire format the bundled example server speaks, plus a ready-made
// SpatialDataPort adapter for it. Both are OPTIONAL: a host with its own
// backend implements SpatialDataPort directly and imports neither.
export { SpatialDataHttpService, SupersededError } from './lib/implementations/spatial-data-http/spatial-data-http.service';
export {
  SPATIAL_WIRE_VERSION, isLittleEndian, assertManifestVersion, datasetFromManifest,
  decodeCoords, decodeRadius, decodeColumn, decodeFeatureVector, decodePolygons,
} from './lib/implementations/spatial-data-http/spatial-wire';
export type {
  SpatialManifest, SpatialDatasetSummary, SpatialRadiusSpec,
} from './lib/implementations/spatial-data-http/spatial-wire';
// Backend-neutral encodings: columns/genes -> per-point colours and sizes.
export {
  encodeCategorical, encodeContinuous, resolveCategoryColors, contrastWindow,
  markerDiameters, toRgbaTuples, lutFor,
  DEFAULT_CATEGORICAL_PALETTE, DEFAULT_MUTED_OPACITY, MISSING_COLOR,
} from './lib/spatial/spatial-encoding';
export type {
  RGBA, CategoricalEncodingOptions, ContinuousEncodingOptions,
} from './lib/spatial/spatial-encoding';
// Selection: which observations fall inside the drawn ROIs (as a SpatialSelectionMask,
// exported with the dataset contract above), and the shared store
// that holds the answer.
export {
  selectInRegions, selectByCategory, mutedFromSelection, pointInRing,
  emptySelection, countMask, maskToIndices,
} from './lib/spatial/spatial-selection';
export { SpatialSelectionStore } from './lib/store/spatial-selection.service';
export * from './lib/contracts/instance-segmenter.contract';
export * from './lib/contracts/semantic-segmenter.contract';

// ── Generic client-side image utilities (shared with the host's pipeline) ──
export { ProcessingImage } from './lib/processing/processing-image';
export { cropImage, CropImageOptions } from './lib/processing/image-crop';
export { ImageConverterService } from './lib/processing/image-converter.service';

// ── SAM model registry (host configures hosted ONNX URLs once available) ──
export {
  SAM_MODELS, DEFAULT_SAM_MODEL_ID, getSamModel, isSamModelReady, setSamModelUrls,
  setDefaultSamModel, getDefaultSamModelId,
} from './lib/toolbar/segmentation/sam-model-registry';

// ── onnxruntime-web WASM location (host overrides once, at app init) ───────
export { setOrtWasmBase, getOrtWasmBase } from './lib/toolbar/segmentation/ort-runtime-config';
// Frees the several hundred MB of downloaded SAM models the browser keeps per origin.
export { clearSamModelCache } from './lib/toolbar/segmentation/sam-onnx-core';

// ── Neutral data models ──────────────────────────────────────────────────
export * from './lib/models/region';
export * from './lib/models/class-preset';
export { ShapeSelection } from './lib/models/shape';

// ── Angular module + providers ───────────────────────────────────────────
// DEPRECATED, kept for one minor release: a shim re-exporting the standalone components
// below and binding the host-facing tokens at root.
export { VisualizationModule } from './lib/visualization.module';
// DEPRECATED as public API, kept for one release: hosts should inject the tokens
// (VISUALIZER / REGION_EDITOR_API / CHANNEL_HISTOGRAM_API), which the library binds
// to this router itself. Reaching for the concrete class bypasses that binding.
export { RoutingVisualizerService } from './lib/routing-visualizer.service';
// Provider factory for an isolated, component-scoped viewer instance (e.g. a
// modal that must not share the main viewer's region/image state).
export { provideVisualization } from './lib/provide-visualization';

// Keys of the toast outlets the visualizer renders for the library's own notices.
// A host that renders its own <p-toast> with one of these keys shows each notice twice.
export { VIZ_TOAST_KEY, VIZ_ALERT_TOAST_KEY } from './lib/toast-outlets';

// ── Public components (standalone; also re-exported by VisualizationModule) ──
// The embeddable elements (`<visualizer>`, `<region-editor>`, `<hex-color-picker>`,
// `<channel-histogram>`, `<spatial-controls>`, `<spatial-charts>`). Each is standalone:
// a host imports it directly and binds the backend chain with `provideVisualization()`.
export { VisualizerComponent } from './lib/visualizer.component';
export { RegionEditorComponent } from './lib/region-editor/region-editor.component';
export { HexColorPickerComponent } from './lib/hex-color-picker/hex-color-picker.component';
export { ChannelHistogramComponent } from './lib/channel-histogram/channel-histogram.component';
export {
  SpatialControlsComponent,
} from './lib/spatial-controls/spatial-controls.component';
export type { SpatialLegendEntry } from './lib/spatial-controls/spatial-controls.component';
export { SpatialChartsComponent } from './lib/spatial-controls/spatial-charts/spatial-charts.component';
// Pure chart builders, exported so a host can render the same distributions
// wherever it likes (a report, a different charting surface).
export {
  buildOmicsTraces, omicsLayout, benefitsFromGrouping,
} from './lib/implementations/plotly/omics-trace-builders';
export type {
  OmicsChartKind, OmicsGrouping, OmicsTraceInput,
} from './lib/implementations/plotly/omics-trace-builders';
