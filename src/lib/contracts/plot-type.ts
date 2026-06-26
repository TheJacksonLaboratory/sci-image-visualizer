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
  /** WebGPU napari-js renderings (jit-ui#102), selectable alongside the OSD/Plotly types.
   *  Volume/isosurface come in high-res and low-res variants: low-res fetches fewer/smaller
   *  slices for a faster (coarser) 3D preview. */
  NAPARI_IMAGE = 'napari-image',
  NAPARI_VOLUME = 'napari-volume',
  NAPARI_ISOSURFACE = 'napari-isosurface',
  NAPARI_VOLUME_LOWRES = 'napari-volume-lowres',
  NAPARI_ISOSURFACE_LOWRES = 'napari-isosurface-lowres',
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
  [PlotType.SCATTER3D]:  { type: PlotType.SCATTER3D,  label: 'Scatter 3D',         dimensions: '3d', source: 'image', requiresStack: true, requiresGrayscale: true },
  [PlotType.ISOSURFACE]: { type: PlotType.ISOSURFACE, label: 'Isosurface (3D)',    dimensions: '3d', source: 'image', requiresStack: true, requiresGrayscale: true },
  // WebGPU napari-js renderings (jit-ui#102). Volume/isosurface offer high-res + low-res variants.
  [PlotType.NAPARI_IMAGE]:               { type: PlotType.NAPARI_IMAGE,               label: 'Image (napari · WebGPU)',                dimensions: '2d', source: 'image' },
  [PlotType.NAPARI_VOLUME]:              { type: PlotType.NAPARI_VOLUME,              label: 'Volume (napari · WebGPU · high-res)',    dimensions: '3d', source: 'image', requiresStack: true, requiresGrayscale: true },
  [PlotType.NAPARI_VOLUME_LOWRES]:       { type: PlotType.NAPARI_VOLUME_LOWRES,       label: 'Volume (napari · WebGPU · low-res)',     dimensions: '3d', source: 'image', requiresStack: true, requiresGrayscale: true },
  [PlotType.NAPARI_ISOSURFACE]:          { type: PlotType.NAPARI_ISOSURFACE,          label: 'Isosurface (napari · WebGPU · high-res)', dimensions: '3d', source: 'image', requiresStack: true, requiresGrayscale: true },
  [PlotType.NAPARI_ISOSURFACE_LOWRES]:   { type: PlotType.NAPARI_ISOSURFACE_LOWRES,   label: 'Isosurface (napari · WebGPU · low-res)',  dimensions: '3d', source: 'image', requiresStack: true, requiresGrayscale: true },
};

export function getPlotTypeDescriptor(type: PlotType): PlotTypeDescriptor | undefined {
  return PLOT_TYPE_DESCRIPTORS[type];
}

export function isThreeDimensional(type: PlotType): boolean {
  return PLOT_TYPE_DESCRIPTORS[type]?.dimensions === '3d';
}

// ── napari-js 3D plot-type predicates (high-res + low-res variants) ──────────
/** napari-js volume (either resolution). */
export function isNapariVolume(type: PlotType): boolean {
  return type === PlotType.NAPARI_VOLUME || type === PlotType.NAPARI_VOLUME_LOWRES;
}
/** napari-js isosurface (either resolution). */
export function isNapariIsosurface(type: PlotType): boolean {
  return type === PlotType.NAPARI_ISOSURFACE || type === PlotType.NAPARI_ISOSURFACE_LOWRES;
}
/** Any napari-js 3D plot type (volume or isosurface, either resolution). */
export function isNapari3d(type: PlotType): boolean {
  return isNapariVolume(type) || isNapariIsosurface(type);
}
/** The low-res napari 3D variants (coarser/faster slice sampling). */
export function isLowResNapari3d(type: PlotType): boolean {
  return type === PlotType.NAPARI_VOLUME_LOWRES || type === PlotType.NAPARI_ISOSURFACE_LOWRES;
}
