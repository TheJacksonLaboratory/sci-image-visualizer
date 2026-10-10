import * as Plotly from 'plotly.js-dist-min';
import { Subscription } from 'rxjs';

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
 * array `Plotly.relayout` consumes, kept beside the store. Shapes edited or
 * drawn on the Plotly canvas are mirrored INTO the store ({@link commitToStore});
 * every other change — wherever it was made — arrives as a store update event
 * and is projected back OUT and redrawn ({@link connect}). Also maps the store's
 * selection onto Plotly's `_activeShapeIndex` (the shape with the edit handles)
 * and back.
 */
export class PlotlyShapeProjection {
  /** The render projection: one Plotly shape dict per store region. */
  shapes: any[] = [];
  /** Nesting depth of {@link quietly}: region updates are not redrawn while > 0. */
  private muted = 0;
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
    // The canvas already shows these shapes: don't redraw them from the update.
    this.quietly(() => this.regionStore.setRegions(regions, this.regionStore.getShowShapeLabel(), true,
      this.regionStore.getFillColor(), false));
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
   * Follow the shared store: redraw the shapes on every region update and move
   * the edit handles on every selection change, whoever made the change (the
   * router, an undo, the Region Editor, another backend's overlay, a canvas
   * tool). Plotly is not on the store's write path any more — it listens, like
   * the OpenSeadragon and napari-js overlays do. Service-lifetime: both
   * callbacks no-op while no live Plotly graph holds the div.
   */
  connect(): Subscription {
    const subs = new Subscription();
    subs.add(this.regionStore.getRegionUpdateEvent().subscribe((regions) => this.onRegionUpdate(regions)));
    subs.add(this.regionStore.getSelectedShapeIndices$().subscribe((indices) => this.onSelection(indices)));
    return subs;
  }

  /**
   * Run `write` — a store write this projection already reflects (a shape edited
   * on the canvas, an image switch the next plot draws) — without redrawing from
   * the update event it causes.
   */
  quietly(write: () => void): void {
    this.muted++;
    try { write(); } finally { this.muted--; }
  }

  /**
   * A region update. The stored set re-projects and redraws; a transient set
   * (`setRegions(…, isRegionSaveOn = false)`, which the store emits without
   * storing) is drawn as-is and leaves the working-set alone.
   */
  private onRegionUpdate(regions: Region[]): void {
    if (this.muted > 0) return;
    const stored = this.regionStore.getRegions();
    const isStored = regions.length === stored.length && regions.every((r, i) => r === stored[i]);
    if (isStored) {
      this.syncFromStore();
      this.render();
      return;
    }
    const gd = this.liveGd();
    if (!gd) return;
    const showLabel = this.regionStore.getShowShapeLabel();
    const dicts = regions.map((r) => {
      r.filename = this.host.fileName();
      return { ...r.getShape(showLabel) };
    });
    void Plotly.relayout(gd, this.relayoutPayload(dicts) as Plotly.Layout);
  }

  /**
   * A selection change: Plotly's `_activeShapeIndex` points at the last selected
   * shape so it gets the edit handles (Plotly's own active-shape rendering is the
   * only highlight). Skipped when the plot already shows it — the change came
   * from a click on the plot ({@link syncSelectionFromPlot}).
   */
  private onSelection(indices: number[]): void {
    const gd = this.liveGd();
    if (!gd) return;
    const active = indices.length > 0 ? indices[indices.length - 1] : -1;
    if ((gd._fullLayout!._activeShapeIndex ?? -1) === active) return;
    gd._fullLayout!._activeShapeIndex = active;
    try { void Plotly.redraw(gd); } catch { /* noop in tests */ }
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

  /** The shapes-relayout payload: the shapes plus the active-shape fill colour. */
  private relayoutPayload(shapeDicts: any[]): Record<string, unknown> {
    return { shapes: shapeDicts, activeshape: { fillcolor: this.regionStore.getFillColor() } };
  }
}
