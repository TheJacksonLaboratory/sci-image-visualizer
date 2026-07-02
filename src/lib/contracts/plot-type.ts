/**
 * The kind of rendering a viewer backend should produce for the loaded data.
 *
 * Lives in `contracts/` (rather than inside a specific backend) because it is
 * part of the backend-neutral plotting contract: both the Plotly backend and
 * any future backend (e.g. OpenSeadragon) accept a `PlotType` on `plot()`.
 *
 * NOTE: a backend may not support every type — 3D types (`SURFACE`,
 * `SCATTER3D`, `ISOSURFACE`) are gated behind `ViewerFeature.Surface3D` in the
 * capabilities contract, so a 2D-only backend can advertise that it can't
 * render them and the UI can hide the option.
 */
export enum PlotType {
  /** Natively-tiled, zoomable raster rendered by OpenSeadragon (the default
   *  view for an image). Heatmap remains the Plotly scalar-image rendering. */
  IMAGE = 'image',
  HEATMAP = 'heatmap',
  SURFACE = 'surface',
  CONTOUR = 'contour',
  SCATTER = 'scatter',
  // LINE: reserved/stubbed — intensity profiles are now Region-based (kept for future use)
  LINE = 'line',
  SCATTER3D = 'scatter3d',
  ISOSURFACE = 'isosurface',
  /** WebGPU napari-js renderings (jit-ui#102), selectable alongside the OSD/Plotly types. The 3D
   *  types take a runtime decimate factor (Full / ½ / ¼ / ⅛) instead of fixed hi/lo-res variants. */
  NAPARI_IMAGE = 'napari-image',
  NAPARI_VOLUME = 'napari-volume',
  NAPARI_ISOSURFACE = 'napari-isosurface',
  /** WebGPU height-field surface mesh (z = intensity), the napari-js analog of Plotly SURFACE. */
  NAPARI_SURFACE = 'napari-surface',
}

/** How many spatial dimensions a plot type renders in. */
export type PlotDimensions = '2d' | '3d';

/**
 * Where a plot type pulls its data from:
 *  - `image`   — the loaded pixel matrices / z-stack (HEATMAP, SURFACE, …)
 *  - `regions` — the drawn/derived regions (SCATTER of region centroids, …)
 */
export type PlotDataSource = 'image' | 'regions';

/**
 * Backend-neutral metadata about a plot type. Drives UI affordances (which
 * types are 3D, which need an image stack, how to label them in a dropdown)
 * without any backend's trace-building logic leaking into the contract.
 */
export interface PlotTypeDescriptor {
  type: PlotType;
  /** Human-readable label for menus/dropdowns. */
  label: string;
  dimensions: PlotDimensions;
  source: PlotDataSource;
  /** True when the type only makes sense over a multi-frame z-stack. */
  requiresStack?: boolean;
  /** True when the type maps a single scalar intensity per pixel (contour,
   *  surface, intensity profile, isosurface) — only meaningful for grayscale.
   *  Image/Heatmap render RGB fine; Scatter uses regions. */
  requiresGrayscale?: boolean;
}

/**
 * Single source of truth for plot-type metadata. LINE is intentionally absent —
 * intensity profiles are now Region-based line ROIs (available in Heatmap/Image
 * mode), so LINE is no longer offered in the selector (the enum member is kept
 * for future use). Hence the `Partial` record.
 */
export const PLOT_TYPE_DESCRIPTORS: Partial<Record<PlotType, PlotTypeDescriptor>> = {
  [PlotType.IMAGE]:      { type: PlotType.IMAGE,      label: 'Image',              dimensions: '2d', source: 'image' },
  [PlotType.HEATMAP]:    { type: PlotType.HEATMAP,    label: 'Heatmap',            dimensions: '2d', source: 'image' },
  [PlotType.CONTOUR]:    { type: PlotType.CONTOUR,    label: 'Contour',            dimensions: '2d', source: 'image', requiresGrayscale: true },
  [PlotType.SCATTER]:    { type: PlotType.SCATTER,    label: 'Scatter (regions)',  dimensions: '2d', source: 'regions' },
  [PlotType.SURFACE]:    { type: PlotType.SURFACE,    label: 'Surface (3D)',       dimensions: '3d', source: 'image', requiresGrayscale: true },
  // napari-js WebGPU height-field surface — listed directly below the Plotly "Surface (3D)". No
  // requiresStack: a surface renders a single slice (a stack just adds the z-slider), so it's
  // offered for single grayscale images too. Resolution is a runtime decimate factor.
  [PlotType.NAPARI_SURFACE]: { type: PlotType.NAPARI_SURFACE, label: 'Surface (napari · WebGPU)', dimensions: '3d', source: 'image', requiresGrayscale: true },
  [PlotType.SCATTER3D]:  { type: PlotType.SCATTER3D,  label: 'Scatter 3D',         dimensions: '3d', source: 'image', requiresStack: true, requiresGrayscale: true },
  [PlotType.ISOSURFACE]: { type: PlotType.ISOSURFACE, label: 'Isosurface (3D)',    dimensions: '3d', source: 'image', requiresStack: true, requiresGrayscale: true },
  // WebGPU napari-js renderings (jit-ui#102). The 3D types take a runtime decimate factor.
  [PlotType.NAPARI_IMAGE]:      { type: PlotType.NAPARI_IMAGE,      label: 'Image (napari · WebGPU)',      dimensions: '2d', source: 'image' },
  [PlotType.NAPARI_VOLUME]:     { type: PlotType.NAPARI_VOLUME,     label: 'Volume (napari · WebGPU)',     dimensions: '3d', source: 'image', requiresStack: true, requiresGrayscale: true },
  [PlotType.NAPARI_ISOSURFACE]: { type: PlotType.NAPARI_ISOSURFACE, label: 'Isosurface (napari · WebGPU)', dimensions: '3d', source: 'image', requiresStack: true, requiresGrayscale: true },
};

export function getPlotTypeDescriptor(type: PlotType): PlotTypeDescriptor | undefined {
  return PLOT_TYPE_DESCRIPTORS[type];
}

export function isThreeDimensional(type: PlotType): boolean {
  return PLOT_TYPE_DESCRIPTORS[type]?.dimensions === '3d';
}

// ── napari-js 3D plot-type predicates ────────────────────────────────────────
/** napari-js volume. */
export function isNapariVolume(type: PlotType): boolean {
  return type === PlotType.NAPARI_VOLUME;
}
/** napari-js isosurface. */
export function isNapariIsosurface(type: PlotType): boolean {
  return type === PlotType.NAPARI_ISOSURFACE;
}
/** napari-js height-field surface mesh. */
export function isNapariSurface(type: PlotType): boolean {
  return type === PlotType.NAPARI_SURFACE;
}
/** Any napari-js 3D plot type (volume, isosurface, or surface). Resolution is a runtime decimate
 *  factor (Full / ½ / ¼ / ⅛) — see the service's `resolutionScale`. */
export function isNapari3d(type: PlotType): boolean {
  return isNapariVolume(type) || isNapariIsosurface(type) || isNapariSurface(type);
}

/** Decimate factors offered by the Resolution control (1 = Full … 8 = ⅛). */
export const NAPARI_DECIMATE_OPTIONS: { label: string; value: number }[] = [
  { label: 'Full', value: 1 },
  { label: '½', value: 2 },
  { label: '¼', value: 4 },
  { label: '⅛', value: 8 },
];

/** Default decimate factor: ¼. The caps are set so ¼ is a sensible default resolution while ½ and
 *  Full offer 2× and 4× the detail for opt-in high-resolution renders. */
export const NAPARI_DEFAULT_DECIMATE = 4;
