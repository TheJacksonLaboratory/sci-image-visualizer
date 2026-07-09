import { Component, Inject, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { OverlayPanel } from 'primeng/overlaypanel';
import { saveAs } from 'file-saver';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, switchMap } from 'rxjs/operators';

import { Polygon, Rectangle, Region, MultiPolygon } from '../models/region';
import { PresetSet, ClassPreset, defaultPresetSet } from '../models/class-preset';
import { colorForLabel } from '../store/class-color.util';
import { IImageMetadata } from '../contracts/image.contract';
import { ConfirmationService, MessageService } from 'primeng/api';
import { IRegionEditorApi, REGION_EDITOR_API } from '../contracts/region-editor-api.contract';
import { RegionIoPort, REGION_IO_PORT } from '../contracts/ports/region-io.port';
import { regionToParts, scaleParts, maskScaleFor } from './mask-raster';

@Component({
  // Canonical prefixed selector first; the unprefixed original is kept as an
  // alias for one release (pre-publication back-compat).
  selector: 'jaxviz-region-editor, region-editor',
  templateUrl: './region-editor.component.html',
  styleUrls: ['./region-editor.component.scss'],
})
export class RegionEditorComponent implements OnInit, OnDestroy {
  protected readonly Array = Array;

  @ViewChild('op') overlayPanel!: OverlayPanel;

  regions: Region[] = [];
  regionsCopy: Region[] = [];
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
  selectedLabelColor = '';
  labelToEdit = '';

  // ── annotation-class presets (jit-ui#70) ──
  /** Local mirror of the per-user preset set (chip strip, Class dropdown, dialog). */
  presetSet: PresetSet = defaultPresetSet();
  /** Class applied to newly drawn/added regions and to bulk chip-clicks. */
  activeClass: string | null = null;
  showManageDialog = false;
  /** Working copy edited inside the Manage-classes dialog; committed on Apply/Done. */
  presetDraft: PresetSet | null = null;
  readonly matchModeOptions = [
    { label: 'Exact', value: 'exact' },
    { label: 'Normalized', value: 'normalized' },
  ];

  paginatorFirst = 0;
  paginatorRows = 10;
  readonly rowsPerPageOptions = [10, 25, 50];
  /** Regions whose Class cell is currently in edit mode.
   *  Using object identity as the key avoids needing a unique id field. */
  editingLabelRegions = new Set<any>();

  showSaveAsDialog = false;
  saveAsFilename = '';
  saveAsFileExists = false;
  /** True while a GeoJSON persist is serializing/uploading — drives the dialog's
   *  progress bar and Cancel button (parity with the Save-mask dialog). */
  saveAsBusy = false;
  private _saveAsCheck$ = new Subject<string>();
  private _saveAsSub?: Subscription;
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
   *  µm². Undefined when the format reports no physical size. */
  private mppX?: number;
  private mppY?: number;

  constructor(
    @Inject(REGION_EDITOR_API) private regionApi: IRegionEditorApi,
    public messageService: MessageService,
    private confirmationService: ConfirmationService,
    @Inject(REGION_IO_PORT) private regionIo: RegionIoPort,
  ) {}

  /**
   * Deep copy of regions for dirty-tracking (`regionsCopy`). Returns plain-object
   * clones — only structural equality matters here, not prototypes.
   * TODO: replace with `structuredClone` once verified.
   */
  private deepClone<T>(items: T[]): T[] {
    return items.map((item) => {
      if (Array.isArray(item)) {
        return this.deepClone(item) as unknown as T;
      } else if (typeof item === 'object' && item !== null) {
        const cloned: any = {};
        for (const key in item) {
          cloned[key] = this.deepClone([item[key]])[0];
        }
        return cloned;
      }
      return item;
    });
  }

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
      this._presetSub = presets$.subscribe((set) => { if (set) this.presetSet = set; });
    }
    // Seed from the visualizer's current regions — already scoped to the
    // active image by the per-image cache, and handed back as neutral Region
    // objects (no backend shape format involved).
    // Annotation regions only — intensity-profile lines are owned by the
    // intensity tool and excluded by the contract, so the editor never sees them.
    this.regions = this.applyRegionColors(this.regionApi.getAnnotationRegions());
    this.regionsCopy = this.deepClone(this.regions);
    this.syncClassesFromRegions(this.regions);

    // The update event is just a change signal; re-read the regions from the
    // visualizer rather than parsing whatever payload it carries.
    this._regionSub = this.regionApi.getRegionUpdateEvent().subscribe(() => {
      if (this._updatingFromEditor) return;
      const updated = this.applyRegionColors(this.regionApi.getAnnotationRegions());
      // preserve selection for regions that still exist (by id, since name
      // is a user-editable display label and may collide)
      const selectedIds = new Set(this.selectedRegions.map((r) => r.id));
      this.regions = updated;
      this.regionsCopy = this.deepClone(this.regions);
      this.selectedRegions = updated.filter((r) => selectedIds.has(r.id));
      this.clampPaginatorFirst();
      this.syncClassesFromRegions(updated);
    });

    this._saveAsCheck$.pipe(
      debounceTime(400),
      switchMap(name => this.regionIo.roiFileExists(name)),
    ).subscribe({
      next: exists => { this.saveAsFileExists = exists; },
      error: () => { this.saveAsFileExists = false; },
    });

    // Physical pixel size of the active image (for region areas in µm²/mm²).
    // Mirror PlotlyService.currentMpp: the calibration may sit on any channel
    // entry, not necessarily [0], so pick the first entry with a positive mppX
    // rather than reading [0] blindly. Fall back to square pixels (mppY = mppX)
    // when only one axis is reported.
    this._metaSub = this.regionApi.getImageMeta().subscribe((meta) => {
      const { mppX, mppY } = this.pickMpp(meta);
      this.mppX = mppX;
      this.mppY = mppY;
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
  }

  /** Set one region's outline colour from the per-row picker and commit live.
   *  Remembers it as the label's colour so same-class regions added later match
   *  (jit-ui#85 — the Region Editor's per-region Color column). */
  changeRegionColor(region: Region, color: string): void {
    if (!color || region.color === color) return;
    region.color = color;
    region.colorOverridden = true; // explicit per-region colour — preserve it against preset (re)apply (jit-ui#70)
    if (region.label) this.labelColors.set(region.label, color);
    this.setRegionsFromEditor();
  }

  addRectangle() {
    const region = new Region();
    region.bounds = new Rectangle();
    region.bounds.width = 512;
    region.bounds.height = 512;
    region.label = this.activeClass ?? 'legend';
    // id and a non-colliding name are minted by the visualizer's setRegions
    this.regions = [...this.regions, region];
    this.setRegionsFromEditor();
    this.regionsCopy = this.deepClone(this.regions);
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
    for (const reg of this.regions) {
      if (!reg.color) {
        if (reg.label && this.labelColors.has(reg.label)) {
          reg.color = this.labelColors.get(reg.label);
        }
      }
    }
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
  xRectUpdate(region: Region, event: any) {
    const rectangle = region.bounds;
    if (rectangle && rectangle instanceof Rectangle) {
      rectangle.x = event.value;
      this.setRegionsFromEditor();
    }
  }
  yRectUpdate(region: Region, event: any) {
    const rectangle = region.bounds;
    if (rectangle && rectangle instanceof Rectangle) {
      rectangle.y = event.value;
      this.setRegionsFromEditor();
    }
  }
  widthRectUpdate(region: Region, event: any) {
    if (event.value === null || event.value === undefined) return;
    const rectangle = region.bounds;
    if (rectangle && rectangle instanceof Rectangle) {
      const reg = this.regionsCopy.filter((element: Region) => element.id === region.id);
      if (reg.length) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const oldWidth = reg[0].bounds.width;
        const diffWidth = event.value - oldWidth;
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        rectangle.x = Math.round(reg[0].bounds.x - diffWidth / 2);
      }
      rectangle.width = event.value;
      this.setRegionsFromEditor();
      this.regionsCopy = this.deepClone(this.regions);
    }
  }
  heightRectUpdate(region: Region, event: any) {
    if (event.value === null || event.value === undefined) return;
    const rectangle = region.bounds;
    if (rectangle && rectangle instanceof Rectangle) {
      const reg = this.regionsCopy.filter((element: Region) => element.id === region.id);
      if (reg.length) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const oldHeight = reg[0].bounds.height;
        const diffHeight = event.value - oldHeight;
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        rectangle.y = Math.round(reg[0].bounds.y - diffHeight / 2);
      }
      rectangle.height = event.value;
      this.setRegionsFromEditor();
      this.regionsCopy = this.deepClone(this.regions);
    }
  }

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

  saveEditedLabel() {
    if (this.selectedRegions && this.selectedRegions.length > 0) {
      this.selectedRegions.forEach((region) => {
        region.label = this.labelToEdit;
        this.labelRegionUpdate(region, false);
      });
      this.setRegionsFromEditor();
      this.overlayPanel.hide();
    }
  }

  addPolygon() {
    const region = new Region();
    region.bounds = new Polygon();
    region.label = this.activeClass ?? 'legend';
    region.bounds.ypoints = [0, 0, 0];
    region.bounds.xpoints = [0, 0, 0];
    region.bounds.coordinates = [
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    region.bounds.npoints = 3;
    this.regions = [...this.regions, region];
    this.setRegionsFromEditor();
    this.regionsCopy = this.deepClone(this.regions);
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

  isEditingLabel(region: any): boolean {
    return this.editingLabelRegions.has(region);
  }

  startEditLabel(region: any, event?: Event): void {
    event?.stopPropagation(); // don't toggle row selection
    this.editingLabelRegions.add(region);
  }

  stopEditLabel(region: any, commit: boolean, event?: Event): void {
    event?.stopPropagation();
    this.editingLabelRegions.delete(region);
    if (commit) {
      this.labelRegionUpdate(region, true);
    }
  }

  isRectangle(region: Region) {
    return region.bounds instanceof Rectangle;
  }

  /**
   * Region area for display: in µm² (or mm²) when the image reports a physical
   * pixel size, otherwise in px². Empty string for degenerate regions.
   */
  regionArea(region: Region): string {
    const px = this.areaInPixels(region);
    if (px <= 0) return '';
    if (this.mppX && this.mppY && this.mppX > 0 && this.mppY > 0) {
      const um2 = px * this.mppX * this.mppY;
      return um2 >= 1e6 ? `${this.fmtArea(um2 / 1e6)} mm²` : `${this.fmtArea(um2)} µm²`;
    }
    return `${this.fmtArea(px)} px²`;
  }

  /**
   * Choose the physical pixel size (µm/pixel) for area display from the image
   * meta. The calibration may sit on any channel entry — not necessarily [0] —
   * so pick the first entry with a positive mppX (mirrors
   * PlotlyService.currentMpp). Falls back to square pixels (mppY = mppX) when
   * only one axis is reported, so a scaled image shows µm²/mm² rather than px².
   */
  private pickMpp(meta: IImageMetadata[] | undefined): { mppX?: number; mppY?: number } {
    const m = Array.isArray(meta)
      ? (meta.find((e) => e && (e.mppX ?? 0) > 0) ?? meta[0])
      : undefined;
    const mx = m && (m.mppX ?? 0) > 0 ? (m.mppX as number) : undefined;
    const my = m && (m.mppY ?? 0) > 0 ? (m.mppY as number) : undefined;
    return { mppX: mx, mppY: my ?? mx };
  }

  /** Pixel area: width·height for rectangles, shoelace formula for polygons.
   *  Interior rings (holes) are subtracted, so a donut reports the annulus area,
   *  not the filled exterior (jit-ui#85). */
  private areaInPixels(region: Region): number {
    const b = region.bounds;
    if (b instanceof Rectangle) return Math.abs(b.width * b.height);
    if (b instanceof Polygon) return this.polygonArea(b);
    // Multi-part region: sum each part's (exterior − holes) area (jit-ui#85).
    if (b instanceof MultiPolygon) {
      return b.polygons.reduce((sum, p) => sum + this.polygonArea(p), 0);
    }
    return 0;
  }

  /** Polygon area: exterior shoelace minus each interior ring (hole). */
  private polygonArea(p: Polygon): number {
    if ((p.xpoints?.length ?? 0) < 3) return 0;
    let a = this.ringArea(p.xpoints, p.ypoints);
    if (p.holes) {
      for (const ring of p.holes) a -= this.ringArea(ring.map(pt => pt[0]), ring.map(pt => pt[1]));
    }
    return Math.max(0, a);
  }

  /** Absolute shoelace area of a single ring. */
  private ringArea(xs: number[], ys: number[]): number {
    const n = xs?.length ?? 0;
    if (n < 3) return 0;
    let a = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) a += (xs[j] + xs[i]) * (ys[j] - ys[i]);
    return Math.abs(a / 2);
  }

  private fmtArea(n: number): string {
    return (n >= 1000 ? Math.round(n) : Math.round(n * 100) / 100).toLocaleString();
  }

  /**
   * This method rounds all the rectangle regions lengths to multiple of 512
   */
  roundRectangleLengths() {
    for (const region of this.regions) {
      if (region.bounds instanceof Rectangle) {
        const rect = region.bounds;
        rect.height = Math.round(rect.height / 512) * 512;
        rect.width = Math.round(rect.width / 512) * 512;
      }
    }
    this.setRegionsFromEditor();
  }

  /**
   * Stop key arrow event propagation
   * @param event
   */
  disableArrowKeys(event: any) {
    if (
      event.key === 'ArrowDown' ||
      event.key === 'Down' ||
      event.key === 'ArrowUp' ||
      event.key === 'Up' ||
      event.key === 'ArrowLeft' ||
      event.key === 'Left' ||
      event.key === 'ArrowRight' ||
      event.key === 'Right'
    ) {
      event.stopPropagation();
    }
  }

  changeShapeColor(event: any) {
    this.shapeColor = event.value;
    for (const region of this.regions) {
      if (region.label === this.selectedLabelColor && this.labelColors.has(region.label)) {
        this.labelColors.set(region.label, this.shapeColor);
        region.color = this.shapeColor;
      }
    }
    this.setRegionsFromEditor(this.fillColor);
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
    for (const region of this.selectedRegions ?? []) {
      const label = region.label?.trim() ?? '';
      const color = colorByLabel.get(label);
      if (!color) continue;
      region.color = color;
      region.colorOverridden = true; // explicit colour — preserve against preset (re)apply (jit-ui#70)
      if (label) this.labelColors.set(label, color);
    }
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
    const normalized = this.presetSet.matchMode === 'normalized';
    const keyOf = (l: string) => (normalized ? l.trim().toLowerCase() : l);
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

  /** Stamp a class (and its preset/fallback colour) onto one region from the Class
   *  dropdown; choosing a class opts the region back into the preset colour. */
  applyPresetToRegion(region: Region, className: string): void {
    const name = (className ?? '').trim();
    region.label = name;
    region.colorOverridden = false;
    if (name) region.color = colorForLabel(name, this.presetSet);
    this.setRegionsFromEditor();
  }

  /** Make a class active (used for new regions) and, if rows are selected, apply
   *  it to them in one commit. */
  selectActiveClass(name: string): void {
    this.activeClass = name;
    const selected = this.selectedRegions ?? [];
    if (selected.length) {
      for (const r of selected) {
        r.label = name;
        r.colorOverridden = false;
        r.color = colorForLabel(name, this.presetSet);
      }
      this.setRegionsFromEditor();
    }
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
    const seen = new Set<string>();
    const classes: ClassPreset[] = [];
    for (const c of this.presetDraft.classes) {
      const name = (c.name ?? '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      classes.push({ ...c, name });
    }
    this.presetDraft.classes = classes;
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
    reader.onload = (e: any) => {
      try {
        const set = JSON.parse(e.target.result) as PresetSet;
        this.regionApi.setPresetSet(set);
        this.presetDraft = this.clonePresetSet(this.regionApi.getPresetSet());
        this.setRegionsFromEditor();
        this.messageService.add({ key: 'app-toast', severity: 'success',
          summary: 'Classes imported', detail: 'Annotation classes loaded.' });
      } catch (err) {
        this.messageService.add({ key: 'app-toast', severity: 'error',
          summary: 'Import failed', detail: `${err}` });
      }
    };
    reader.readAsText(file);
  }

  importRois(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e: any) => {
      const fileContent = e.target.result;
      try {
        this.regions = this.regionApi.importRegions(fileContent);
        // set label colors
        for (const region of this.regions) {
          this.labelRegionUpdate(region, false);
        }
        this.syncClassesFromRegions(this.regions);
        this.setRegionsFromEditor();
      } catch (event) {
        this.messageService.add({
          severity: 'error',
          summary: 'Error importing the file',
          detail: `${event}`,
        });
        console.error('Error reading the file: ' + event);
      }
    };
    reader.readAsText(file);
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
    const name = this.regionIo.getSelectedFileName();
    const stem = name ? name.substring(0, name.lastIndexOf('.')) : 'rois';
    this.exportFilename = `${stem}.geojson`;
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
    const name = this.regionIo.getSelectedFileName();
    // Strip the extension only when there is one; an extension-less name keeps
    // its whole stem (a leading-dot dotfile is treated as having no extension)
    // so we never produce a bare "_mask.png".
    const dot = name ? name.lastIndexOf('.') : -1;
    const stem = name ? (dot > 0 ? name.substring(0, dot) : name) : 'regions';
    this.saveMaskFilename = `${stem}_mask.png`;
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
        key: 'app-toast',
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
      key: 'app-toast',
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

    this.saveAsFilename = name.substring(0, name.lastIndexOf('.')) + '.geojson';
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
          key: 'app-toast',
          severity: 'success',
          summary: 'Regions saved',
          detail: `Saved ROIs for ${slices.length} slice${slices.length === 1 ? '' : 's'}`,
        });
      },
      error: (err) => {
        this.saveAsBusy = false;
        this.messageService.add({
          key: 'app-toast',
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
            key: 'app-toast',
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
              key: 'app-toast',
              severity: 'success',
              summary: 'Regions saved',
              detail: `Saved as ${filename}`,
            });
          },
          error: (err) => {
            this.saveAsBusy = false;
            this.messageService.add({
              key: 'app-toast',
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
