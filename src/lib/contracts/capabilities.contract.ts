/**
 * Optional features a viewer backend may or may not support. Consumers query
 * `IImageViewer.capabilities` and degrade gracefully (hide a toolbar item,
 * skip a render path) rather than calling a method that no-ops.
 *
 * The Plotly backend supports the scientific/data features; the OpenSeadragon
 * backend supports `ImageDisplay` (large zoomable image) but not the
 * scalar-data features. The eventual router picks a backend per plot type.
 */
export enum ViewerFeature {
  /** Display a raster/tiled image (HEATMAP/RGB image, OSD's strength). */
  ImageDisplay = 'imageDisplay',
  /** 3D scene rendering (SURFACE, SCATTER3D, ISOSURFACE). */
  Surface3D = 'surface3d',
  /** Live colormap/LUT applied to a raw scalar matrix. */
  ScalarColormap = 'scalarColormap',
  /** Read back the displayed pixel matrix (getDisplayedPixelData). */
  PixelReadback = 'pixelReadback',
  /** Server re-fetch of a higher-res crop on zoom (vs native tiling). */
  HighDefZoom = 'highDefZoom',
  /** Per-z-plane slider over an image stack. */
  StackSlider = 'stackSlider',
  /** Live isosurface intensity bounds (isomin/isomax) — see IIsosurfaceControls. */
  Isosurface = 'isosurface',
}

export interface ViewerCapabilities {
  has(feature: ViewerFeature): boolean;
}

/** Build a `ViewerCapabilities` from a fixed feature set. */
export function capabilitiesOf(features: Iterable<ViewerFeature>): ViewerCapabilities {
  const set = new Set<ViewerFeature>(features);
  return { has: (f: ViewerFeature) => set.has(f) };
}
