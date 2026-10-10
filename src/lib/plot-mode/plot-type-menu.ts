import { ViewerCapabilities, ViewerFeature } from '../contracts/capabilities.contract';
import { IImageInfo } from '../contracts/image.contract';
import { PlotType, PlotTypeDescriptor, PlotTypeId, getPlotTypeDescriptor } from '../contracts/plot-type';
import {
  ContributedPlotTypeDescriptor, PlotTypeOption, contributedPlotTypeOption,
} from '../contracts/plot-type-contribution.contract';

/** What a spatial-omics dataset on offer contributes to the plot-type gates. */
export interface SpatialGates {
  /** A dataset is published on `SPATIAL_DATA_PORT`. */
  hasDataset: boolean;
  /** Its observations carry a z, so it can be drawn as a 3D cloud. */
  has3d: boolean;
  /** It brings pixels of its own: a tissue image it registers onto, or a volume
   *  published as a z-stack image. */
  hasPixels: boolean;
}

type DataRequirements = Pick<PlotTypeDescriptor,
  'requiresStack' | 'requiresGrayscale' | 'requiresSpatialData' | 'requiresSpatial3d'>;

/** Everything {@link computePlotTypeMenu} gates on. */
export interface PlotTypeMenuInput {
  /** The built-in types the backend advertises. */
  descriptors: PlotTypeDescriptor[];
  /** Contributed plot modes (`PLOT_TYPE_CONTRIBUTIONS`). */
  contributions: ContributedPlotTypeDescriptor[];
  caps: ViewerCapabilities;
  imageInfo: IImageInfo | undefined;
  spatial: SpatialGates;
  /** Offer every backend's type under its full label, not just the curated set. */
  testMode: boolean;
}

/** The selector's entries: {@link builtIn} then the contributed modes. */
export interface PlotTypeMenu {
  builtIn: PlotTypeDescriptor[];
  menu: PlotTypeOption[];
}

/**
 * Plot types offered in the selector for the current image:
 *  - Outside **test mode**, only the curated default set (descriptors with a
 *    `productionLabel`) is offered, shown under suffix-free names — Image,
 *    Heatmap, Contour and the napari Surface / Volume / Isosurface. Test mode
 *    exposes every backend's type under its full (backend-suffixed) label.
 *  - 3D types hidden when the backend can't render a 3D scene.
 *  - stack-only types (volume, isosurface) hidden unless the file is a stack —
 *    a volume needs multiple z-slices.
 *  - scalar-intensity types (contour, surface, isosurface) hidden for RGB
 *    images — they map a single intensity per pixel. Image and Heatmap render
 *    any image. A multichannel image's bands are each scalar, so it passes.
 *  - spatial-omics types hidden until a `SpatialDataset` is published on
 *    `SPATIAL_DATA_PORT` — the mode has nothing to draw without observations,
 *    exactly as a volume has nothing to draw without a stack.
 *  - image-sourced types hidden while a dataset that brings no pixels is up.
 *
 * Contributed modes come after every built-in one, under the same label rule and
 * their own stack/grayscale/spatial gates; a mode also needs whatever its base view
 * needs, so the base type's gates apply too.
 */
export function computePlotTypeMenu(input: PlotTypeMenuInput): PlotTypeMenu {
  const { caps, imageInfo, spatial, testMode } = input;
  const isStack = !!imageInfo?.isStack;
  const isGrayscale = !!imageInfo?.isGrayscale;
  const m0 = imageInfo?.imageMeta?.[0];
  const isMultichannel = (m0?.channelCount ?? 1) > 1 && (m0?.rgbChannels ?? 1) < 3;
  const dataGates = (d: DataRequirements): boolean => {
    // Volume and Isosurface raymarch the IMAGE STACK, and nothing else: a 3D omics
    // dataset reaches them because its registered volume is published AS a grayscale
    // z-stack image (`buildVolumeStackImage`), not through a second voxel source.
    if (d.requiresStack && !isStack) return false;
    if (d.requiresGrayscale && !isGrayscale && !isMultichannel) return false;
    if (d.requiresSpatialData && !spatial.hasDataset) return false;
    if (d.requiresSpatial3d && !spatial.has3d) return false;
    return true;
  };
  const passesGates = (d: PlotTypeDescriptor): boolean => {
    if (d.dimensions === '3d' && !caps.has(ViewerFeature.Surface3D)) return false;
    if (!dataGates(d)) return false;
    // An image-sourced mode reads PIXELS. A spatial dataset that brings no tissue image
    // (seqFISH records unitless coordinates, not a section) leaves nothing for one to
    // draw. Narrowed to "a dataset is up AND there is no image": with no dataset at
    // all, Image stays on offer as the host's default.
    return !(d.source === 'image' && spatial.hasDataset && !spatial.hasPixels);
  };
  const curated = (d: { productionLabel?: string }): boolean => testMode || !!d.productionLabel;
  const builtIn = input.descriptors.filter((d) => curated(d) && passesGates(d));
  const contributed: PlotTypeOption[] = [];
  for (const d of input.contributions) {
    if (!curated(d) || !dataGates(d)) continue;
    const base = getPlotTypeDescriptor(d.baseType);
    if (base && passesGates(base)) contributed.push(contributedPlotTypeOption(d, base));
  }
  // Default selector shows the suffix-free productionLabel; test mode keeps the full
  // backend-suffixed label so same-named modes stay distinguishable.
  const labelled = <T extends { label: string; productionLabel?: string }>(d: T): T =>
    (testMode ? d : { ...d, label: d.productionLabel! });
  const shown = builtIn.map(labelled);
  return { builtIn: shown, menu: [...shown, ...contributed.map(labelled)] };
}

/**
 * The type to fall back to when `selected` is no longer offered — Image when it is
 * on offer, else the first type still offered — or null when `selected` is still
 * offered (or nothing is). With no image loaded the pixel modes are gone, and falling
 * back to Image would select a mode the selector does not list and nothing can draw.
 */
export function reconcilePlotType(menu: PlotTypeOption[], selected: PlotTypeId): PlotTypeId | null {
  if (menu.some((d) => d.type === selected)) return null;
  if (menu.some((d) => d.type === PlotType.IMAGE)) return PlotType.IMAGE;
  return menu[0]?.type ?? null;
}
