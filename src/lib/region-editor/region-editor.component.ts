import { Component, Inject, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { OverlayPanel } from 'primeng/overlaypanel';
import { saveAs } from 'file-saver';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, switchMap } from 'rxjs/operators';

import { Rectangle, Region } from '../models/region';
import { PresetSet, ClassPreset, defaultPresetSet, parsePresetSet } from '../models/class-preset';
import { colorForLabel, presetKey } from '../store/class-color.util';
import { ConfirmationService, MessageService } from 'primeng/api';
import { IRegionEditorApi, REGION_EDITOR_API } from '../contracts/region-editor-api.contract';
import { RegionIoPort, REGION_IO_PORT } from '../contracts/ports/region-io.port';
import { regionToParts, scaleParts, maskScaleFor } from './mask-raster';
import { VIZ_TOAST_KEY } from '../toast-outlets';
import { fileStem } from './file-stem';
import { PixelSize, formatArea, pickMpp, regionAreaPx } from './region-metrics';

@Component({
  selector: 'region-editor',
  templateUrl: './region-editor.component.html',
  styleUrls: ['./region-editor.component.scss'],
})
export class RegionEditorComponent implements OnInit, OnDestroy {
  @ViewChild('op') overlayPanel!: OverlayPanel;

  regions: Region[] = [];
  selectedRegions: Region[] = [];
  showShapeLabel!: boolean;
  shapeColor!: string;
  fillColor!: string;
  displayHelpDialog = false;
  showColorDialog = false;
  /** One colour editor per unique class among the selected regions, shown in the
   *  "edit colour of selected regions" dialog. Unclassified regions (no label)
   *  are grouped under a single entry with an empty `label`. */
  classColorEdits: { label: string; color: string }[] = [];
  labelColors: Map<string, string> = new Map();
  /** "Edit class on selected rows" popup: chosen existing class, and a new-class name. */
  bulkClass = '';
  newBulkClass = '';

  // ── annotation-class presets (jit-ui#70) ──
  /** Local mirror of the per-user preset set (chip strip, Class dropdown, dialog). */
  presetSet: PresetSet = defaultPresetSet();
  /** The class last picked in the panel; a chip-click applies it to the selected rows. */
  activeClass: string | null = null;
  showManageDialog = false;
  /** Working copy edited inside the Manage-classes dialog; committed on Apply/Done. */
  presetDraft: PresetSet | null = null;
  /** class name (match-mode keyed) → number of regions currently using it. */
  classCounts = new Map<string, number>();
  /** Fallback class that a region reverts to when its class is deleted (jit-ui#70). */
  readonly defaultClassName = 'Region';
  /** Classes as shown in the panel: sorted by region count (desc), then name. */
  displayClasses: ClassPreset[] = [];
  readonly matchModeOptions = [
    { label: 'Exact', value: 'exact' },
    { label: 'Normalized', value: 'normalized' },
  ];

  paginatorFirst = 0;
  paginatorRows = 10;
  readonly rowsPerPageOptions = [10, 25, 50];
  /** Regions whose Class cell is currently in edit mode → the label being typed.
   *  The draft is committed on Enter and discarded on Escape/✕, so typing never
   *  writes into the store's region (RT-18). Keyed by object identity, which
   *  avoids needing a unique id field. */
  editingLabelRegions = new Map<Region, string>();

  showSaveAsDialog = false;
  saveAsFilename = '';
  saveAsFileExists = false;
  /** True while a GeoJSON persist is serializing/uploading — drives the dialog's
   *  progress bar and Cancel button (parity with the Save-mask dialog). */
  saveAsBusy = false;
  private _saveAsCheck$ = new Subject<string>();
  private _saveAsSub?: Subscription;
  private _saveAsCheckSub = new Subscription();
  /** Handle for the deferred-serialize timer so Cancel/destroy can abort it
   *  before it fires (otherwise the upload would still start). */
  private _saveAsTimer?: ReturnType<typeof setTimeout>;

  showExportDialog = false;
  exportFilename = '';

  showSaveMaskDialog = false;
  saveMaskFilename = '';
  /** Mask type chosen in the Save-mask dialog: a binary foreground/background
   *  mask, or a multi-class mask with a distinct id per region. */
  maskMode: 'binary' | 'multiclass' = 'binary';
  /** True while the mask worker is rasterizing/encoding — drives the progress
   *  bar and the Cancel button in the dialog. */
  maskBusy = false;
  /** 0–100 rasterization progress; switches to indeterminate during encoding. */
  maskProgress = 0;
  maskEncoding = false;
  private maskWorker?: Worker;
  private pendingMaskFilename = '';

  /**
   * PrimeNG p-table multi-selection mode toggle. When true, single-click
   * selects one row (replacing prior); meta/ctrl-click toggles a row in/out
   * of the selection. When false, every click toggles. Default true to
   * match the most common spreadsheet-like UX.
   */
  metaKey = true;

  private _updatingFromEditor = false;
  private _suppressSelectionSyncToPlot = false;
  private _regionSub = new Subscription();
  private _selectedIdxSub = new Subscription();
  private _metaSub = new Subscription();
  private _presetSub = new Subscription();

  /** Physical pixel size (µm/pixel) of the active image, for region areas in
   *  µm²; empty when the format reports no physical size. */
  mpp: PixelSize = {};

  constructor(
    @Inject(REGION_EDITOR_API) private regionApi: IRegionEditorApi,
    public messageService: MessageService,
    private confirmationService: ConfirmationService,
    @Inject(REGION_IO_PORT) private regionIo: RegionIoPort,
  ) {}

  ngOnInit() {
    this.showShapeLabel = this.regionApi.getShowShapeLabel();
    this.shapeColor = this.regionApi.getShapeColor();
    this.fillColor = this.regionApi.getFillColor();

    // Annotation-class presets (jit-ui#70): mirror the set for the chip strip,
    // the Class dropdown and the manage dialog. Guarded with optional calls so
    // partial API mocks in tests (which omit the preset methods) don't throw.
    const initialPresets = this.regionApi.getPresetSet?.();
    if (initialPresets) this.presetSet = initialPresets;
    const presets$ = this.regionApi.getPresetSet$?.();
    if (presets$) {
      this._presetSub = presets$.subscribe((set) => {
        if (set) this.presetSet = set;
        this.updateDisplayClasses();
      });
    }
    // Seed from the visualizer's current regions — already scoped to the
    // active image by the per-image cache, and handed back as neutral Region
    // objects (no backend shape format involved).
    // Annotation regions only — intensity-profile lines are owned by the
    // intensity tool and excluded by the contract, so the editor never sees them.
    this.regions = this.applyRegionColors(this.regionApi.getAnnotationRegions());
    this.syncClassesFromRegions(this.regions);
    this.recomputeClassCounts();

    // The update event is just a change signal; re-read the regions from the
    // visualizer rather than parsing whatever payload it carries.
    this._regionSub = this.regionApi.getRegionUpdateEvent().subscribe(() => {
      if (this._updatingFromEditor) return;
      const updated = this.applyRegionColors(this.regionApi.getAnnotationRegions());
      // preserve selection for regions that still exist (by id, since name
      // is a user-editable display label and may collide)
      const selectedIds = new Set(this.selectedRegions.map((r) => r.id));
      this.regions = updated;
      this.selectedRegions = updated.filter((r) => selectedIds.has(r.id));
      this.clampPaginatorFirst();
      this.syncClassesFromRegions(updated);
      this.recomputeClassCounts();
    });

    this._saveAsCheckSub = this._saveAsCheck$.pipe(
      debounceTime(400),
      switchMap(name => this.regionIo.roiFileExists(name)),
    ).subscribe({
      next: exists => { this.saveAsFileExists = exists; },
      error: () => { this.saveAsFileExists = false; },
    });

    // Physical pixel size of the active image (for region areas in µm²/mm²).
    this._metaSub = this.regionApi.getImageMeta().subscribe((meta) => {
      this.mpp = pickMpp(meta);
    });

    this._selectedIdxSub = this.regionApi.getSelectedRegions$().subscribe((selected) => {
      if (this._suppressSelectionSyncToPlot) return;
      // Map the contract's selected regions to the editor's own instances by id.
      const next = selected
        .map((s) => this.regions.find((r) => r.id === s.id))
        .filter((r): r is Region => !!r);
      const same =
        next.length === this.selectedRegions.length &&
        next.every((r, i) => r.id === this.selectedRegions[i]?.id);
      if (!same) this.selectedRegions = next;
      // Scroll the paginator so the most-recently-selected row is visible.
      if (next.length > 0) {
        const lastIdx = this.regions.findIndex((r) => r.id === next[next.length - 1].id);
        if (lastIdx >= 0) {
          const pageStart = Math.floor(lastIdx / this.paginatorRows) * this.paginatorRows;
          if (pageStart !== this.paginatorFirst) this.paginatorFirst = pageStart;
        }
      }
    });
  }

  ngOnDestroy() {
    this._regionSub.unsubscribe();
    this._selectedIdxSub.unsubscribe();
    this._metaSub.unsubscribe();
    this._presetSub.unsubscribe();
    this._saveAsCheckSub.unsubscribe();
    if (this._saveAsTimer !== undefined) clearTimeout(this._saveAsTimer);
    this._saveAsSub?.unsubscribe();
    this.teardownMaskWorker();
  }

  /**
   * Table → Plot: PrimeNG fires onRowSelect/onRowUnselect after updating
   * `selectedRegions`. Push the selected regions to the contract by identity —
   * the package maps them to its internal index space (which includes the
   * intensity-profile lines the editor never sees).
   */
  onSelectionChanged() {
    this._suppressSelectionSyncToPlot = true;
    try {
      this.regionApi.setSelectedRegions(this.selectedRegions ?? []);
    } finally {
      this._suppressSelectionSyncToPlot = false;
    }
  }

  /**
   * Apply classification colours and refresh the label→colour map for regions
   * coming from the visualizer. The visualizer hands back neutral `Region`
   * objects with bounds, colour and label already populated, so the editor no
   * longer parses any backend-specific shape format — it only fills in a
   * fallback colour and rebuilds its local label→colour lookup.
   */
  private applyRegionColors(regions: Region[]): Region[] {
    for (const region of regions) {
      region.color =
        region.color ||
        this.regionApi.getClassificationColors().get(region.label ?? '') ||
        this.shapeColor;
    }
    // Rebuild labelColors: seed from persisted map, then overlay actual region colors
    this.labelColors.clear();
    for (const [label, color] of this.regionApi.getClassificationColors()) {
      this.labelColors.set(label, color);
    }
    for (const region of regions) {
      if (region.label && region.color) {
        this.labelColors.set(region.label, region.color);
      }
    }
    return regions;
  }

  /**
   * Push edits from the editor to the diagram in live-edit mode (no save /
   * cancel buttons). The `_updatingFromEditor` guard is still used so the
   * resulting regionUpdateEvent doesn't bounce back as an external change.
   */
  private setRegionsFromEditor(fillColor?: string) {
    this._updatingFromEditor = true;
    // isRegionSaveOn=true so changes commit to the region store (and the per-image
    // cache) immediately. setAnnotationRegions preserves the intensity-profile
    // lines internally, so editor edits never disturb them.
    this.regionApi.setAnnotationRegions(this.regions, this.showShapeLabel, true, fillColor ?? this.fillColor);
    this._updatingFromEditor = false;
    // The editor's own commit is ignored by the region-update subscription (the
    // _updatingFromEditor guard), so refresh here: a class label typed in the
    // Class column gets added to the list, and the panel counts/order stay in
    // sync after any edit. (jit-ui#70)
    this.syncClassesFromRegions(this.regions);
    this.recomputeClassCounts();
  }

  /**
   * Copy-on-write edit (review RT-1). The editor's rows are the region store's
   * live instances, and the store takes its undo snapshot only when the edit is
   * committed — so an edit must replace a region with a patched copy (and any
   * bounds it changes with new bounds), never mutate the instance the store
   * holds. Returns the copies by original; the selection and an open label edit
   * follow them.
   */
  private patchRegions(patchFor: (r: Region) => Partial<Region> | null): Map<Region, Region> {
    const copies = new Map<Region, Region>();
    this.regions = this.regions.map((r) => {
      const patch = patchFor(r);
      if (!patch) return r;
      const copy = Object.assign(new Region(), r, patch);
      copies.set(r, copy);
      return copy;
    });
    if (copies.size) {
      this.selectedRegions = (this.selectedRegions ?? []).map((r) => copies.get(r) ?? r);
      for (const [r, copy] of copies) {
        const draft = this.editingLabelRegions.get(r);
        if (draft === undefined) continue;
        this.editingLabelRegions.delete(r);
        this.editingLabelRegions.set(copy, draft);
      }
    }
    return copies;
  }

  /** Set one region's outline colour from the per-row picker and commit live.
   *  Remembers it as the label's colour so same-class regions added later match
   *  (jit-ui#85 — the Region Editor's per-region Color column). */
  changeRegionColor(region: Region, color: string): void {
    if (!color || region.color === color) return;
    // colorOverridden: explicit per-region colour — preserve it against preset (re)apply (jit-ui#70)
    this.patchRegions((r) => (r === region ? { color, colorOverridden: true } : null));
    if (region.label) this.labelColors.set(region.label, color);
    this.setRegionsFromEditor();
  }

  /**
   * Update the label of the region on enter key pressed (when editing a label cell in the table)
   * @param region
   * @param setRegion
   */
  labelRegionUpdate(region: Region, setRegion = false) {
    if (region.label) {
      // if label doesn't exist
      if (!this.labelColors.has(region.label)) {
        this.labelColors.set(region.label, this.shapeColor);
      }
    }
    // update colors of the regions
    this.patchRegions((reg) =>
      !reg.color && reg.label && this.labelColors.has(reg.label)
        ? { color: this.labelColors.get(reg.label) }
        : null,
    );
    // update labels map
    this.labelColors.clear();
    for (const reg of this.regions) {
      if (reg.label && reg.color) {
        this.labelColors.set(reg.label, reg.color);
      }
    }
    if (setRegion) {
      this.setRegionsFromEditor();
    }
  }
  /** The current page of the table. Memoized on (regions, first, rows), so
   *  change detection doesn't hand p-table a new array every tick (RT-20). */
  get pagedRegions(): Region[] {
    const key = this._pageKey;
    if (key.regions !== this.regions || key.first !== this.paginatorFirst || key.rows !== this.paginatorRows) {
      this._pageKey = { regions: this.regions, first: this.paginatorFirst, rows: this.paginatorRows };
      this._page = this.regions.slice(this.paginatorFirst, this.paginatorFirst + this.paginatorRows);
    }
    return this._page;
  }
  private _pageKey: { regions?: Region[]; first?: number; rows?: number } = {};
  private _page: Region[] = [];

  onPageChange(event: { first?: number; rows?: number }) {
    this.paginatorFirst = event.first ?? 0;
    this.paginatorRows = event.rows ?? this.paginatorRows;
  }

  /** Select every region in the table (and highlight them on the diagram). */
  selectAllRegions() {
    this.selectedRegions = [...this.regions];
    this.onSelectionChanged();
  }

  deleteSelectedRegions() {
    if (this.selectedRegions && this.selectedRegions.length > 0) {
      // Filter by id — object identity isn't reliable across re-parses,
      // and name is a user-editable label that may collide.
      const removed = new Set(this.selectedRegions.map((r) => r.id));
      this.regions = this.regions.filter((r) => !removed.has(r.id));
      this.selectedRegions = [];
      this.clampPaginatorFirst();
      this.setRegionsFromEditor();
      // Sync the cleared selection with the plot's highlight state.
      this.onSelectionChanged();
    }
  }

  clearAllRegions() {
    this.confirmationService.confirm({
      key: 'positionDialog',
      message: 'Are you sure you want to delete all regions?',
      accept: () => {
        this.regions = [];
        this.selectedRegions = [];
        this.paginatorFirst = 0;
        this.setRegionsFromEditor();
        this.onSelectionChanged();
      },
    });
  }

  deleteRegion(shapeIdx: number) {
    const removed = this.regions[shapeIdx];
    this.regions = this.regions.filter((_, i) => i !== shapeIdx);
    if (removed) {
      this.selectedRegions = this.selectedRegions.filter((r) => r.id !== removed.id);
    }
    this.clampPaginatorFirst();
    this.setRegionsFromEditor();
    // Re-emit the (possibly trimmed) selection so the plot's highlight stays
    // in sync with what's still in the table.
    this.onSelectionChanged();
  }

  private clampPaginatorFirst() {
    const maxFirst = Math.max(
      0,
      Math.floor((this.regions.length - 1) / this.paginatorRows) * this.paginatorRows,
    );
    if (this.paginatorFirst > maxFirst) {
      this.paginatorFirst = maxFirst;
    }
  }
  changeShowShapeLabel(showLabel: boolean) {
    this.setRegionsFromEditor();
  }

  isEditingLabel(region: Region): boolean {
    return this.editingLabelRegions.has(region);
  }

  startEditLabel(region: Region, event?: Event): void {
    event?.stopPropagation(); // don't toggle row selection
    this.editingLabelRegions.set(region, region.label ?? '');
  }

  stopEditLabel(region: Region, commit: boolean, event?: Event): void {
    event?.stopPropagation();
    const draft = this.editingLabelRegions.get(region);
    this.editingLabelRegions.delete(region);
    if (commit) {
      // A changed label commits as a replacement region, so it is undoable (RT-1).
      const edited =
        draft !== undefined && draft !== region.label
          ? (this.patchRegions((r) => (r === region ? { label: draft } : null)).get(region) ?? region)
          : region;
      this.labelRegionUpdate(edited, true);
    }
  }

  /** Region area for display (µm²/mm² when the image is scaled, else px²);
   *  empty for a degenerate region. See `region-metrics`. */
  regionArea(region: Region): string {
    return formatArea(regionAreaPx(region), this.mpp);
  }

  /**
   * This method rounds all the rectangle regions lengths to multiple of 512
   */
  roundRectangleLengths() {
    this.patchRegions((region) => {
      const rect = region.bounds;
      if (!(rect instanceof Rectangle)) return null;
      return {
        bounds: Object.assign(new Rectangle(), rect, {
          height: Math.round(rect.height / 512) * 512,
          width: Math.round(rect.width / 512) * 512,
        }),
      };
    });
    this.setRegionsFromEditor();
  }

  showHelp() {
    this.displayHelpDialog = true;
  }

  /** Open the colour dialog for the currently-selected region(s), building one
   *  colour picker per unique class in the selection. Each picker is seeded with
   *  the class's current colour (the label→colour map, falling back to the first
   *  selected region of that class). */
  openColorDialog() {
    if (!this.selectedRegions?.length) return;
    const seedByLabel = new Map<string, string>();
    for (const region of this.selectedRegions) {
      const label = region.label?.trim() ?? '';
      if (seedByLabel.has(label)) continue;
      seedByLabel.set(
        label,
        (label ? this.labelColors.get(label) : undefined) ?? region.color ?? this.shapeColor,
      );
    }
    this.classColorEdits = [...seedByLabel].map(([label, color]) => ({ label, color }));
    this.showColorDialog = true;
  }

  /** Apply each class's chosen colour to the selected regions of that class and
   *  commit live. Remembers the colour per class so same-class regions added
   *  later match. */
  applyColorToSelected() {
    const colorByLabel = new Map(this.classColorEdits.map((e) => [e.label, e.color]));
    const selected = new Set(this.selectedRegions ?? []);
    this.patchRegions((region) => {
      if (!selected.has(region)) return null;
      const label = region.label?.trim() ?? '';
      const color = colorByLabel.get(label);
      if (!color) return null;
      if (label) this.labelColors.set(label, color);
      // explicit colour — preserve against preset (re)apply (jit-ui#70)
      return { color, colorOverridden: true };
    });
    this.setRegionsFromEditor();
    this.showColorDialog = false;
  }

  // ── annotation-class presets (jit-ui#70) ─────────────────────────────

  /** Resolve the display colour for a class name (preset colour or deterministic fallback). */
  colorForName(name?: string): string {
    return name ? colorForLabel(name, this.presetSet) : this.shapeColor;
  }

  /**
   * Ensure every class label present in the loaded regions exists in the preset
   * list, auto-adding any that are missing (using the region's already-resolved
   * colour). This makes classes carried in a loaded/imported GeoJSON show up as
   * chips + Class-dropdown options (a p-dropdown can't display a value that isn't
   * an option) and lets the user manage them. The placeholder 'legend' and empty
   * labels are ignored. (jit-ui#70)
   */
  private syncClassesFromRegions(regions: Region[]): void {
    const keyOf = (l: string) => presetKey(this.presetSet, l);
    const known = new Set(this.presetSet.classes.map((c) => keyOf(c.name)));
    const added = new Set<string>();
    for (const r of regions) {
      const label = r.label?.trim();
      if (!label || label === 'legend') continue;
      const k = keyOf(label);
      if (known.has(k) || added.has(k)) continue;
      added.add(k);
      this.regionApi.upsertClass({
        name: label,
        color: r.color || colorForLabel(label, this.presetSet),
        source: 'auto',
      });
    }
  }

  // ── Docked Classes panel (jit-ui#70) ─────────────────────────────────

  /** Rebuild the per-class region counts shown in the panel. */
  private recomputeClassCounts(): void {
    const counts = new Map<string, number>();
    for (const r of this.regions) {
      if (!r.label) continue;
      const k = presetKey(this.presetSet, r.label);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    this.classCounts = counts;
    this.updateDisplayClasses();
  }

  /** Rebuild the panel's display order — most-used classes first, then by name. */
  private updateDisplayClasses(): void {
    this.displayClasses = [...this.presetSet.classes].sort((a, b) => {
      const d = this.classCount(b.name) - this.classCount(a.name);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
  }

  /** trackBy for the class rows so re-sorting doesn't re-create the pickers. */
  trackByClassName = (_: number, c: ClassPreset): string => c.name;

  /** Number of regions currently using a class (keyed by the active match mode). */
  classCount(name: string): number {
    return this.classCounts.get(presetKey(this.presetSet, name)) ?? 0;
  }

  /** Recolour a class from its panel swatch and repaint its (non-overridden) regions. */
  setClassColor(name: string, color: string): void {
    if (!color) return;
    this.regionApi.setClassificationColor(name, color);
    this.setRegionsFromEditor();
  }

  /** Tooltip for a class's delete button in the panel. */
  deleteClassTooltip(name: string): string {
    const inUse = this.classCount(name) > 0;
    if (name === this.defaultClassName && inUse) return 'The default class cannot be removed while in use';
    return inUse ? 'Remove class — its regions revert to Region' : 'Remove class';
  }

  /** Remove a class. Any regions still using it fall back to the default
   *  "Region" class, so they aren't orphaned (and the class isn't immediately
   *  re-added from its regions by syncClassesFromRegions). */
  deleteClass(name: string): void {
    this.reassignRegionsToDefaultClass([name]);
    this.regionApi.removeClass(name);
    if (this.activeClass === name) this.activeClass = null;
    this.setRegionsFromEditor();
  }

  /** Regions labelled with any of `removedNames` revert to the default
   *  {@link defaultClassName} ("Region"): its class colour, override cleared.
   *  Skips the default itself so deleting "Region" can't self-reassign. (jit-ui#70) */
  private reassignRegionsToDefaultClass(removedNames: string[]): void {
    const keyOf = (s: string) => presetKey(this.presetSet, s);
    const removed = new Set(removedNames.map(keyOf));
    removed.delete(keyOf(this.defaultClassName));
    if (!removed.size) return;
    const color = colorForLabel(this.defaultClassName, this.presetSet);
    this.patchRegions((r) =>
      r.label && removed.has(keyOf(r.label))
        ? { label: this.defaultClassName, colorOverridden: false, color }
        : null,
    );
  }

  /** Stamp a class (and its preset/fallback colour) onto one region from the Class
   *  dropdown; choosing a class opts the region back into the preset colour. */
  applyPresetToRegion(region: Region, className: string): void {
    const name = (className ?? '').trim();
    const patch: Partial<Region> = { label: name, colorOverridden: false };
    if (name) patch.color = colorForLabel(name, this.presetSet);
    this.patchRegions((r) => (r === region ? patch : null));
    this.setRegionsFromEditor();
  }

  /** Make a class active (used for new regions) and, if rows are selected, apply
   *  it to them in one commit. */
  selectActiveClass(name: string): void {
    this.activeClass = name;
    this.applyClassToSelected(name);
  }

  /** Apply a class (label + preset/fallback colour) to the current selection and commit. */
  private applyClassToSelected(name: string): void {
    const selected = new Set(this.selectedRegions ?? []);
    if (!selected.size) return;
    const color = colorForLabel(name, this.presetSet);
    this.patchRegions((r) => (selected.has(r) ? { label: name, colorOverridden: false, color } : null));
    this.setRegionsFromEditor();
  }

  /** "Edit class on selected rows" popup — apply the chosen existing class. */
  applyBulkClass(): void {
    if (!this.bulkClass) return;
    this.applyClassToSelected(this.bulkClass);
    this.overlayPanel?.hide();
  }

  /** "Edit class on selected rows" popup — add a new class and set it on the selection. */
  addAndApplyBulkClass(): void {
    const name = this.newBulkClass.trim();
    if (!name) return;
    const key = presetKey(this.presetSet, name);
    const exists = this.presetSet.classes.some((c) => presetKey(this.presetSet, c.name) === key);
    if (!exists) {
      this.regionApi.upsertClass({ name, color: colorForLabel(name, this.presetSet), source: 'user' });
    }
    this.applyClassToSelected(name);
    this.bulkClass = name;
    this.newBulkClass = '';
    this.overlayPanel?.hide();
  }

  // ── Manage-classes dialog ──
  openManageDialog(): void {
    this.presetDraft = this.clonePresetSet(this.presetSet);
    this.showManageDialog = true;
  }
  private clonePresetSet(s: PresetSet): PresetSet {
    return {
      classes: (s.classes ?? []).map((c) => ({ ...c })),
      fallbackPalette: [...(s.fallbackPalette ?? [])],
      autoPromote: !!s.autoPromote,
      matchMode: s.matchMode === 'normalized' ? 'normalized' : 'exact',
    };
  }
  addPresetClass(): void {
    this.presetDraft?.classes.push({ name: '', color: '#888888', source: 'user' });
  }
  removePresetClass(i: number): void {
    this.presetDraft?.classes.splice(i, 1);
  }
  addFallbackColor(): void {
    this.presetDraft?.fallbackPalette.push('#888888');
  }
  removeFallbackColor(i: number): void {
    this.presetDraft?.fallbackPalette.splice(i, 1);
  }
  /** Commit the draft: drop blank/duplicate names, persist, and recolour
   *  non-overridden regions with the updated presets. */
  applyManageDialog(close: boolean): void {
    if (!this.presetDraft) return;
    // De-duplicate using the active match mode's key so normalized mode can't keep
    // both "Tumor" and "tumor" (which would collide at runtime in findPreset()).
    const draft = this.presetDraft;
    const keyOf = (s: string) => presetKey(draft, s);
    const seen = new Set<string>();
    const classes: ClassPreset[] = [];
    for (const c of draft.classes) {
      const name = (c.name ?? '').trim();
      const key = keyOf(name);
      if (!name || seen.has(key)) continue;
      seen.add(key);
      classes.push({ ...c, name });
    }
    this.presetDraft.classes = classes;
    // Classes dropped in the dialog: their regions revert to the default "Region"
    // class (else syncClassesFromRegions would just re-add them) (jit-ui#70).
    const kept = new Set(classes.map((c) => keyOf(c.name)));
    const removed = this.presetSet.classes
      .map((c) => c.name)
      .filter((n) => !kept.has(keyOf(n)));
    this.reassignRegionsToDefaultClass(removed);
    this.regionApi.setPresetSet(this.presetDraft);
    this.setRegionsFromEditor(); // recolour existing (non-overridden) regions from the new presets
    if (close) this.showManageDialog = false;
  }
  resetPresetsToDefaults(): void {
    this.regionApi.resetPresets();
    this.presetDraft = this.clonePresetSet(this.regionApi.getPresetSet());
    this.setRegionsFromEditor();
  }
  exportPresets(): void {
    const json = JSON.stringify(this.regionApi.getPresetSet(), null, 2);
    saveAs(new Blob([json], { type: 'application/json' }), 'annotation-classes.json');
  }
  importPresets(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => this.applyImportedPresets(reader.result as string);
    reader.readAsText(file);
  }

  /** Validate and apply an imported annotation-classes JSON file. */
  private applyImportedPresets(text: string): void {
    try {
      const set = parsePresetSet(JSON.parse(text));
      if (!set) throw new Error('The file is not an annotation-class list (no valid classes).');
      this.regionApi.setPresetSet(set);
      this.presetDraft = this.clonePresetSet(this.regionApi.getPresetSet());
      this.setRegionsFromEditor();
      this.messageService.add({ key: VIZ_TOAST_KEY, severity: 'success',
        summary: 'Classes imported', detail: 'Annotation classes loaded.' });
    } catch (err) {
      this.messageService.add({ key: VIZ_TOAST_KEY, severity: 'error',
        summary: 'Import failed', detail: `${(err as Error)?.message ?? err}` });
    }
  }

  importRois(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => this.applyImportedRois(reader.result as string);
    reader.readAsText(file);
  }

  /** Replace the regions with an imported GeoJSON file's. */
  private applyImportedRois(text: string): void {
    try {
      this.regions = this.regionApi.importRegions(text);
      // set label colors
      for (const region of this.regions) {
        this.labelRegionUpdate(region, false);
      }
      this.syncClassesFromRegions(this.regions);
      this.setRegionsFromEditor();
    } catch (err) {
      this.messageService.add({
        key: VIZ_TOAST_KEY,
        severity: 'error',
        summary: 'Error importing the file',
        detail: `${(err as Error)?.message ?? err}`,
      });
      console.error('Error reading the file:', err);
    }
  }

  /**
   * Regions to serialize on save/export. For a single-file z-stack the store
   * keeps only the current slice live, so pull EVERY slice's annotations (each
   * tagged with its zero-based Region.z) to write one combined z-indexed
   * geojson (jit-ui#93). Otherwise (single-plane image, or a folder stack whose
   * slices save to their own per-slice files) the current set. (jit-ui#93)
   */
  private regionsForSave(): Region[] {
    if (this.regionApi.isStackMode() && this.regionApi.getStackSaveLayout() === 'combined') {
      return this.regionApi.getSliceAnnotationRegions();
    }
    return this.regions;
  }

  exportRois() {
    if (!this.regionsForSave().length) return;
    this.exportFilename = `${fileStem(this.regionIo.getSelectedFileName(), 'rois')}.geojson`;
    this.showExportDialog = true;
  }

  confirmExport() {
    const filename = this.exportFilename.trim();
    const regions = this.regionsForSave();
    if (!filename || !regions.length) return;
    this.showExportDialog = false;
    const jsonString = this.regionApi.getGeoJsonString(regions);
    const blob = new Blob([jsonString], { type: 'application/json' });
    saveAs(blob, filename);
  }

  /** Open the "Save mask" dialog, seeded with `<image-stem>_mask.png`. */
  openSaveMaskDialog() {
    if (!this.regions.length) return;
    this.saveMaskFilename = `${fileStem(this.regionIo.getSelectedFileName(), 'regions')}_mask.png`;
    this.maskMode = 'binary';
    this.showSaveMaskDialog = true;
  }

  /**
   * Rasterize the regions to the chosen mask type and download as a PNG. The
   * heavy work (full-res rasterize + PNG encode) runs in a Web Worker so the UI
   * never freezes on large/whole-slide images and the job can be cancelled
   * (jit-ui#95). The dialog stays open showing a progress bar until done.
   */
  confirmSaveMask() {
    const filename = this.saveMaskFilename.trim();
    if (!filename || !this.regions.length || this.maskBusy) return;

    const size = this.regionApi.getMaskImageSize();
    if (!size) {
      this.maskError('No image size is available, so the mask cannot be sized.');
      return;
    }

    // Whole-slide images exceed the browser's typed-array/memory limits, so cap
    // the mask to a safe pixel budget and scale the geometry to match.
    const scale = maskScaleFor(size.width, size.height);
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    if (scale < 1) {
      this.messageService.add({
        key: VIZ_TOAST_KEY,
        severity: 'info',
        summary: 'Mask downscaled',
        detail: `Image too large for a full-resolution mask; saving at ${width}×${height}.`,
      });
    }
    const regions = this.regions.map((r) => scaleParts(regionToParts(r), scale));

    this.pendingMaskFilename = filename;
    this.maskBusy = true;
    this.maskEncoding = false;
    this.maskProgress = 0;

    const payload = {
      width, height,
      originalWidth: size.width, originalHeight: size.height, scale,
      mode: this.maskMode,
      sourceName: this.regionIo.getSelectedFileName(),
      regions,
    };
    // createMaskWorker() is async (the worker module is imported dynamically so
    // its import.meta never reaches the CommonJS test compile). Wire up once it
    // resolves — unless the user cancelled while it was loading.
    this.createMaskWorker().then((worker) => {
      if (!this.maskBusy) { worker.terminate(); return; }
      this.maskWorker = worker;
      worker.onmessage = ({ data }: MessageEvent) => {
        switch (data?.type) {
          case 'progress':
            this.maskProgress = data.total ? Math.round((data.done / data.total) * 100) : 0;
            break;
          case 'encoding':
            this.maskEncoding = true;
            break;
          case 'done':
            this.finishMask(new Blob([data.png], { type: 'image/png' }));
            break;
          case 'error':
            this.maskError(data.error || 'The mask could not be generated.');
            break;
        }
      };
      worker.onerror = () => this.maskError('The mask worker failed.');
      worker.postMessage(payload);
    }).catch(() => this.maskError('The mask worker failed to start.'));
  }

  /** Cancel an in-progress mask export: terminate the worker and reset state. */
  cancelSaveMask() {
    this.teardownMaskWorker();
    this.maskBusy = false;
    this.maskEncoding = false;
    this.maskProgress = 0;
  }

  /** Worker factory — async so the worker module (and its `import.meta.url`,
   *  which the CommonJS test compile rejects) is loaded via a dynamic import,
   *  exactly like the segmentation worker. Overridable in tests. */
  protected async createMaskWorker(): Promise<Worker> {
    const { createMaskWorker } = await import('./mask-worker');
    return createMaskWorker();
  }

  private finishMask(blob: Blob) {
    this.teardownMaskWorker();
    this.maskBusy = false;
    this.maskEncoding = false;
    this.showSaveMaskDialog = false;
    saveAs(blob, this.pendingMaskFilename);
  }

  private maskError(detail: string) {
    this.teardownMaskWorker();
    this.maskBusy = false;
    this.maskEncoding = false;
    this.messageService.add({
      key: VIZ_TOAST_KEY,
      severity: 'error',
      summary: 'Could not create mask',
      detail,
    });
  }

  private teardownMaskWorker() {
    this.maskWorker?.terminate();
    this.maskWorker = undefined;
  }

  persistRegions() {
    // Folder stack: write each slice's regions back to its own slice-file's
    // sibling geojson — no single-filename prompt (the filenames are the slice
    // files'). (jit-ui#93)
    if (this.regionApi.isStackMode() && this.regionApi.getStackSaveLayout() === 'per-slice-file') {
      this.saveStackSlices();
      return;
    }
    const name = this.regionIo.getSelectedFileName();
    if (!name || !this.regionsForSave().length) return;

    this.saveAsFilename = `${fileStem(name, name)}.geojson`;
    this.saveAsFileExists = false;
    this.showSaveAsDialog = true;
    this._saveAsCheck$.next(this.saveAsFilename);
  }

  /**
   * Save a folder stack's regions as one geojson per slice-file (jit-ui#93).
   * Groups the store's per-slice regions by slice index and serializes each on
   * the default plane (z=0) — each slice-file is itself one plane, and the
   * loader re-derives the slice index from the file's position in the series.
   * Slices cleared since load are included (empty) so their file is overwritten.
   */
  private saveStackSlices() {
    const bySlice = this.regionApi.getStackSaveAnnotationSlices();
    if (!bySlice.size) return;
    const slices: { z: number; geoJsonStr: string }[] = [];
    for (const [z, regs] of bySlice) {
      const flat = regs.map((r) => Object.assign(new Region(), r, { z: 0 }));
      slices.push({ z, geoJsonStr: this.regionApi.getGeoJsonString(flat) });
    }
    this.saveAsBusy = true;
    this._saveAsSub = this.regionIo.saveSliceGeoJsons(slices).subscribe({
      next: () => {
        this.saveAsBusy = false;
        this.messageService.add({
          key: VIZ_TOAST_KEY,
          severity: 'success',
          summary: 'Regions saved',
          detail: `Saved ROIs for ${slices.length} slice${slices.length === 1 ? '' : 's'}`,
        });
      },
      error: (err) => {
        this.saveAsBusy = false;
        this.messageService.add({
          key: VIZ_TOAST_KEY,
          severity: 'error',
          summary: 'Error saving regions',
          detail: `${(err as Error)?.message ?? err}`,
        });
      },
    });
  }

  checkSaveAsFileExists() {
    this._saveAsCheck$.next(this.saveAsFilename);
  }

  confirmSaveAs() {
    if (!this.regionIo.getSelectedFileName()) return;

    const filename = this.saveAsFilename.trim();
    if (!filename) return;

    const doSave = () => {
      // Keep the dialog open showing an (indeterminate) progress bar while the
      // regions serialize and upload, then close on success. Defer one tick so
      // the bar paints before a large synchronous GeoJSON serialize.
      this.saveAsBusy = true;
      this._saveAsTimer = setTimeout(() => {
        this._saveAsTimer = undefined;
        let geoJsonStr: string;
        try {
          geoJsonStr = this.regionApi.getGeoJsonString(this.regionsForSave());
        } catch (err) {
          this.saveAsBusy = false;
          this.messageService.add({
            key: VIZ_TOAST_KEY,
            severity: 'error',
            summary: 'Error saving regions',
            detail: `${(err as Error)?.message ?? err}`,
          });
          return;
        }
        this._saveAsSub = this.regionIo.saveGeoJson(geoJsonStr, filename).subscribe({
          next: () => {
            this.saveAsBusy = false;
            this.showSaveAsDialog = false;
            this.messageService.add({
              key: VIZ_TOAST_KEY,
              severity: 'success',
              summary: 'Regions saved',
              detail: `Saved as ${filename}`,
            });
          },
          error: (err) => {
            this.saveAsBusy = false;
            this.messageService.add({
              key: VIZ_TOAST_KEY,
              severity: 'error',
              summary: 'Error saving regions',
              detail: `${err.message || err}`,
            });
          },
        });
      });
    };

    if (this.saveAsFileExists) {
      this.confirmationService.confirm({
        message: `"${filename}" already exists. Do you want to overwrite it?`,
        header: 'Confirm Overwrite',
        icon: 'pi pi-exclamation-triangle',
        accept: doSave,
      });
    } else {
      doSave();
    }
  }

  /** Cancel an in-progress GeoJSON persist: abort the deferred serialize and/or
   *  the in-flight upload, and reset state. */
  cancelSaveAs() {
    if (this._saveAsTimer !== undefined) {
      clearTimeout(this._saveAsTimer);
      this._saveAsTimer = undefined;
    }
    this._saveAsSub?.unsubscribe();
    this._saveAsSub = undefined;
    this.saveAsBusy = false;
  }
}
