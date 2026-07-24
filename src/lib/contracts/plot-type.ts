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
  /** WebGPU 2D scatter of region centroids (napari-js analog of Plotly SCATTER). */
  NAPARI_SCATTER = 'napari-scatter',
  /** WebGPU 3D scatter of the downsampled voxel cloud (napari-js analog of Plotly SCATTER3D). */
  NAPARI_SCATTER3D = 'napari-scatter3d',
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
  /** Human-readable label for menus/dropdowns. Shown in **test mode**, where
   *  every backend's type is offered, so it carries the backend suffix (e.g.
   *  "Surface (napari · WebGPU)") to disambiguate same-named modes. */
  label: string;
  /**
   * Label shown in the **default (non-test) selector**, where a single curated
   * mode owns each name — so it drops the backend suffix (e.g. just "Surface").
   * A type WITHOUT a `productionLabel` is **test-only**: hidden from the default
   * selector and shown only when the host enables test mode. This is the single
   * knob that curates the default plot-mode list (jax-image-visualization).
   */
  productionLabel?: string;
  /**
   * Icon shown to the left of the label in the plot-type selector. Either a
   * PrimeNG icon class (starts with `pi `, e.g. `pi pi-image`) rendered as a
   * font glyph, or a served SVG asset path (e.g. `assets/plotting/surface.svg`)
   * rendered as an `<img>`. Both are tinted to the toolbar's primary blue.
   */
  icon?: string;
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
// Dropdown order = insertion order: Image (OSD) default at the top, then all Plotly plot modes
// grouped, then all napari-js WebGPU modes grouped.
// `productionLabel` marks the curated default-selector set (jit-ui#70 follow-up):
//  - IMAGE / HEATMAP / CONTOUR (2D) and the napari SURFACE / VOLUME / ISOSURFACE
//    (3D) are the modes shown by default, under suffix-free names.
//  - Everything else (all Scatters, NAPARI_IMAGE, and the Plotly SURFACE /
//    ISOSURFACE that the napari versions supersede) is test-only — no
//    `productionLabel`, so it appears only when the host enables test mode.
export const PLOT_TYPE_DESCRIPTORS: Partial<Record<PlotType, PlotTypeDescriptor>> = {
  // ── Default ──
  [PlotType.IMAGE]:      { type: PlotType.IMAGE,      label: 'Image (OSD)',           productionLabel: 'Image',      icon: 'pi pi-image',                    dimensions: '2d', source: 'image' },
  // ── Plotly ──
  [PlotType.HEATMAP]:    { type: PlotType.HEATMAP,    label: 'Heatmap (Plotly)',      productionLabel: 'Heatmap',    icon: 'assets/plotting/heatmap.svg',    dimensions: '2d', source: 'image' },
  [PlotType.CONTOUR]:    { type: PlotType.CONTOUR,    label: 'Contour (Plotly)',      productionLabel: 'Contour',    icon: 'assets/plotting/contour.svg',    dimensions: '2d', source: 'image', requiresGrayscale: true },
  [PlotType.SCATTER]:    { type: PlotType.SCATTER,    label: 'Scatter 2D (Plotly)',   icon: 'pi pi-chart-scatter',            dimensions: '2d', source: 'regions' },
  [PlotType.SURFACE]:    { type: PlotType.SURFACE,    label: 'Surface (Plotly)',      icon: 'assets/plotting/surface.svg',    dimensions: '3d', source: 'image', requiresGrayscale: true },
  [PlotType.SCATTER3D]:  { type: PlotType.SCATTER3D,  label: 'Scatter 3D (Plotly)',   icon: 'assets/plotting/3d-coordinates.svg', dimensions: '3d', source: 'image', requiresStack: true, requiresGrayscale: true },
  [PlotType.ISOSURFACE]: { type: PlotType.ISOSURFACE, label: 'Isosurface (Plotly)',   icon: 'assets/plotting/isosurface.svg', dimensions: '3d', source: 'image', requiresStack: true, requiresGrayscale: true },
  // ── napari-js WebGPU (jit-ui#102). The 3D types take a runtime decimate factor. ──
  [PlotType.NAPARI_IMAGE]:      { type: PlotType.NAPARI_IMAGE,      label: 'Image (napari · WebGPU)',      icon: 'pi pi-image',                        dimensions: '2d', source: 'image' },
  [PlotType.NAPARI_SCATTER]:    { type: PlotType.NAPARI_SCATTER,    label: 'Scatter 2D (napari · WebGPU)', icon: 'pi pi-chart-scatter',                dimensions: '2d', source: 'regions' },
  [PlotType.NAPARI_SURFACE]:    { type: PlotType.NAPARI_SURFACE,    label: 'Surface (napari · WebGPU)',    productionLabel: 'Surface',    icon: 'assets/plotting/surface.svg',        dimensions: '3d', source: 'image' }, // a height-field is z=intensity of one plane — works for any grayscale/RGB image (RGB→luminance), no stack needed
  [PlotType.NAPARI_SCATTER3D]:  { type: PlotType.NAPARI_SCATTER3D,  label: 'Scatter 3D (napari · WebGPU)', icon: 'assets/plotting/3d-coordinates.svg', dimensions: '3d', source: 'image', requiresStack: true, requiresGrayscale: true },
  [PlotType.NAPARI_VOLUME]:     { type: PlotType.NAPARI_VOLUME,     label: 'Volume (napari · WebGPU)',     productionLabel: 'Volume',     icon: 'assets/plotting/cube-3d.svg',        dimensions: '3d', source: 'image', requiresStack: true, requiresGrayscale: true },
  [PlotType.NAPARI_ISOSURFACE]: { type: PlotType.NAPARI_ISOSURFACE, label: 'Isosurface (napari · WebGPU)', productionLabel: 'Isosurface', icon: 'assets/plotting/isosurface.svg',     dimensions: '3d', source: 'image', requiresStack: true, requiresGrayscale: true },
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
/** napari-js 2D scatter (region centroids). */
export function isNapariScatter(type: PlotType): boolean {
  return type === PlotType.NAPARI_SCATTER;
}
/** napari-js 3D scatter (voxel point cloud). */
export function isNapariScatter3d(type: PlotType): boolean {
  return type === PlotType.NAPARI_SCATTER3D;
}
/** Any napari-js 3D plot type (volume, isosurface, surface, or 3D scatter). Resolution is a runtime
 *  decimate factor (Full / ½ / ¼ / ⅛) — see the service's `resolutionScale`. */
export function isNapari3d(type: PlotType): boolean {
  return (
    isNapariVolume(type) || isNapariIsosurface(type) || isNapariSurface(type) || isNapariScatter3d(type)
  );
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
