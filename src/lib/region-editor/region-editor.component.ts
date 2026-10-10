import { Component, Inject, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { OverlayPanel } from 'primeng/overlaypanel';
import { saveAs } from 'file-saver';
import { Subject, Subscription } from 'rxjs';

import { Rectangle, Region } from '../models/region';
import { withRegionPatch } from '../models/region-clone';
import { PresetSet, ClassPreset, defaultPresetSet, parsePresetSet } from '../models/class-preset';
import { colorForLabel, presetKey } from '../store/class-color.util';
import { ConfirmationService, MessageService } from 'primeng/api';
import { IRegionEditorApi, REGION_EDITOR_API } from '../contracts/region-editor-api.contract';
import { VIZ_TOAST_KEY } from '../toast-outlets';
import { RegionPersistenceService } from './region-persistence.service';
import { ClassColorEdit } from './region-color-dialog/region-color-dialog.component';
import { MaskExportService, MaskMode } from './mask-export.service';
import { PixelSize, formatArea, pickMpp, regionAreaPx } from './region-metrics';

@Component({
  selector: 'region-editor',
  templateUrl: './region-editor.component.html',
  styleUrls: ['./region-editor.component.scss'],
  providers: [RegionPersistenceService],
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
  classColorEdits: ClassColorEdit[] = [];
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
  /** The running GeoJSON save; unsubscribing cancels it (Cancel / destroy). */
  private _saveAsSub?: Subscription;
  private _saveAsCheckSub = new Subscription();
  /** Save-as file names to check for an existing file (debounced). */
  private readonly saveAsCheck$ = new Subject<string>();

  showExportDialog = false;
  exportFilename = '';

  showSaveMaskDialog = false;
  saveMaskFilename = '';
  /** Mask type chosen in the Save-mask dialog: a binary foreground/background
   *  mask, or a multi-class mask with a distinct id per region. */
  maskMode: MaskMode = 'binary';
  /** True while the mask worker is rasterizing/encoding — drives the progress
   *  bar and the Cancel button in the dialog. */
  maskBusy = false;
  /** 0–100 rasterization progress; switches to indeterminate during encoding. */
  maskProgress = 0;
  maskEncoding = false;
  /** The running mask export; unsubscribing cancels it (terminates its worker). */
  private maskJob?: Subscription;

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
    private persistence: RegionPersistenceService,
    private maskExport: MaskExportService,
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

    this._saveAsCheckSub = this.persistence.fileExists(this.saveAsCheck$).subscribe((exists) => {
      this.saveAsFileExists = exists;
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
    this._saveAsSub?.unsubscribe();
    this.maskJob?.unsubscribe();
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
   * Rows for regions coming from the visualizer: neutral `Region`s with bounds,
   * colour and label already populated. A region without a colour is shown with
   * its classification colour (or the default shape colour) — as a copy: the
   * store's instances are shared with its undo history and must not be changed
   * in place (RT-1).
   */
  private applyRegionColors(regions: Region[]): Region[] {
    const classColors = this.regionApi.getClassificationColors();
    return regions.map((region) => region.color
      ? region
      : withRegionPatch(region, { color: classColors.get(region.label ?? '') || this.shapeColor }));
  }

  /**
   * The editor's one write path (RT-1): make `next` the table's rows and commit
   * them to the store — live, as one undoable step (isRegionSaveOn=true; the
   * router keeps the intensity-profile lines). Rows are the store's instances,
   * so an edit passes copies ({@link patchRegions}), never changed rows. The
   * resulting region-update event is ignored (`_updatingFromEditor`), so the
   * class list and counts are refreshed here (a typed class is added; jit-ui#70).
   */
  private commit(next: Region[] = this.regions): void {
    this.regions = next;
    this._updatingFromEditor = true;
    try {
      this.regionApi.setAnnotationRegions(next, this.showShapeLabel, true, this.fillColor);
    } finally {
      this._updatingFromEditor = false;
    }
    this.syncClassesFromRegions(next);
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
      const copy = withRegionPatch(r, patch);
      copies.set(r, copy);
      return copy;
    });
    if (copies.size) {
      this.selectedRegions = (this.selectedRegions ?? []).map((r) => copies.get(r) ?? r);
      if ([...copies.keys()].some((r) => this.editingLabelRegions.has(r))) {
        this.editingLabelRegions = new Map(
          [...this.editingLabelRegions].map(([r, d]) => [copies.get(r) ?? r, d]));
      }
    }
    return copies;
  }

  /** Set one region's outline colour (an explicit override) and commit live. */
  changeRegionColor(region: Region, color: string): void {
    if (!color || region.color === color) return;
    // colorOverridden: explicit per-region colour — preserve it against preset (re)apply (jit-ui#70)
    this.patchRegions((r) => (r === region ? { color, colorOverridden: true } : null));
    this.commit();
  }

  /**
   * After a label edit on `region`: give every labelled row without a colour its
   * class colour (preset or fallback, as the store will), and commit when
   * `commit` is set.
   */
  labelRegionUpdate(region: Region, commit = false) {
    this.fillClassColors();
    if (commit) this.commit();
  }

  /** Labelled rows without a colour get their class colour (copies). */
  private fillClassColors(): void {
    this.patchRegions((r) => (!r.color && r.label ? { color: this.colorForName(r.label) } : null));
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
      this.selectedRegions = [];
      this.commit(this.regions.filter((r) => !removed.has(r.id)));
      this.clampPaginatorFirst();
      // Sync the cleared selection with the plot's highlight state.
      this.onSelectionChanged();
    }
  }

  clearAllRegions() {
    this.confirmationService.confirm({
      key: 'positionDialog',
      message: 'Are you sure you want to delete all regions?',
      accept: () => {
        this.selectedRegions = [];
        this.paginatorFirst = 0;
        this.commit([]);
        this.onSelectionChanged();
      },
    });
  }

  deleteRegion(shapeIdx: number) {
    const removed = this.regions[shapeIdx];
    if (removed) {
      this.selectedRegions = this.selectedRegions.filter((r) => r.id !== removed.id);
    }
    this.commit(this.regions.filter((_, i) => i !== shapeIdx));
    this.clampPaginatorFirst();
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
    this.commit();
  }

  isEditingLabel(region: Region): boolean {
    return this.editingLabelRegions.has(region);
  }

  startEditLabel(region: Region, event?: Event): void {
    event?.stopPropagation(); // don't toggle row selection
    // A new map per start/stop, so the OnPush table sees the change.
    this.editingLabelRegions = new Map(this.editingLabelRegions).set(region, region.label ?? '');
  }

  /** The label typed so far for a row in edit mode (no re-render needed). */
  setLabelDraft(region: Region, value: string): void {
    if (this.editingLabelRegions.has(region)) this.editingLabelRegions.set(region, value);
  }

  stopEditLabel(region: Region, commit: boolean, event?: Event): void {
    event?.stopPropagation();
    const draft = this.editingLabelRegions.get(region);
    if (this.editingLabelRegions.has(region)) {
      const next = new Map(this.editingLabelRegions);
      next.delete(region);
      this.editingLabelRegions = next;
    }
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
    this.commit();
  }

  showHelp() {
    this.displayHelpDialog = true;
  }

  /** Open the colour dialog for the currently-selected region(s), building one
   *  colour picker per unique class in the selection. Each picker is seeded with
   *  the first selected region of that class's colour (else the class colour). */
  openColorDialog() {
    if (!this.selectedRegions?.length) return;
    const seedByLabel = new Map<string, string>();
    for (const region of this.selectedRegions) {
      const label = region.label?.trim() ?? '';
      if (seedByLabel.has(label)) continue;
      seedByLabel.set(label, region.color ?? (label ? this.colorForName(label) : this.shapeColor));
    }
    this.classColorEdits = [...seedByLabel].map(([label, color]) => ({ label, color }));
    this.showColorDialog = true;
  }

  /** Apply each class's chosen colour to the selected regions of that class (an
   *  explicit override) and commit live. */
  applyColorToSelected(edits: ClassColorEdit[] = this.classColorEdits) {
    const colorByLabel = new Map(edits.map((e) => [e.label, e.color]));
    const selected = new Set(this.selectedRegions ?? []);
    this.patchRegions((region) => {
      if (!selected.has(region)) return null;
      const label = region.label?.trim() ?? '';
      const color = colorByLabel.get(label);
      if (!color) return null;
      // explicit colour — preserve against preset (re)apply (jit-ui#70)
      return { color, colorOverridden: true };
    });
    this.commit();
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

  /** Number of regions currently using a class (keyed by the active match mode). */
  classCount(name: string): number {
    return this.classCounts.get(presetKey(this.presetSet, name)) ?? 0;
  }

  /** Recolour a class from its panel swatch and repaint its (non-overridden) regions. */
  setClassColor(name: string, color: string): void {
    if (!color) return;
    this.regionApi.setClassificationColor(name, color);
    this.commit();
  }

  /** Remove a class. Any regions still using it fall back to the default
   *  "Region" class, so they aren't orphaned (and the class isn't immediately
   *  re-added from its regions by syncClassesFromRegions). */
  deleteClass(name: string): void {
    this.reassignRegionsToDefaultClass([name]);
    this.regionApi.removeClass(name);
    if (this.activeClass === name) this.activeClass = null;
    this.commit();
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
    this.commit();
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
    this.commit();
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
    this.presetDraft = { ...draft, classes };
    // Classes dropped in the dialog: their regions revert to the default "Region"
    // class (else syncClassesFromRegions would just re-add them) (jit-ui#70).
    const kept = new Set(classes.map((c) => keyOf(c.name)));
    const removed = this.presetSet.classes
      .map((c) => c.name)
      .filter((n) => !kept.has(keyOf(n)));
    this.reassignRegionsToDefaultClass(removed);
    this.regionApi.setPresetSet(this.presetDraft);
    this.commit(); // recolour existing (non-overridden) regions from the new presets
    if (close) this.showManageDialog = false;
  }
  resetPresetsToDefaults(): void {
    this.regionApi.resetPresets();
    this.presetDraft = this.clonePresetSet(this.regionApi.getPresetSet());
    this.commit();
  }
  exportPresets(): void {
    const json = JSON.stringify(this.regionApi.getPresetSet(), null, 2);
    saveAs(new Blob([json], { type: 'application/json' }), 'annotation-classes.json');
  }
  importPresets(event: Event): void {
    this.persistence.readChosenFile(event, (text) => this.applyImportedPresets(text));
  }

  /** Validate and apply an imported annotation-classes JSON file. */
  private applyImportedPresets(text: string): void {
    try {
      const set = parsePresetSet(JSON.parse(text));
      if (!set) throw new Error('The file is not an annotation-class list (no valid classes).');
      this.regionApi.setPresetSet(set);
      this.presetDraft = this.clonePresetSet(this.regionApi.getPresetSet());
      this.commit();
      this.messageService.add({ key: VIZ_TOAST_KEY, severity: 'success',
        summary: 'Classes imported', detail: 'Annotation classes loaded.' });
    } catch (err) {
      this.messageService.add({ key: VIZ_TOAST_KEY, severity: 'error',
        summary: 'Import failed', detail: `${(err as Error)?.message ?? err}` });
    }
  }

  importRois(event: Event) {
    this.persistence.readChosenFile(event, (text) => this.applyImportedRois(text));
  }

  /** Replace the regions with an imported GeoJSON file's. */
  private applyImportedRois(text: string): void {
    try {
      this.regions = this.regionApi.importRegions(text);
      this.fillClassColors();
      this.commit();
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

  /** Regions to serialize on save/export (every slice for a combined z-stack). */
  private regionsForSave(): Region[] {
    return this.persistence.regionsForSave(this.regions);
  }

  exportRois() {
    if (!this.regionsForSave().length) return;
    this.exportFilename = this.persistence.defaultExportName();
    this.showExportDialog = true;
  }

  confirmExport() {
    const filename = this.exportFilename.trim();
    const regions = this.regionsForSave();
    if (!filename || !regions.length) return;
    this.showExportDialog = false;
    this.persistence.download(regions, filename);
  }

  /** Open the "Save mask" dialog, seeded with `<image-stem>_mask.png`. */
  openSaveMaskDialog() {
    if (!this.regions.length) return;
    this.saveMaskFilename = this.persistence.defaultMaskName();
    this.maskMode = 'binary';
    this.showSaveMaskDialog = true;
  }

  /**
   * Rasterize the regions to the chosen mask type and download as a PNG. The
   * heavy work runs in a Web Worker ({@link MaskExportService}) so the UI never
   * freezes on whole-slide images and the job can be cancelled (jit-ui#95);
   * the dialog stays open with a progress bar until done.
   */
  confirmSaveMask() {
    const filename = this.saveMaskFilename.trim();
    if (!filename || !this.regions.length || this.maskBusy) return;

    const size = this.regionApi.getMaskImageSize();
    if (!size) {
      this.maskError('No image size is available, so the mask cannot be sized.');
      return;
    }
    this.maskBusy = true;
    this.maskEncoding = false;
    this.maskProgress = 0;
    this.maskJob = this.maskExport.export({
      regions: this.regions, imageSize: size, mode: this.maskMode,
      sourceName: this.persistence.selectedFileName(),
    }).subscribe({
      next: (e) => {
        switch (e.type) {
          case 'planned':
            if (e.scale < 1) {
              this.messageService.add({
                key: VIZ_TOAST_KEY,
                severity: 'info',
                summary: 'Mask downscaled',
                detail: `Image too large for a full-resolution mask; saving at ${e.width}×${e.height}.`,
              });
            }
            break;
          case 'progress': this.maskProgress = e.percent; break;
          case 'encoding': this.maskEncoding = true; break;
          case 'done': this.finishMask(e.blob, filename); break;
        }
      },
      error: (err: Error) => this.maskError(err.message),
    });
  }

  /** Cancel an in-progress mask export (terminates its worker) and reset state. */
  cancelSaveMask() {
    this.maskJob?.unsubscribe();
    this.maskJob = undefined;
    this.maskBusy = false;
    this.maskEncoding = false;
    this.maskProgress = 0;
  }

  private finishMask(blob: Blob, filename: string) {
    this.maskJob = undefined;
    this.maskBusy = false;
    this.maskEncoding = false;
    this.showSaveMaskDialog = false;
    saveAs(blob, filename);
  }

  private maskError(detail: string) {
    this.maskJob = undefined;
    this.maskBusy = false;
    this.maskEncoding = false;
    this.messageService.add({
      key: VIZ_TOAST_KEY,
      severity: 'error',
      summary: 'Could not create mask',
      detail,
    });
  }

  persistRegions() {
    // Folder stack: write each slice's regions back to its own slice-file's
    // sibling geojson — no single-filename prompt (jit-ui#93).
    if (this.persistence.savesPerSlice()) {
      this.saveStackSlices();
      return;
    }
    const filename = this.persistence.defaultSaveName();
    if (!filename || !this.regionsForSave().length) return;

    this.saveAsFilename = filename;
    this.saveAsFileExists = false;
    this.showSaveAsDialog = true;
    this.saveAsCheck$.next(this.saveAsFilename);
  }

  /** Save a folder stack's regions as one geojson per slice-file (jit-ui#93). */
  private saveStackSlices() {
    const slices = this.persistence.sliceGeoJsons();
    if (!slices.length) return;
    this.saveAsBusy = true;
    this._saveAsSub = this.persistence.saveSlices(slices).subscribe({
      next: () => {
        this.saveAsBusy = false;
        this.toast('success', 'Regions saved', `Saved ROIs for ${slices.length} slice${slices.length === 1 ? '' : 's'}`);
      },
      error: (err) => {
        this.saveAsBusy = false;
        this.toast('error', 'Error saving regions', `${(err as Error)?.message ?? err}`);
      },
    });
  }

  checkSaveAsFileExists() {
    this.saveAsCheck$.next(this.saveAsFilename);
  }

  confirmSaveAs() {
    if (!this.persistence.selectedFileName()) return;

    const filename = this.saveAsFilename.trim();
    if (!filename) return;

    // Keep the dialog open showing an (indeterminate) progress bar while the
    // regions serialize and upload, then close on success.
    const doSave = () => {
      this.saveAsBusy = true;
      this._saveAsSub = this.persistence.save(() => this.regionsForSave(), filename).subscribe({
        next: () => {
          this.saveAsBusy = false;
          this.showSaveAsDialog = false;
          this.toast('success', 'Regions saved', `Saved as ${filename}`);
        },
        error: (err) => {
          this.saveAsBusy = false;
          this.toast('error', 'Error saving regions', `${(err as Error)?.message || err}`);
        },
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
    this._saveAsSub?.unsubscribe();
    this._saveAsSub = undefined;
    this.saveAsBusy = false;
  }

  private toast(severity: 'success' | 'error' | 'info', summary: string, detail: string): void {
    this.messageService.add({ key: VIZ_TOAST_KEY, severity, summary, detail });
  }
}
