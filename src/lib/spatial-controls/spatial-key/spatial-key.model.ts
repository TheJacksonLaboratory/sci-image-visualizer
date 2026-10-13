import type { ISpatialControls } from '../../contracts/visualizer.contract';
import type { SpatialDataset } from '../../contracts/spatial-dataset.contract';
import type { ColormapNode, SpatialViewState } from '../../contracts/display-types';
import { continuousColorBarCss } from '../../spatial/spatial-panel-model';
import { Supersede } from '../../util/supersede';

/** One legend row for a categorical colouring. */
export interface SpatialLegendEntry {
  label: string;
  color: string;
}

/**
 * The key for the active colouring: a categorical legend, or a continuous colour bar.
 *
 * Built with the SAME functions the renderer uses (`categoryColors` → the renderer's
 * resolved category colours, `spatialContinuousLut`), so the key cannot drift from what is
 * on screen. Kept by the dialog rather than by `<spatial-key>`: whether the colouring is
 * categorical decides which knobs the rest of the panel offers, whether or not the key
 * itself is on screen.
 */
export class SpatialKeyModel {
  /** Categorical key, or null when the active colouring is continuous (or none). */
  legend: SpatialLegendEntry[] | null = null;
  /** CSS gradient for a continuous colouring, or null when categorical (or none). */
  colorBarCss: string | null = null;

  /** Latest wins: a slower earlier column would paint its palette into the legend for the
   *  column now selected. */
  private readonly load = new Supersede();

  /** @param run where async results are applied — the owner's `NgZone.run`. */
  constructor(private readonly run: (fn: () => void) => void = (fn) => fn()) {}

  /** True when the active colouring is a categorical column. */
  get isCategorical(): boolean {
    return this.legend !== null;
  }

  /** Rebuild the legend or colour bar for `view`'s colouring. */
  async refresh(
    controls: ISpatialControls | null,
    dataset: SpatialDataset | null,
    view: Pick<SpatialViewState, 'colorBy' | 'continuousColormap'>,
    colormap: ColormapNode | null,
    reverse: boolean,
  ): Promise<void> {
    const by = view.colorBy;
    if (!by || !controls) {
      // A legend still loading for the colouring just cleared must not land after it.
      this.load.cancel();
      this.legend = null;
      this.colorBarCss = null;
      return;
    }
    const meta = by.kind === 'column' ? dataset?.columns.find((c) => c.name === by.name) : undefined;
    const current = this.load.next();
    if (meta?.kind === 'categorical') {
      try {
        const colors = await controls.categoryColors(by.name);
        if (!current()) return;
        this.run(() => {
          this.legend = meta.categories.map((label, i) => ({ label, color: colors[i] }));
          this.colorBarCss = null;
        });
      } catch {
        if (!current()) return;
        // The column's values may not have loaded yet; leave the key empty rather than
        // showing a legend that might not match the render.
        this.run(() => {
          this.legend = null;
          this.colorBarCss = null;
        });
      }
      return;
    }
    // Continuous (a numeric column or a gene): a colour bar from the same LUT.
    this.legend = null;
    this.colorBarCss = continuousColorBarCss(colormap?.data?.value, reverse, view.continuousColormap);
  }
}
