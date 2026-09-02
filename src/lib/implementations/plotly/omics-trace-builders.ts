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

export type OmicsChartKind = 'histogram' | 'violin' | 'box';

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
