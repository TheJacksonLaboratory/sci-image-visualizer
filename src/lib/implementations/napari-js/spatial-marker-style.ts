import { Rgb } from '../../contracts/colormap-lut';
import { SpatialViewState, TranscriptGlyphName } from '../../contracts/display-types';
import { SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import {
  NO_CATEGORY,
  SpatialColumn,
  SpatialDataset,
  isCategoricalColumn,
} from '../../contracts/spatial-dataset.contract';
import { categoryColorsFor, encodeCategorical } from '../../spatial/spatial-encoding';
import { observationGeneMask, observationGeneStyle } from '../../spatial/spatial-gene-filter';
import { SpatialSelectionMask, mutedFromSelection } from '../../spatial/spatial-selection';
import { cellTypeColumnFor } from '../../spatial/spatial-tiles';
import {
  ContrastWindowCache,
  PointColors,
  SPATIAL_NEUTRAL_COLOR,
  SPATIAL_NEUTRAL_HEX,
  encodeSpatialContinuous,
} from './napari-spatial-encoding';

/**
 * What the 2D observation markers are coloured with, as a function of the dataset, the view, the
 * selection and the port — shared by every 2D renderer of the spatial mode (napari-js's WebGPU
 * scene and the WebGL fallback), so the two cannot disagree about what a colour means. No viewer,
 * no layer: the renderers take the colours and draw them their own way.
 */
export interface MarkerStyleDeps {
  readonly port: SpatialDataPort | null;
  /** The LUT a continuous colour source draws with (see `spatialLut`). */
  lut(view: SpatialViewState): Rgb[];
  /** The memoised percentile windows of the coloured vectors. */
  readonly windows: ContrastWindowCache;
  /** Prefix of the warnings logged when a read fails (`[napari-js]`, `[webgl]`). */
  readonly tag: string;
}

/** The markers' colours, and each observation's gene (code into `glyphs`) while they are
 *  coloured by gene — the renderer decides how to draw a gene's icon. */
export interface MarkerStyle {
  colors: PointColors;
  byGene: { codes: Uint16Array; glyphs: TranscriptGlyphName[] } | null;
}

/** The observations the view's gene filter keeps (1 = drawn), or null when it has none.
 *  Rejects when an expression read fails. */
export function markerFilterMask(
  port: SpatialDataPort | null,
  dataset: SpatialDataset,
  view: SpatialViewState,
): Promise<Uint8Array | null> {
  if (!port) return Promise.resolve(null);
  return observationGeneMask(view, dataset.observations.count, (g) => port.getFeatureVector(g));
}

/** The markers' colours (and genes, when coloured by gene) before the gene filter hides any. */
export async function markerStyle(
  deps: MarkerStyleDeps,
  dataset: SpatialDataset,
  view: SpatialViewState,
  selection: SpatialSelectionMask,
): Promise<MarkerStyle> {
  const port = deps.port;
  const count = dataset.observations.count;
  // Coloured by gene: each observation in its gene's colour. That is a colour, so a failed read
  // falls back to the view's colour source, as any colour does.
  const byGene = port
    ? await observationGeneStyle(view, count, (g) => port.getFeatureVector(g)).catch((err) => {
        console.warn(`${deps.tag} colouring by gene failed — falling back to the colour source`, err);
        return null;
      })
    : null;
  if (byGene) {
    const colors = encodeCategorical(byGene.codes, {
      colors: byGene.colors,
      opacity: view.opacity,
      muted: mutedFromSelection(selection),
    });
    return { colors, byGene: { codes: byGene.codes, glyphs: byGene.glyphs } };
  }
  return { colors: await markerSourceColors(deps, dataset, view, selection), byGene: null };
}

/** The markers' colours from the view's colour source and the selection, before the gene filter. */
export async function markerSourceColors(
  deps: MarkerStyleDeps,
  dataset: SpatialDataset,
  view: SpatialViewState,
  selection: SpatialSelectionMask,
): Promise<PointColors> {
  const port = deps.port;
  const colorBy = view.colorBy;
  // Everything NOT selected is muted; with nothing selected, nothing is muted
  // and the whole tissue reads normally (the CosMx highlight-vs-mute rule).
  const muted = mutedFromSelection(selection);

  // One colour, the cells' too ("Single colour").
  if (!colorBy && view.cellColorMode === 'single') {
    return encodeCategorical(new Uint16Array(dataset.observations.count), {
      colors: [view.cellSingleColor],
      opacity: view.opacity,
      muted,
    });
  }
  if (!port || !colorBy) {
    // Genuinely uniform: one broadcast tuple, so a flat 84k-observation view
    // does not allocate a colour per point.
    if (!muted && view.opacity >= 1) return SPATIAL_NEUTRAL_COLOR;
    // Not uniform — the opacity control or a selection varies the alpha, so it
    // has to be per-point. Returning the constant tuple here is what made the
    // Opacity slider do nothing in the default state, which is the state anyone
    // lands in before picking a colour source.
    return encodeCategorical(new Uint16Array(dataset.observations.count), {
      colors: [SPATIAL_NEUTRAL_HEX],
      opacity: view.opacity,
      muted,
    });
  }

  if (colorBy.kind === 'column') {
    const column: SpatialColumn = await port.getColumn(colorBy.name);
    if (isCategoricalColumn(column)) {
      const rgba = encodeCategorical(column.codes, {
        colors: categoryColorsFor(colorBy.name, column.meta, view.groupColors),
        opacity: view.opacity,
        muted,
      });
      // Groups switched off in the Cells panel hide their dots too, when the dots are
      // coloured by that same grouping.
      const groupColumn = cellTypeColumnFor(dataset, view);
      if (view.hiddenGroups?.length && groupColumn === colorBy.name) {
        const off = new Set(view.hiddenGroups);
        const hide = column.meta.categories.map((c) => off.has(c));
        for (let i = 0; i < column.codes.length; i++) {
          const c = column.codes[i];
          if (c !== NO_CATEGORY && hide[c]) rgba[4 * i + 3] = 0;
        }
      }
      return rgba;
    }
    // A continuous column may carry its own log hint (counts); the view's
    // toggle wins once the user has set it.
    return markerContinuousColors(deps, column.values, view, muted);
  }

  const values = await port.getFeatureVector(colorBy.name);
  return markerContinuousColors(deps, values, view, muted);
}

/** Continuous values → RGBA through the active colormap and a clipped window. */
export function markerContinuousColors(
  deps: Pick<MarkerStyleDeps, 'lut' | 'windows'>,
  values: Float32Array,
  view: SpatialViewState,
  muted: Uint8Array | null = null,
): Float32Array {
  return encodeSpatialContinuous(values, view, deps.lut(view), deps.windows, muted);
}
