import type { SpatialEmbeddingMeta } from '../../contracts/spatial-dataset.contract';
import type { OmicsChartKind } from '../../implementations/plotly/omics-trace-builders';

/**
 * The spatial charts' kind catalogue and the prose that explains each chart: pure
 * functions of what is charted, so none of the ~150 lines of text sit in the component and
 * each sentence is testable on its own.
 */

/** A chart kind as the kind picker offers it. */
export interface ChartKindOption {
  label: string;
  value: OmicsChartKind;
}

/** What a continuous value can be drawn as. */
export const CONTINUOUS_KINDS: readonly ChartKindOption[] = [
  { label: 'Histogram', value: 'histogram' },
  { label: 'Violin', value: 'violin' },
  { label: 'Box', value: 'box' },
];

/** What a categorical column can be drawn as: a category code is a label, not a magnitude,
 *  so a histogram of it would be meaningless — what it has is a frequency distribution. */
export const CATEGORICAL_KINDS: readonly ChartKindOption[] = [
  { label: 'Counts', value: 'counts' },
];

/** Available whatever the map is coloured by: the heatmap's subject is a GENE LIST crossed
 *  with a grouping, not the active colour source. */
export const ALWAYS_KINDS: readonly ChartKindOption[] = [
  { label: 'Heatmap', value: 'heatmap' },
];

/**
 * Offered only when the dataset publishes an embedding to draw. Labelled for what it is
 * rather than for one instance of it: this view draws whatever embedding the dataset
 * publishes — a UMAP, a PCA, a t-SNE — and calling the tab "UMAP" while it showed a PCA
 * would be a lie the picker beneath it immediately contradicts.
 */
export const EMBEDDING_KINDS: readonly ChartKindOption[] = [
  { label: 'Embedding', value: 'embedding' },
];

/**
 * The kinds the active subject can be drawn as. An embedding is a property of the DATASET,
 * not of the colour source, so it is offered whenever one is published and never
 * otherwise — a tab that draws nothing is worse than an absent one.
 */
export function chartKindOptions(categorical: boolean, hasEmbeddings: boolean): ChartKindOption[] {
  return [
    ...(categorical ? CATEGORICAL_KINDS : CONTINUOUS_KINDS),
    ...ALWAYS_KINDS,
    ...(hasEmbeddings ? EMBEDDING_KINDS : []),
  ];
}

/**
 * What the chart on screen actually shows, and what it cannot be read for.
 *
 * Shown on hover from a `?` beside the tabs. Each of these plots answers a different
 * question and two of them are routinely over-read — a UMAP's distances and a heatmap's
 * unscaled colours — so the caveat is part of the explanation rather than a footnote.
 *
 * HTML, because the tooltip renders with `[escape]="false"`: a paragraph and a caveat read
 * as two thoughts, and a single run-on line is skipped rather than read.
 */
export function kindHelp(kind: OmicsChartKind, embedding: Pick<SpatialEmbeddingMeta, 'name' | 'label'> | null): string {
  switch (kind) {
    case 'counts':
      return '<b>Counts</b> — how many observations fall in each category of the column '
        + 'the map is coloured by, largest first.<br><br>A category code is a label, not '
        + 'a magnitude, so a frequency is the only distribution it has: there is no '
        + 'histogram of a cell type.';
    case 'histogram':
      return '<b>Histogram</b> — how the active value is distributed over all '
        + 'observations.<br><br>With a selection, it is overlaid on the full '
        + 'distribution rather than replacing it, so you can see where the selected '
        + 'cells sit within the whole.';
    case 'violin':
      return '<b>Violin</b> — the active value\'s distribution within each category of '
        + 'the grouping column, drawn as a smoothed density.<br><br>Shows shape a box '
        + 'plot hides: two groups with the same median can be one peak or two.';
    case 'box':
      return '<b>Box</b> — median, quartiles and range of the active value within each '
        + 'category of the grouping column.<br><br>Compact and comparable across many '
        + 'groups, at the cost of hiding whether a group is bimodal.';
    case 'heatmap':
      return '<b>Heatmap</b> — mean expression of each picked gene within each group: '
        + 'genes down, groups across.<br><br>Each gene is <b>z-scored across the '
        + 'groups</b> by default, so a colour says "above or below this gene\'s own '
        + 'average", not "highly expressed". Without that one loud gene saturates the '
        + 'scale and the rest of the panel reads as blank. Turning it off compares '
        + 'genes on their raw scale instead.';
    case 'embedding':
      return embeddingHelp(embedding);
    default:
      return '';
  }
}

/**
 * What the embedding on screen is, and how far its geometry can be trusted.
 *
 * Per METHOD, because that is the part people get wrong: a PCA's axes are ordered and
 * measurable while a UMAP's are neither, and the same picture read the two ways supports
 * opposite conclusions.
 */
export function embeddingHelp(embedding: Pick<SpatialEmbeddingMeta, 'name' | 'label'> | null): string {
  const shared = '<br><br>Every cell is in all views at once: lasso a group here and '
    + 'those cells light up on the tissue, because both read the same selection.';
  const name = (embedding?.label ?? embedding?.name ?? '').toLowerCase();
  if (name.includes('pca')) {
    return '<b>PCA</b> — a <b>linear</b> projection onto the directions of greatest '
      + 'variance, in order.<br><br>Alone among these, its axes mean something '
      + 'measurable: each reports the share of total variance it explains, which is why '
      + 'the labels carry a percentage. Distances are real, and a low percentage tells '
      + 'you the picture is a thin slice of the variation.' + shared;
  }
  if (name.includes('t-sne') || name.includes('tsne')) {
    return '<b>t-SNE</b> — cells placed so that close neighbours in expression stay '
      + 'close.<br><br>Stricter about local neighbourhoods than UMAP and less '
      + 'trustworthy about anything global: it tends to spread clusters into '
      + 'evenly-sized islands whose sizes and separations mean little. Read which cells '
      + 'group together, not how far apart the groups are.' + shared;
  }
  return '<b>UMAP</b> — cells placed so that close neighbours in expression stay '
    + 'close.<br><br>The axes are arbitrary: unordered, unitless, and reproducible only '
    + 'up to a rotation, which is why they carry no percentage. Read which cells group '
    + 'together and which groups touch; do not read the distance between distant '
    + 'clusters, or the direction of an axis.' + shared;
}

/** What the embedding view is showing, said plainly. */
export function embeddingNote(
  meta: Pick<SpatialEmbeddingMeta, 'name' | 'label' | 'derived' | 'params'> | null,
  coloured: boolean,
  selectionCount: number,
): string {
  if (!meta) return 'This dataset publishes no embedding.';
  // A derived embedding says so, and says HOW when the parameters are known: a t-SNE or
  // UMAP at different settings is a different picture of the same cells, so "computed
  // here" alone leaves a reader unable to reproduce or compare it.
  const derived = meta.derived
    ? ` Computed here${meta.params ? ` (${meta.params})` : ''}, not published with the dataset.`
    : '';
  const colour = coloured
    ? ' Coloured to match the map.'
    : ' Colour the map by a categorical column to colour these points.';
  const sel = selectionCount > 0 ? ` ${selectionCount.toLocaleString()} selected are highlighted.` : '';
  return `${meta.label ?? meta.name}.${colour}${sel}${derived}`;
}

/** What the heatmap is showing, as {@link heatmapNote} says it. */
export interface HeatmapNoteState {
  geneCount: number;
  selectionCount: number;
  zScore: boolean;
  /** Columns the cap dropped from the last render. */
  hidden: number;
  groupBy: string | null;
  /** The grouped view's column cap. */
  maxColumns: number;
  /** Up to this many selected cells, each is its own column. */
  cellColumns: number;
}

/** What the heatmap is currently showing, said plainly. */
export function heatmapNote(s: HeatmapNoteState): string {
  if (s.geneCount === 0) return 'Pick one or more genes for the rows.';
  const perCell = s.selectionCount > 0 && s.selectionCount <= s.cellColumns;
  if (perCell) {
    return `One column per selected cell (${s.selectionCount}). `
      + 'Mean expression per cell, so the columns are cells rather than classes.';
  }
  const scope = s.selectionCount > 0 ? 'the selected cells' : 'all cells';
  const scaled = s.zScore
    ? ' Each gene is z-scored across the columns, so the colour is above or below that gene\'s own average.'
    : ' Raw means, so a highly-expressed gene dominates the scale.';
  // Saying so matters: without it the panel looks like the whole column.
  const capped = s.hidden > 0
    ? ` Showing the ${s.maxColumns} strongest of ${s.maxColumns + s.hidden}, `
      + 'ranked by the largest value any picked gene reaches.'
    : '';
  return `Mean expression of each gene within each ${s.groupBy ?? 'group'}, over ${scope}.${scaled}${capped}`;
}
