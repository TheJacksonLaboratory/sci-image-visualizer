/**
 * The `plotly.js-dist-min` v3 surface SIV uses — declared here instead of depending on
 * `@types/plotly.js-dist-min`, which types the v2 API against the v3 runtime (review REPO-15).
 *
 * Deliberately small: the functions SIV calls, the element events it binds, and the shape types
 * `ShapeSelection` implements. Trace, layout and config objects are attribute bags that plotly.js
 * validates at runtime (its full schema is not worth mirroring); add a member here when SIV starts
 * using it.
 *
 * Wired in through `paths` in tsconfig.json (type resolution only: the emitted code, and the
 * published `.d.ts`, still import `plotly.js-dist-min`). Not an ambient `declare module`, which
 * the library build would not see unless some compiled file referenced it.
 */
/** A plot target: the element, or its id. */
export type Root = string | HTMLElement;

/** One trace's attributes (`type`, `x`, `z`, `colorscale`, …). */
export interface Data {
  [attribute: string]: unknown;
}
/** Layout attributes, or a `relayout` update (dotted keys such as `'xaxis.range'` allowed). */
export interface Layout {
  [attribute: string]: unknown;
}
/** Plot config (`displaylogo`, `responsive`, `modeBarButtonsToRemove`, …). */
export interface Config {
  [option: string]: unknown;
}

/** A div Plotly has drawn into. */
export interface PlotlyHTMLElement extends HTMLElement {
  data?: Data[];
  layout?: Layout;
  on(event: string, listener: (event?: unknown) => void): void;
  removeAllListeners(event: string): void;
}

export declare function newPlot(
  root: Root,
  data: Data[],
  layout?: Layout,
  config?: Config,
): Promise<PlotlyHTMLElement>;
export declare function react(
  root: Root,
  data: Data[],
  layout?: Layout,
  config?: Config,
): Promise<PlotlyHTMLElement>;
export declare function relayout(root: Root, update: Layout): Promise<PlotlyHTMLElement>;
export declare function restyle(root: Root, update: Data, traces?: number | number[]): Promise<PlotlyHTMLElement>;
export declare function redraw(root: Root): Promise<PlotlyHTMLElement>;
export declare function purge(root: Root): void;
export declare function downloadImage(
  root: Root,
  opts: { format: 'png' | 'jpeg' | 'webp' | 'svg'; filename?: string; width?: number; height?: number },
): Promise<string>;
export declare const Plots: { resize(root: Root): Promise<void> };

// ── Shape types (`ShapeSelection implements Shape`) ──────────────────────
export type Datum = string | number | Date | null;
export type XAxisName = `x${'' | number}`;
export type YAxisName = `y${'' | number}`;

export interface Font {
  color: string;
  family: string;
  size: number;
  weight: number | 'normal' | 'bold';
  style: 'normal' | 'italic';
}
export interface ShapeLine {
  color: string;
  width: number;
  dash: string;
}
export interface ShapeLabel {
  font: Partial<Font>;
  padding: number;
  text: string;
  textangle: 'auto' | number;
  textposition:
    | 'top left'
    | 'top center'
    | 'top right'
    | 'middle left'
    | 'middle center'
    | 'middle right'
    | 'bottom left'
    | 'bottom center'
    | 'bottom right'
    | 'start'
    | 'middle'
    | 'end';
  texttemplate: string;
  xanchor: 'auto' | 'left' | 'center' | 'right';
  yanchor: 'top' | 'middle' | 'bottom';
}
export interface Shape {
  visible: boolean | 'legendonly';
  layer: 'below' | 'above';
  type: 'rect' | 'circle' | 'line' | 'path';
  path: string;
  xref: 'paper' | XAxisName;
  xsizemode: 'scaled' | 'pixel';
  xanchor: number | string;
  yref: 'paper' | YAxisName;
  ysizemode: 'scaled' | 'pixel';
  yanchor: number | string;
  x0: Datum;
  y0: Datum;
  x1: Datum;
  y1: Datum;
  fillcolor: string;
  name: string;
  templateitemname: string;
  opacity: number;
  line: Partial<ShapeLine>;
  label: Partial<ShapeLabel>;
  showlegend: boolean;
  legendgroup: string;
  legendgrouptitle: { text: string; font?: Partial<Font> };
  legendrank: number;
  editable?: boolean;
}
