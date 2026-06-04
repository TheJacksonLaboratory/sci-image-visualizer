import { PlotlyService } from './plotly.service';
import { IRegionOverlay, RegionToolMode } from '../../contracts/region-overlay.contract';

/**
 * Plotly implementation of {@link IRegionOverlay}.
 *
 * Plotly renders region shapes natively in its plot layout and edits them via
 * its own drag modes, so this adapter is thin: it maps the neutral
 * {@link RegionToolMode} onto Plotly drag modes and lets Plotly draw. `redraw`
 * is a no-op because Plotly re-renders its shapes itself on relayout.
 *
 * It is the symmetric counterpart to {@link OsdRegionOverlay}: both render the
 * same shared `IRegionStore`, each onto its own backend's canvas.
 */
export class PlotlyRegionOverlay implements IRegionOverlay {

  constructor(private plotly: PlotlyService) {}

  setMode(mode: RegionToolMode): void {
    // 'select' is a neutral mode for Plotly (no drag mode); region selection is
    // driven by the table / active-shape sampling, so just clear the drag mode.
    const dragMode =
      mode === 'drawrect' ? 'drawrect' :
      mode === 'drawclosedpath' ? 'drawclosedpath' :
      mode === 'drawopenpath' ? 'drawopenpath' :
      false;
    this.plotly.setDragMode(dragMode);
  }

  redraw(): void { /* Plotly re-renders its shapes natively on relayout */ }

  /** Bezier regions are an OpenSeadragon-only feature (Plotly has no native
   *  curved-shape rendering), so this is a no-op here. */
  setSelectedBezier(_bezier: boolean): void { /* OSD-only */ }

  destroy(): void { /* nothing to tear down — shapes live in the Plotly layout */ }
}
