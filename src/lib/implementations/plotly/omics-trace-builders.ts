import { NO_CATEGORY } from '../../contracts/spatial-dataset.contract';

/**
 * Plotly traces for the 1-D distribution charts over spatial-omics values:
 * histogram, violin and box.
 *
 * Pure, like `plotly-trace-builders.ts` — and deliberately SEPARATE from it,
 * because that module's `TraceBuildInput` is image-matrix shaped (`frames`,
 * `width`, `ratios`, `trueImageSize`) and cannot express "one value per
 * observation". Forcing the two together would make both worse.
 *
 * Violin and box need no bundling work: `plotly.js-dist-min` is the full
 * distribution and already carries both trace types.
 */

export type OmicsChartKind = 'histogram' | 'violin' | 'box' | 'counts' | 'heatmap' | 'umap';

/** Per-observation grouping for a violin/box, or an overlaid histogram. */
export interface OmicsGrouping {
  codes: Uint16Array;
  categories: string[];
  /** `#rrggbb` per category, index-aligned — the same colours the map uses. */
  colors: string[];
}

export interface OmicsTraceInput {
  /** The values being charted (an annotation column or a gene vector). */
  values: Float32Array;
  /** Axis label for the value — the column or gene name. */
  name: string;
  group?: OmicsGrouping | null;
  /** `1` marks a selected observation. When present, the charts narrow to it. */
  selection?: Uint8Array | null;
  /** Plot `log1p(value)` instead of the raw value. */
  log?: boolean;
  /** Colour for the ungrouped trace. */
  color?: string;
}

const DEFAULT_COLOR = '#0072B2';
/** Plotly renders every point of a violin/box; past this we thin the input.
 *  84k cells x a violin per category is otherwise seconds of layout. */
const MAX_POINTS_PER_TRACE = 20_000;

/** Finite values only, optionally log-scaled and restricted to a selection. */
function prepare(input: OmicsTraceInput, restrict: Uint8Array | null): number[] {
  const { values, log } = input;
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (restrict && !restrict[i]) continue;
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    out.push(log ? Math.log1p(Math.max(0, v)) : v);
  }
  return out;
}

/** Evenly thin a sample to `max` points, preserving its distribution. */
function thin(values: number[], max = MAX_POINTS_PER_TRACE): number[] {
  if (values.length <= max) return values;
  const step = values.length / max;
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(values[Math.floor(i * step)]);
  return out;
}

/** Values per category, finite and optionally selection-restricted. */
function byCategory(
  input: OmicsTraceInput, group: OmicsGrouping, restrict: Uint8Array | null,
): number[][] {
  const buckets: number[][] = group.categories.map(() => []);
  const { values, log } = input;
  for (let i = 0; i < values.length; i++) {
    if (restrict && !restrict[i]) continue;
    const code = group.codes[i];
    // NO_CATEGORY has no bucket by definition; an out-of-range code would
    // otherwise silently land in the wrong one.
    if (code === NO_CATEGORY || code >= buckets.length) continue;
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    buckets[code].push(log ? Math.log1p(Math.max(0, v)) : v);
  }
  return buckets;
}

/** True when the selection actually restricts anything. */
function activeSelection(selection: Uint8Array | null | undefined): Uint8Array | null {
  if (!selection) return null;
  for (let i = 0; i < selection.length; i++) if (selection[i]) return selection;
  return null;
}

/**
 * Traces for one chart kind.
 *
 * - **histogram** — the full distribution, plus an overlaid *Selected* trace
 *   when a selection exists, so the two are directly comparable. That
 *   comparison is the whole point of linking the chart to the map.
 * - **violin / box** — one per category when grouped, otherwise a single trace.
 *   These narrow TO the selection rather than overlaying it: a violin per
 *   category per selection state is unreadable.
 */
export function buildOmicsTraces(kind: OmicsChartKind, input: OmicsTraceInput): unknown[] {
  const selection = activeSelection(input.selection);
  const color = input.color ?? DEFAULT_COLOR;

  if (kind === 'histogram') {
    const traces: unknown[] = [{
      type: 'histogram',
      x: prepare(input, null),
      name: 'All',
      marker: { color, line: { width: 0 } },
      opacity: selection ? 0.55 : 1,
      hovertemplate: '%{y} obs<br>%{x}<extra>All</extra>',
    }];
    if (selection) {
      traces.push({
        type: 'histogram',
        x: prepare(input, selection),
        name: 'Selected',
        marker: { color: '#D55E00', line: { width: 0 } },
        opacity: 0.85,
        hovertemplate: '%{y} obs<br>%{x}<extra>Selected</extra>',
      });
    }
    return traces;
  }

  const type = kind; // 'violin' | 'box'
  const shared = {
    type,
    ...(type === 'violin'
      ? { box: { visible: true }, meanline: { visible: true }, points: false as const }
      : { boxpoints: false as const }),
  };

  if (input.group) {
    const buckets = byCategory(input, input.group, selection);
    return buckets
      // Drop empty categories: an empty violin renders as a stray tick with a
      // label, which reads as data.
      .map((values, i) => ({ values, i }))
      .filter((b) => b.values.length > 0)
      .map((b) => ({
        ...shared,
        y: thin(b.values),
        name: input.group!.categories[b.i],
        marker: { color: input.group!.colors[b.i] ?? color },
        line: { color: input.group!.colors[b.i] ?? color },
      }));
  }

  const values = thin(prepare(input, selection));
  if (values.length === 0) return [];
  return [{
    ...shared,
    y: values,
    name: selection ? 'Selected' : 'All',
    marker: { color },
    line: { color },
  }];
}

/** Layout for a chart kind — axis titles reflect the log toggle. */
export function omicsLayout(kind: OmicsChartKind, input: OmicsTraceInput): unknown {
  const label = input.log ? `log1p(${input.name})` : input.name;
  const base = {
    margin: { t: 10, r: 10, b: 40, l: 52 },
    autosize: true,
    showlegend: kind === 'histogram' && !!activeSelection(input.selection),
    legend: { orientation: 'h', y: 1.12, x: 0 },
    bargap: 0.02,
    hovermode: 'closest',
  };
  if (kind === 'histogram') {
    return {
      ...base,
      barmode: 'overlay',
      xaxis: { title: { text: label } },
      yaxis: { title: { text: 'observations' } },
    };
  }
  return {
    ...base,
    xaxis: { automargin: true },
    yaxis: { title: { text: label }, zeroline: false },
  };
}

/** Whether a chart kind needs a categorical grouping to be worth showing. */
export function benefitsFromGrouping(kind: OmicsChartKind): boolean {
  return kind === 'violin' || kind === 'box';
}

/** Categories shown as bars before the tail is folded into one "other". */
const MAX_COUNT_BARS = 25;

export interface OmicsCountInput {
  /** The categorical being counted, with the map's own colours. */
  group: OmicsGrouping;
  /** `1` marks a selected observation; when present the bars show the selection
   *  against the total. */
  selection?: Uint8Array | null;
  /** Bars before the tail is aggregated. */
  max?: number;
}

/** Per-category counts, biggest first, with the tail folded into one bar. */
export function countByCategory(
  input: OmicsCountInput,
): { labels: string[]; colors: string[]; totals: number[]; selected: number[] } {
  const { codes, categories, colors } = input.group;
  const selection = activeSelection(input.selection);
  const totals = new Float64Array(categories.length);
  const selected = new Float64Array(categories.length);
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === NO_CATEGORY || c >= categories.length) continue;
    totals[c]++;
    if (selection && selection[i]) selected[c]++;
  }

  const ranked = Array.from(totals, (n, c) => ({ c, n }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n);
  const max = input.max ?? MAX_COUNT_BARS;
  const head = ranked.slice(0, max);
  const tail = ranked.slice(max);

  const out = {
    labels: head.map((r) => categories[r.c]),
    colors: head.map((r) => colors[r.c] ?? DEFAULT_COLOR),
    totals: head.map((r) => r.n),
    selected: head.map((r) => selected[r.c]),
  };
  // The tail is aggregated rather than dropped: 338 subclasses do not fit a
  // readable axis, but silently showing 25 of them would misstate the whole.
  if (tail.length) {
    out.labels.push(`other (${tail.length} categories)`);
    out.colors.push('#9e9e9e');
    out.totals.push(tail.reduce((a, r) => a + r.n, 0));
    out.selected.push(tail.reduce((a, r) => a + selected[r.c], 0));
  }
  return out;
}

/**
 * Bars of per-category cell counts — the distribution a CATEGORICAL colour
 * source has.
 *
 * A histogram of a category code would be meaningless (the codes are labels, not
 * magnitudes), but "how many cells per class" is a real question, and the same one
 * the legend implies without answering. Horizontal, because taxonomy labels are
 * long, and sorted, because rank is what the chart is read for.
 */
export function buildCountTraces(input: OmicsCountInput): unknown[] {
  const { labels, colors, totals, selected } = countByCategory(input);
  const selection = activeSelection(input.selection);
  // Plotly draws the first category at the BOTTOM of a horizontal axis, so
  // reverse to put the biggest bar at the top where the eye starts.
  const flip = <T>(a: T[]): T[] => a.slice().reverse();
  const traces: unknown[] = [{
    type: 'bar',
    orientation: 'h',
    x: flip(totals),
    y: flip(labels),
    name: selection ? 'All' : 'Cells',
    marker: { color: flip(colors) },
    opacity: selection ? 0.45 : 1,
    hovertemplate: '%{x} obs<extra>%{y}</extra>',
  }];
  if (selection) {
    traces.push({
      type: 'bar',
      orientation: 'h',
      x: flip(selected),
      y: flip(labels),
      name: 'Selected',
      marker: { color: flip(colors) },
      hovertemplate: '%{x} obs<extra>%{y} · selected</extra>',
    });
  }
  return traces;
}

export function countsLayout(input: OmicsCountInput & { name: string }): unknown {
  const { labels } = countByCategory(input);
  return {
    // Room for the labels, and a height that grows with the bar count so 25
    // categories are not crushed into the same box as 3.
    margin: { t: 10, r: 10, b: 40, l: 8 },
    autosize: true,
    // Overlaid, not stacked: the selected bar reads against the total it came
    // from, which is the comparison being made.
    barmode: 'overlay',
    showlegend: !!activeSelection(input.selection),
    legend: { orientation: 'h', y: 1.12, x: 0 },
    hovermode: 'closest',
    xaxis: { title: { text: 'observations' } },
    yaxis: { automargin: true, ticklabelposition: 'inside', tickfont: { size: 10 } },
    height: Math.max(180, 22 * labels.length + 60),
  };
}

// ── heatmap ─────────────────────────────────────────────────────────────────

/**
 * Genes × groups mean expression, as a Plotly heatmap.
 *
 * The matrix itself is computed by the pure `heatmapMatrix` in
 * `spatial/spatial-heatmap.ts`; this only shapes it for Plotly. Kept in the
 * matrix's own row-major order and flipped once here, because Plotly draws
 * `z[0]` at the BOTTOM of the y axis while the caller lists genes top-down.
 *
 * The colour scale is its own, NOT the map's `continuousColormap`. This is a
 * different quantity — a z-scored mean per group, not a per-cell value — so
 * sharing one scale would invite reading a heatmap cell as if it were a marker
 * colour. Diverging and centred on zero, because after z-scoring the sign is
 * the reading: above or below this gene's average across the groups.
 */
/**
 * An embedding scatter — a UMAP, t-SNE or PCA plane over the same observations.
 *
 * Answers a different question from the map: the map says WHERE a population sits in the tissue,
 * the embedding says which populations there are and how close they are in expression. Read side
 * by side, and selecting in one highlighting the other, is the whole point of having both.
 */
export interface OmicsUmapInput {
  /** Embedding coordinates, index-aligned with the observations. */
  x: Float32Array;
  y: Float32Array;
  /**
   * Third dimension, when the embedding has one.
   *
   * Its presence is what switches the plot to a rotatable 3D scatter. A 3D embedding is
   * always COMPUTED — every embedding published with a spatial dataset is 2D, because a
   * UMAP exists to be looked at — so `derived` is expected alongside it.
   */
  z?: Float32Array;
  /** Axis label stem, e.g. "UMAP" — the axes become "UMAP 1" / "UMAP 2". */
  label: string;
  /** Colour by a categorical column: per-observation codes plus the category names/colours. */
  categories?: {
    codes: Uint16Array;
    names: readonly string[];
    colors: readonly string[];
  };
  /** Marker diameter in px. */
  size?: number;
  /**
   * Selection mask over the observations. When present, unselected points are dimmed rather than
   * dropped: the shape of the whole embedding is the context that makes a selection legible, and
   * removing it would leave a handful of dots floating in an empty plane.
   */
  selection?: Uint8Array;
  /** True when the coordinates were computed here rather than published with the dataset. */
  derived?: boolean;
}

/**
 * Past this many categories, one trace each stops being worth it.
 *
 * A trace per category buys a legend whose entries toggle — click one to isolate a population,
 * which is how these plots are actually read. But Plotly holds per-trace state, and a legend of
 * hundreds of entries is unreadable anyway (the ABC atlas has 338 subclasses), so beyond the cap
 * everything goes into ONE trace with a per-point colour: no legend, but it still draws.
 */
export const UMAP_MAX_LEGEND_CATEGORIES = 40;

/**
 * Categories past which the legend is not DRAWN, though the traces stay split.
 *
 * A legend is only worth its space if it fits. seqFISH's 22 cell types stack into one tall
 * column in a docked panel, overlapping the axis title and running off the bottom — and
 * the colours already match the map, whose own panel lists them, while hover names the
 * category under the cursor. So past this the plot takes the whole panel and the legend
 * is dropped rather than shown badly.
 */
export const UMAP_MAX_LEGEND_SHOWN = 10;

/** Dimming applied to unselected points, matching the map's muted opacity. */
const UMAP_MUTED_OPACITY = 0.15;

const DEFAULT_UMAP_POINT_SIZE = 4;

export function buildUmapTraces(input: OmicsUmapInput): unknown[] {
  const { x, y, categories, selection } = input;
  const n = Math.min(x.length, y.length);
  if (n === 0) return [];
  const z = input.z;
  // `scattergl` for the plane — 10^4-10^6 points, which the SVG renderer would not
  // survive. `scatter3d` for the cloud: WebGL too, but a different trace type with its
  // own scene, which is why a third dimension cannot just be added to the former. It
  // costs more per point, so it suits this scale and not millions.
  const type = z ? 'scatter3d' : 'scattergl';
  const markerSize = z ? Math.max(1, (input.size ?? DEFAULT_UMAP_POINT_SIZE) - 2)
    : (input.size ?? DEFAULT_UMAP_POINT_SIZE);
  const opacityFor = (i: number): number =>
    !selection || selection[i] ? 1 : UMAP_MUTED_OPACITY;

  if (!categories || categories.names.length === 0) {
    return [{
      type,
      mode: 'markers',
      x: Array.from(x.subarray(0, n)),
      y: Array.from(y.subarray(0, n)),
      ...(z ? { z: Array.from(z.subarray(0, n)) } : {}),
      // The OBSERVATION index per point, carried through so a lasso can be turned back
      // into a selection. Plotly reports a selected point by its position within its
      // trace, which is not the observation index once the points are split by category.
      customdata: Array.from({ length: n }, (_, i) => i),
      marker: {
        size: markerSize,
        color: '#4c72b0',
        ...(selection ? { opacity: Array.from({ length: n }, (_, i) => opacityFor(i)) } : {}),
      },
      hoverinfo: 'none',
      showlegend: false,
    }];
  }

  const { codes, names, colors } = categories;
  if (names.length > UMAP_MAX_LEGEND_CATEGORIES) {
    // One trace, per-point colour. Hover still names the category, which is the part that
    // matters; the legend is what is lost.
    return [{
      type,
      mode: 'markers',
      x: Array.from(x.subarray(0, n)),
      y: Array.from(y.subarray(0, n)),
      ...(z ? { z: Array.from(z.subarray(0, n)) } : {}),
      marker: {
        size: markerSize,
        color: Array.from({ length: n }, (_, i) => colors[codes[i]] ?? '#999999'),
        ...(selection ? { opacity: Array.from({ length: n }, (_, i) => opacityFor(i)) } : {}),
      },
      customdata: Array.from({ length: n }, (_, i) => i),
      text: Array.from({ length: n }, (_, i) => names[codes[i]] ?? 'unassigned'),
      hovertemplate: '%{text}<extra></extra>',
      showlegend: false,
    }];
  }

  // One trace per category: the legend entries toggle, so a population can be isolated by
  // clicking rather than by re-colouring the whole plot.
  const buckets: number[][] = names.map(() => []);
  for (let i = 0; i < n; i++) {
    const c = codes[i];
    // NO_CATEGORY, or a code past the list, is unassigned — dropped rather than drawn in a
    // colour that would read as a population of its own.
    if (c < buckets.length) buckets[c].push(i);
  }
  return buckets
    .map((idx, c) => ({ idx, c }))
    .filter(({ idx }) => idx.length > 0)
    .map(({ idx, c }) => ({
      type,
      mode: 'markers',
      name: names[c],
      x: idx.map((i) => x[i]),
      y: idx.map((i) => y[i]),
      ...(z ? { z: idx.map((i) => z[i]) } : {}),
      // This trace's points ARE a subset, so the observation index has to travel with
      // them; `pointIndex` alone would address the wrong cell.
      customdata: idx,
      marker: {
        size: markerSize,
        color: colors[c] ?? '#999999',
        ...(selection ? { opacity: idx.map(opacityFor) } : {}),
      },
      // Split per category regardless, so hover names it and a future isolate control
      // has something to toggle; only the legend's VISIBILITY depends on the count.
      showlegend: names.length <= UMAP_MAX_LEGEND_SHOWN,
      hovertemplate: `${names[c]}<extra></extra>`,
    }));
}

export function umapLayout(input: OmicsUmapInput): unknown {
  const stem = input.label || 'UMAP';
  const derivedNote = input.derived
    ? {
      // Said on the plot, not just in a tooltip: a recomputed embedding is a different
      // picture from the published one, and a reader comparing against a paper's figure
      // needs to know. For a 3D embedding it is always true — none are published.
      annotations: [{
        text: 'computed here, not published with the dataset',
        showarrow: false, xref: 'paper', yref: 'paper', x: 0, y: 1.04,
        xanchor: 'left', font: { size: 10, color: '#888888' },
      }],
    }
    : {};

  if (input.z) {
    return {
      autosize: true,
      // A 3D scene has no margins to speak of; the axes live inside it.
      margin: { l: 0, r: 0, t: input.derived ? 24 : 0, b: 0 },
      scene: {
        xaxis: { title: { text: `${stem} 1` } },
        yaxis: { title: { text: `${stem} 2` } },
        zaxis: { title: { text: `${stem} 3` } },
        // Equal aspect for the same reason as the plane: the axes carry no units, so
        // distances only compare if all three are scaled alike. `data` keeps the cloud's
        // own proportions instead of stretching it into the cube.
        aspectmode: 'data',
      },
      showlegend: false,
      hovermode: 'closest',
      ...derivedNote,
    };
  }

  return {
    autosize: true,
    // Bottom margin carries the legend: laid out BELOW the plot rather than beside it.
    // A vertical legend of 22 cell types took half a docked panel's width and squeezed
    // the embedding into a corner — and the shapes of the clusters are the thing being
    // read here, while the labels are a lookup.
    margin: {
      l: 44,
      r: 8,
      t: input.derived ? 24 : 8,
      // Room for the legend only when one is drawn; otherwise the axis title alone.
      b: (input.categories?.names.length ?? 0) > 0
        && (input.categories?.names.length ?? 0) <= UMAP_MAX_LEGEND_SHOWN ? 64 : 40,
    },
    // Equal aspect: an embedding's axes carry no units, so distances are only comparable if the
    // two are scaled alike. Stretching one axis to fill the panel invents structure.
    xaxis: { title: { text: `${stem} 1` }, zeroline: false, ticks: 'outside' },
    yaxis: {
      title: { text: `${stem} 2` }, zeroline: false, ticks: 'outside',
      scaleanchor: 'x', scaleratio: 1,
    },
    legend: {
      orientation: 'h',
      itemsizing: 'constant',
      font: { size: 9 },
      yanchor: 'top', y: -0.16, xanchor: 'left', x: 0,
    },
    hovermode: 'closest',
    ...derivedNote,
  };
}

export interface OmicsHeatmapInput {
  rows: string[];
  cols: string[];
  /** `rows.length × cols.length`, row-major; `NaN` where nothing was measured. */
  values: Float32Array;
  /** Cells behind each column, for the hover. */
  counts?: Uint32Array;
  /** True when `values` are z-scores, which sets the scale and the labels. */
  zScored?: boolean;
  /** Column axis title — the grouping column's name, or "cell". */
  groupLabel?: string;
}

/** Diverging, centred: after z-scoring, the sign carries the meaning. */
const HEATMAP_DIVERGING: [number, string][] = [
  [0, '#2166AC'],
  [0.5, '#F7F7F7'],
  [1, '#B2182B'],
];
/** Sequential, for raw means where zero is the bottom rather than the middle. */
const HEATMAP_SEQUENTIAL: [number, string][] = [
  [0, '#F7FBFF'],
  [0.5, '#6BAED6'],
  [1, '#08306B'],
];

export function buildHeatmapTraces(input: OmicsHeatmapInput): unknown[] {
  const { rows, cols, values, counts } = input;
  if (rows.length === 0 || cols.length === 0) return [];
  // Plotly wants z as an array of rows, bottom-up; NaN renders as a gap.
  const z: (number | null)[][] = [];
  for (let r = rows.length - 1; r >= 0; r--) {
    const line: (number | null)[] = [];
    for (let c = 0; c < cols.length; c++) {
      const v = values[r * cols.length + c];
      line.push(Number.isFinite(v) ? v : null);
    }
    z.push(line);
  }
  const y = rows.slice().reverse();
  const unit = input.zScored ? 'z' : 'mean';
  // Symmetric about zero when z-scored, so the same magnitude reads the same
  // whichever side of the gene's average it falls on.
  let zmin: number | undefined;
  let zmax: number | undefined;
  if (input.zScored) {
    let peak = 0;
    for (let i = 0; i < values.length; i++) {
      const v = Math.abs(values[i]);
      if (Number.isFinite(v) && v > peak) peak = v;
    }
    zmax = peak > 0 ? peak : 1;
    zmin = -zmax;
  }
  const hover = counts
    ? cols.map((label, c) => `${label} · ${counts[c]} cells`)
    : cols;
  return [{
    type: 'heatmap',
    z,
    x: cols,
    y,
    customdata: z.map(() => hover),
    colorscale: input.zScored ? HEATMAP_DIVERGING : HEATMAP_SEQUENTIAL,
    ...(zmin !== undefined ? { zmin, zmax } : {}),
    // A gap has no colour rather than the scale's bottom: nothing was measured
    // there, which is not the same as a low mean.
    hoverongaps: false,
    colorbar: { title: { text: unit, side: 'right' }, thickness: 10, len: 0.9 },
    hovertemplate: `%{y}<br>%{customdata}<br>${unit} %{z:.2f}<extra></extra>`,
  }];
}

export function heatmapLayout(input: OmicsHeatmapInput): unknown {
  return {
    // Left margin grows with the longest gene name; the labels are the point.
    margin: { t: 10, r: 10, b: 90, l: 8 },
    autosize: true,
    hovermode: 'closest',
    xaxis: { automargin: true, tickangle: -45, tickfont: { size: 10 },
      title: { text: input.groupLabel ?? '' } },
    yaxis: { automargin: true, tickfont: { size: 10 } },
    // Grows with the gene count so 3 rows are not stretched to 20 rows' height.
    height: Math.max(180, 24 * input.rows.length + 110),
  };
}
