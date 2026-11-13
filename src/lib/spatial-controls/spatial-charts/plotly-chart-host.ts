import * as Plotly from 'plotly.js-dist-min';

/** Plotly config: a static-ish analysis chart, not an editable figure. */
export const CHART_CONFIG = {
  displaylogo: false,
  responsive: true,
  modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'],
};

/**
 * Config for the embedding, which unlike the distributions is a plot you SELECT in.
 *
 * The lasso and box-select are kept — drawing round a cluster is how a population gets
 * picked out of a UMAP — and the wheel zooms, because exploring an embedding means zooming
 * into a cluster and reaching for a toolbar button to do it breaks that.
 */
export const EMBEDDING_CONFIG = {
  displaylogo: false,
  responsive: true,
  scrollZoom: true,
  modeBarButtonsToRemove: ['autoScale2d'],
};

/** What a lasso or box selection in a plot reports. */
export interface PlotSelectionHandlers {
  /** The observation indices selected (empty for a selection that caught nothing). */
  selected(indices: number[]): void;
  /** The modebar's deselect, or a plain click on empty space. */
  deselected(): void;
}

/**
 * The view the user has set up on a live plot: a 3D camera, or a zoomed 2D range, and the
 * 2D drag tool they picked in the modebar.
 */
export interface LivePlotView {
  camera?: unknown;
  ranges?: { x: unknown; y: unknown };
  dragmode?: string;
}

/**
 * Plotly I/O for the spatial charts, keyed by the id of the div drawn into: drawing,
 * purging, re-fitting to the container, binding a selection, and reading back the view
 * the user has set up. The only place the charts import Plotly.
 *
 * Remembers whether the last drawn layout fixed its own height, because re-fitting depends
 * on it (see {@link refit}).
 */
export class PlotlyChartHost {
  /**
   * The height the drawn layout asked for, or null where it autosizes. The counts and
   * heatmap layouts size their height to their content — one band per bar, per gene row —
   * while the distribution kinds want to fill whatever height they are given.
   */
  private drawnHeight: number | null = null;

  /**
   * Draws in flight. While one runs, the selection events Plotly emits are its own, not
   * the user's: see {@link bindSelection}.
   */
  private drawing = 0;

  /** Whether the plot on screen fixed its own height. */
  get hasFixedHeight(): boolean {
    return this.drawnHeight !== null;
  }

  /**
   * Draw into `div`, remembering whether this layout fixed its own height.
   *
   * The layout builders return `unknown` on purpose — they keep Plotly's layout types out
   * of the pure module — so the height is read back by narrowing rather than declared.
   * `height` is Plotly's own key, not ours.
   */
  async draw(div: string, traces: unknown, layout: unknown, config: unknown = CHART_CONFIG): Promise<void> {
    const height = (layout as { height?: unknown } | null)?.height;
    this.drawnHeight = typeof height === 'number' ? height : null;
    this.drawing++;
    try {
      await Plotly.react(div, traces as never, layout as never, config as never);
    } finally {
      this.drawing--;
    }
  }

  /** Purge `div`, freeing its plot (and WebGL context); a div with no plot is fine. */
  purge(div: string): void {
    try {
      Plotly.purge(div);
    } catch {
      // Nothing plotted there, or the div is already gone.
    }
  }

  /**
   * Re-fit whatever is plotted in `div` to its container.
   *
   * Plotly does not notice a container resize on its own — its `responsive` option listens
   * for WINDOW resizes only. And `autosize` takes BOTH dimensions from the container, which
   * is right only where the layout did not fix its own height. Measured: autosizing a layout
   * with an explicit height of 500 replaced it with the container's 400. The counts and
   * heatmap layouts size themselves to their row count, so for them the width is set ALONE
   * and the height left to stand.
   */
  refit(div: string): void {
    const el = document.getElementById(div);
    if (!el) return;
    const width = Math.round(el.clientWidth);
    // Zero while the section is collapsed or the dialog is closed; relaying out to a zero
    // box makes Plotly compute a layout it does not recover from.
    if (width <= 0) return;
    try {
      Plotly.relayout(el, this.drawnHeight === null ? { autosize: true } : { width });
    } catch {
      // Nothing plotted yet.
    }
  }

  /**
   * Turn a lasso or box selection in `div` into observation indices.
   *
   * Bound after each draw, and the previous listeners removed first: `Plotly.react`
   * preserves handlers, so re-binding without removing would fire the selection once per
   * redraw the plot had ever had.
   *
   * Events that arrive DURING a draw are ignored. A lasso changes the selection, the
   * selection redraws the plot to dim the rest, and that redraw drops the lasso outline,
   * which Plotly reports as a `plotly_selected` with no points. Taken as the user's, it
   * cleared the selection the lasso had just made, about 50 ms later.
   */
  bindSelection(div: string, handlers: PlotSelectionHandlers): void {
    const el = document.getElementById(div) as Plotly.PlotlyHTMLElement | null;
    if (!el?.on) return;
    el.removeAllListeners?.('plotly_selected');
    el.removeAllListeners?.('plotly_deselect');
    el.on('plotly_selected', (ev) => {
      if (this.drawing > 0) return;
      // A lasso that selects nothing arrives as an event with no points; it is a clear,
      // which is what dragging an empty patch looks like it should do.
      const points = (ev as { points?: readonly unknown[] } | undefined)?.points ?? [];
      const indices: number[] = [];
      for (const p of points) {
        // The observation index rides on `customdata` — see `buildEmbeddingTraces`. A
        // point's index within its trace is not the observation once the points are split
        // by category, so this is the only correct source.
        const id = (p as { customdata?: unknown }).customdata;
        if (typeof id === 'number') indices.push(id);
      }
      if (indices.length === 0) handlers.deselected();
      else handlers.selected(indices);
    });
    el.on('plotly_deselect', () => {
      if (this.drawing > 0) return;
      handlers.deselected();
    });
  }

  /**
   * Drop the selection handlers from a div another chart is about to use.
   *
   * `plotly_deselect` fires on a plain click in ANY Plotly chart, so handlers left bound
   * for an embedding would make the first click on a bar clear the map's selection.
   */
  unbindSelection(div: string): void {
    const el = document.getElementById(div) as Plotly.PlotlyHTMLElement | null;
    if (!el?.removeAllListeners) return;
    el.removeAllListeners('plotly_selected');
    el.removeAllListeners('plotly_deselect');
  }

  /**
   * The view the user has set up on the live plot in `div`, to carry across a redraw.
   *
   * `Plotly.react` resets a 3D scene camera and any zoomed 2D range unless the layout
   * carries them, so selecting a category or recolouring would throw away an orientation
   * that took work to find. A 2D range is returned only once zoomed: passing an autoranged
   * range back would freeze the axes and stop the plot re-fitting when the data changes.
   *
   * The 2D drag tool is carried too. Without it every redraw put the modebar back on Zoom,
   * so after one lasso the next drag zoomed instead of selecting.
   * Null where nothing is drawn yet, or there is nothing to carry.
   */
  liveView(div: string): LivePlotView | null {
    const el = document.getElementById(div);
    const full = (
      el as {
        _fullLayout?: {
          scene?: { camera?: unknown };
          dragmode?: unknown;
          xaxis?: { range?: unknown; autorange?: boolean };
          yaxis?: { range?: unknown; autorange?: boolean };
        };
      } | null
    )?._fullLayout;
    if (!full) return null;
    if (full.scene?.camera) return { camera: full.scene.camera };
    const view: LivePlotView = {};
    const zoomed = full.xaxis?.autorange === false && full.yaxis?.autorange === false;
    if (zoomed && full.xaxis?.range && full.yaxis?.range) {
      view.ranges = { x: full.xaxis.range, y: full.yaxis.range };
    }
    if (typeof full.dragmode === 'string') view.dragmode = full.dragmode;
    return view.ranges || view.dragmode ? view : null;
  }
}
