import * as Plotly from 'plotly.js-dist-min';

import { Region } from '../../models/region';
import { ShapeSelection } from '../../models/shape';
import { RegionStore } from '../../store/region-store.service';
import { PlotUtilities } from '../../plot.utilities';

/** A Plotly graph div, as far as the projection reads it. */
type GraphDiv = HTMLElement & { _fullLayout?: { _activeShapeIndex?: number } };

/** The service state the projection reads. */
export interface ShapeProjectionHost {
  /** The plot div's id ('' before the first plot); it may be another backend's now. */
  plotDiv(): string;
  /** The image on screen (shapes are tagged with it). */
  fileName(): string | undefined;
}

/**
 * Plotly's render projection of the shared RegionStore: `shapes` is the dict
 * array `Plotly.relayout` consumes, kept beside the store. Writes mirror the
 * dicts INTO the store ({@link commitToStore}); image switches and external
 * changes project the store back OUT ({@link syncFromStore}). Also maps the
 * store's selection onto Plotly's `_activeShapeIndex` (the shape with the edit
 * handles) and back.
 */
export class PlotlyShapeProjection {
  /** The render projection: one Plotly shape dict per store region. */
  shapes: any[] = [];
  /** Whether {@link setRegions} saves to the store or only shows transiently. */
  private isRegionSavedOn = true;
  private readonly utils = new PlotUtilities();

  constructor(private readonly host: ShapeProjectionHost, private readonly regionStore: RegionStore) {}

  /** The plot div, live Plotly graph or not (null when none is set). */
  private gd(): GraphDiv | null {
    const id = this.host.plotDiv();
    return id ? document.getElementById(id) as GraphDiv | null : null;
  }

  /** The plot div while it hosts a live Plotly graph, else null: the div stays
   *  set after it was handed to another backend, and Plotly throws on it then. */
  private liveGd(): GraphDiv | null {
    const gd = this.gd();
    return gd?._fullLayout ? gd : null;
  }

  /** Rebuild the dict working-set from the store (after an image switch, or when
   *  regions changed while another backend was rendering). */
  syncFromStore(): void {
    const showLabel = this.regionStore.getShowShapeLabel();
    this.shapes = this.regionStore.getRegions().map((r) => {
      r.filename = this.host.fileName();
      return { ...r.getShape(showLabel) };
    });
  }

  /**
   * Make the shared store authoritative for the current dict working-set: convert
   * the dicts to neutral regions and replace the store's list (the store mints
   * ids, applies class colours, syncs its per-image cache and emits the
   * region-update event). Store-minted ids are written back onto the dicts so the
   * two representations stay aligned. Profile-line ROIs are ordinary regions
   * (tagged `kind: 'profile'`) and round-trip through here too.
   */
  commitToStore(): void {
    const regions = this.shapes.map((s) => Object.assign(new ShapeSelection(), s).getRegion());
    this.regionStore.setRegions(regions, this.regionStore.getShowShapeLabel(), true,
      this.regionStore.getFillColor(), false);
    const stored = this.regionStore.getRegions();
    for (let i = 0; i < this.shapes.length && i < stored.length; i++) {
      if (this.shapes[i].id == null) this.shapes[i].id = stored[i].id;
      if (this.shapes[i].name == null) this.shapes[i].name = stored[i].name;
    }
  }

  /**
   * Apply a `plotly_relayout` event's shape part: in-place edits
   * (`shapes[i].x0`, `shapes[i].path`, …, rounded to whole pixels) and a shape
   * drawn natively on the canvas (a lone `shapes` key — snapped, tagged with
   * the file and, when labels are on, a label object), mirrored into the store.
   */
  applyRelayout(event: Record<string, any>): void {
    let shapesModified = false;
    for (const key of Object.keys(event)) {
      if (!key.startsWith('shapes[')) continue;
      const shapeNumber = +key.split('[')[1].split(']')[0];
      const shapeChange = key.split('.')[1];
      if (this.shapes && this.shapes[shapeNumber]) {
        this.shapes[shapeNumber][shapeChange] = shapeChange === 'path'
          ? this.utils.roundPathCoordinates(event[key])
          : Math.round(+event[key]);
        shapesModified = true;
      }
    }
    if (shapesModified) this.commitToStore();
    if (Object.keys(event).length === 1 && 'shapes' in event) {
      this.shapes = event['shapes'] as any[];
      for (let i = 0; i < this.shapes.length; i++) {
        // A freshly Plotly-drawn shape has no id yet — give it a label object
        // (when labels are on) before the store mints id + default name.
        const isNew = this.shapes[i].id == null;
        this.shapes[i].fileName = this.host.fileName();
        this.shapes[i] = this.utils.snapRegion(this.shapes[i]);
        if (isNew && this.regionStore.getShowShapeLabel()) {
          this.shapes[i].label = {
            text: this.shapes[i].label,
            texttemplate: this.shapes[i].label,
            font: { color: this.regionStore.getShapeColor() },
            textposition: 'top left',
          };
        }
      }
      // Mint ids/names in the store, write them back onto the dicts, and emit.
      this.commitToStore();
    }
  }

  /**
   * Set plot regions through the shared RegionStore (id/name minting,
   * classification colours, append de-duplication, per-image cache and the
   * region-update event all live there), then re-project and render. When
   * `isRegionSaveOn` is false the regions are shown transiently — rendered
   * without altering the stored working-set.
   */
  setRegions(regions: Region[], showRegionLabel?: boolean, isRegionSaveOn?: boolean,
             fillColor?: string, append = false): void {
    const showLabel = showRegionLabel === undefined ? this.regionStore.getShowShapeLabel() : showRegionLabel;
    const save = isRegionSaveOn === undefined ? this.isRegionSavedOn : isRegionSaveOn;
    this.regionStore.setRegions(regions, showRegionLabel, isRegionSaveOn, fillColor, append);
    this.isRegionSavedOn = save;
    if (save) {
      this.syncFromStore();
      this.render();
    } else {
      const dicts = regions.map((r) => {
        r.filename = this.host.fileName();
        return { ...r.getShape(showLabel) };
      });
      const gd = this.liveGd();
      if (gd) void Plotly.relayout(gd, this.relayoutPayload(dicts) as Plotly.Layout);
    }
  }

  /** Push the dict working-set to Plotly (a no-op when another backend owns the div). */
  render(): void {
    const gd = this.liveGd();
    if (!gd) return;
    void Plotly.relayout(gd, this.relayoutPayload(this.shapes.map((s) => ({ ...s }))) as Plotly.Layout);
  }

  /** The shapes of the image on screen, labelled (or not) for display, as fresh dicts. */
  shapesToRedraw(showLabel = this.regionStore.getShowShapeLabel()): any[] {
    const shapesToRedraw: ShapeSelection[] = [];
    for (const shape of this.shapes) {
      if (JSON.stringify(shape.fileName) === JSON.stringify(this.host.fileName())) {
        shape.label = showLabel
          ? {
            text: `${shape.legend}`,
            texttemplate: `${shape.legend}`,
            textposition: 'top left',
            font: { color: `${shape.line.color}` },
          }
          : {};
        shapesToRedraw.push(shape);
      }
    }
    // convert to dict so that plotly recognises the shapes
    return shapesToRedraw.map((s) => ({ ...s }));
  }

  /**
   * Programmatically select regions (or clear with []): the store owns the
   * selection; Plotly's `_activeShapeIndex` points at the last selected shape so
   * it gets the edit handles (Plotly's own active-shape rendering is the only
   * highlight).
   */
  setSelectedShapeIndices(indices: number[]): void {
    const valid = (indices || []).filter((i) => Number.isFinite(i) && i >= 0 && i < this.shapes.length);
    const cleaned = [...new Set(valid)];
    const gd = this.gd();
    if (gd?._fullLayout) {
      gd._fullLayout._activeShapeIndex = cleaned.length > 0 ? cleaned[cleaned.length - 1] : -1;
      try { void Plotly.redraw(gd); } catch { /* noop in tests */ }
    }
    this.regionStore.setSelectedShapeIndices(cleaned);
  }

  /** Select a region by identity, giving its rendered shape the edit handles. */
  selectRegion(region: Region): void {
    this.regionStore.selectRegion(region);
    const idx = this.shapes.findIndex((s) => s.id === region?.id);
    const gd = this.gd();
    if (gd?._fullLayout && idx >= 0) {
      gd._fullLayout._activeShapeIndex = idx;
      try { void Plotly.redraw(gd); } catch { /* noop in tests */ }
    }
  }

  /**
   * Read Plotly's `_activeShapeIndex` and push it as the selection. Plotly fires
   * no dedicated active-shape event for clicks, so this is sampled after a
   * relayout and a click. The store no-ops when the selection is unchanged.
   */
  syncSelectionFromPlot(): void {
    if (!this.host.plotDiv()) return;
    const raw = this.gd()?._fullLayout?._activeShapeIndex;
    const idx = (typeof raw === 'number' && raw >= 0 && raw < this.shapes.length) ? raw : -1;
    this.regionStore.setSelectedShapeIndices(idx >= 0 ? [idx] : []);
  }

  /**
   * Delete every selected shape — or, with no selection, the one Plotly tracks
   * as clicked — through the store, then re-project and redraw. Needs no live
   * plot: when another backend renders, its overlay redraws from the store.
   */
  deleteActiveShape(): void {
    if (this.regionStore.getSelectedShapeIndices().length === 0) {
      const activeIndex = this.gd()?._fullLayout?._activeShapeIndex;
      if (activeIndex === undefined || activeIndex < 0) return;
      this.regionStore.setSelectedShapeIndices([activeIndex]);
    }
    this.regionStore.deleteActiveShape();
    this.syncFromStore();
    const live = this.liveGd();
    if (!live) return;
    live._fullLayout!._activeShapeIndex = -1;
    const dictArray = this.shapes.map((s) => ({ ...s }));
    Plotly.relayout(live, { shapes: dictArray } as Plotly.Layout).then(
      () => { if (live._fullLayout) void Plotly.redraw(live); },
      (err: unknown) => console.warn('[viz:plotly] shape relayout after delete failed', err),
    );
  }

  /** The shapes-relayout payload: the shapes plus the active-shape fill colour. */
  private relayoutPayload(shapeDicts: any[]): Record<string, unknown> {
    return { shapes: shapeDicts, activeshape: { fillcolor: this.regionStore.getFillColor() } };
  }
}
