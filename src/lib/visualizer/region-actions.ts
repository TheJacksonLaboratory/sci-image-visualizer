import { Observable } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { Message } from 'primeng/api';

import { IRegionStore } from '../contracts/visualizer.contract';
import { MultiPolygon, Polygon, Rectangle, Region } from '../models/region';
import { RegionOpsService } from '../region-ops.service';
import { opEligible, regionsAt } from './visualizer-context-menu';

/** The region-store members the set-operations read and write through. */
export type RegionActionsTarget = Pick<
  IRegionStore,
  | 'getRegions'
  | 'setRegions'
  | 'setSelectedShapeIndices'
  | 'getSelectedShapeIndices$'
  | 'getCanUndo$'
  | 'getCanRedo$'
>;

/**
 * Region set-operations on the current selection (jit-ui#85) — select all, merge,
 * ungroup, inverse, simplify — plus the store mirrors the toolbar and the context
 * menu read synchronously: the selection and the undo/redo availability.
 *
 * Every operation commits through `setRegions`, so it is undo-tracked and the
 * backend on screen re-renders; profile lines and unselected regions are kept.
 */
export class RegionActions {
  /** Current selection (array indices), mirrored from the store. */
  selectedIndices: number[] = [];
  /** Whether a region action is available to undo / redo; drive the toolbar buttons. */
  canUndo = false;
  canRedo = false;
  /** Custom-threshold Simplify dialog. */
  displaySimplifyDialog = false;
  simplifyThreshold = 3;

  constructor(
    private readonly target: RegionActionsTarget,
    private readonly ops: RegionOpsService,
    /** `[width, height]` of the image, when known — the frame inverse and merge rasterize in. */
    private readonly imageSize: () => number[] | undefined,
    private readonly notify: (message: Message) => void,
  ) {}

  /** Mirror the store's selection and undo/redo depth until `until$` emits.
   *  `changed` runs after an undo/redo flip (the toolbar binds those). */
  bind(until$: Observable<unknown>, changed: () => void): void {
    this.target
      .getCanUndo$()
      .pipe(takeUntil(until$))
      .subscribe((v) => {
        this.canUndo = v;
        changed();
      });
    this.target
      .getCanRedo$()
      .pipe(takeUntil(until$))
      .subscribe((v) => {
        this.canRedo = v;
        changed();
      });
    this.target
      .getSelectedShapeIndices$()
      .pipe(takeUntil(until$))
      .subscribe((indices) => {
        this.selectedIndices = indices || [];
      });
  }

  /** The currently-selected regions (live store instances). */
  get selected(): Region[] {
    return regionsAt(this.target.getRegions(), this.selectedIndices);
  }

  /** Select every region on the image (excludes intensity-profile lines). */
  selectAll(): void {
    const indices: number[] = [];
    this.target.getRegions().forEach((r, i) => {
      if (r.kind !== 'profile') indices.push(i);
    });
    this.target.setSelectedShapeIndices(indices);
  }

  /** Merge the selected regions into a single (possibly multi-part) region. */
  merge(): void {
    const sel = opEligible(this.selected);
    if (sel.length < 2) return;
    const { w, h } = this.frame(sel);
    const merged = this.ops.merge(sel, w, h);
    if (merged) this.replace(sel, [merged]);
  }

  /** Split each selected multi-part region into one region per part. */
  ungroup(): void {
    const sel = this.selected.filter((r) => this.ops.canUngroup(r));
    if (sel.length === 0) return;
    this.replace(
      sel,
      sel.flatMap((r) => this.ops.ungroup(r)),
    );
  }

  /** Replace the selection with its inverse inside the image rectangle. */
  inverse(): void {
    const sel = opEligible(this.selected);
    if (sel.length === 0) return;
    const { w, h } = this.frame(sel);
    const inv = this.ops.inverse(sel, w, h);
    if (!inv) {
      this.notify({
        severity: 'warn',
        summary: 'Inverse',
        detail: 'Nothing to invert — select one or more closed regions first.',
      });
      return;
    }
    this.replace(sel, [inv]);
  }

  /** Douglas–Peucker simplify each selected region by `thresholdPx`, closing the dialog. */
  simplify(thresholdPx: number): void {
    const sel = opEligible(this.selected);
    if (sel.length === 0) return;
    this.replace(
      sel,
      sel.map((r) => this.ops.simplify(r, thresholdPx)),
    );
    this.displaySimplifyDialog = false;
  }

  openSimplifyDialog(): void {
    this.displaySimplifyDialog = true;
  }

  /** Commit a set-op: drop `remove`, append `add`, and select the results. */
  private replace(remove: Region[], add: Region[]): void {
    if (add.length === 0) return;
    const removeSet = new Set(remove);
    const kept = this.target.getRegions().filter((r) => !removeSet.has(r));
    this.target.setRegions([...kept, ...add]); // mints ids on `add`, records undo
    const stored = this.target.getRegions();
    this.target.setSelectedShapeIndices(add.map((r) => stored.indexOf(r)).filter((i) => i >= 0));
  }

  /** Image pixel dimensions for the raster ops; falls back to the selection's extent
   *  when the image size isn't known (keeps clamping sane). */
  private frame(regions: Region[]): { w: number; h: number } {
    let [w, h] = this.imageSize() ?? [0, 0];
    if (!(w > 0) || !(h > 0)) {
      let maxX = 0,
        maxY = 0;
      const scan = (xs: number[], ys: number[]) => {
        for (const x of xs) maxX = Math.max(maxX, x);
        for (const y of ys) maxY = Math.max(maxY, y);
      };
      for (const r of regions) {
        const b = r.bounds;
        if (b instanceof Rectangle) scan([b.x + b.width], [b.y + b.height]);
        else if (b instanceof Polygon) scan(b.xpoints, b.ypoints);
        else if (b instanceof MultiPolygon) for (const p of b.polygons) scan(p.xpoints, p.ypoints);
      }
      w = Math.max(w, Math.ceil(maxX) + 2);
      h = Math.max(h, Math.ceil(maxY) + 2);
    }
    return { w, h };
  }
}
