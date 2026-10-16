import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  Inject,
  Input,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
  NgZone,
} from '@angular/core';
import { markForCheckInZone } from '../util/mark-for-check';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DropdownModule } from 'primeng/dropdown';
import { InputTextModule } from 'primeng/inputtext';
import { OverlayPanel, OverlayPanelModule } from 'primeng/overlaypanel';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import { saveAs } from 'file-saver';
import { Subject, Subscription } from 'rxjs';

import { Rectangle, Region } from '../models/region';
import { withRegionPatch } from '../models/region-clone';
import { PresetSet, ClassPreset, defaultPresetSet, parsePresetSet } from '../models/class-preset';
import { colorForLabel, presetKey } from '../store/class-color.util';
import { ConfirmationService, MessageService, SharedModule } from 'primeng/api';
import { IRegionEditorApi, REGION_EDITOR_API } from '../contracts/region-editor-api.contract';
import { VIZ_TOAST_KEY } from '../toast-outlets';
import { HttpClient } from '@angular/common/http';
import type { RegionSourceOpener } from '../store/region-source-scope';
import { openGeoJsonRegionSource } from '../region-source/worker-region-source';
import { openHttpRegionSource } from '../region-source/http-region-source';
import { readLabelVolume } from '../region-import/label-volume';
import { labelClasses, labelSliceGeoJson } from '../region-import/label-classes';
import {
  RegionImportFile,
  folderSliceGeoJson,
  importFile,
  planRegionImport,
} from '../region-import/region-import';
import { RegionPersistenceService, SliceGeoJson } from './region-persistence.service';
import { ClassColorEdit, RegionColorDialogComponent } from './region-color-dialog/region-color-dialog.component';
import { ClassesPanelComponent } from './classes-panel/classes-panel.component';
import { RegionTableComponent } from './region-table/region-table.component';
import { ClassTreeComponent, ClassTreePick } from './class-tree/class-tree.component';
import type { RegionSourceView } from '../region-source/region-source';
import type { RegionClassNode, RegionIndexRow } from '../region-source/region-tiles';
import { SaveRegionsDialogComponent } from './save-regions-dialog/save-regions-dialog.component';
import { SaveMaskDialogComponent } from './save-mask-dialog/save-mask-dialog.component';
import { ManageClassesDialogComponent } from './manage-classes-dialog/manage-classes-dialog.component';
import { RegionEditorHelpComponent } from './region-editor-help/region-editor-help.component';
import { MaskExportService, MaskMode } from './mask-export.service';
import { PixelSize, formatArea, pickMpp, regionAreaPx } from './region-metrics';

/**
 * The Region Editor (`<region-editor>`): the table of the active image's
 * annotation regions with class presets, colours, labels, GeoJSON import /
 * export / server save and mask export. Self-contained: it talks to the viewer
 * only through {@link REGION_EDITOR_API} (and the host's REGION_IO_PORT), so it
 * has no inputs or outputs.
 *
 * OnPush: template events re-render it; state that lands asynchronously (the
 * API's region / selection / preset / image-meta streams, save and mask-export
 * progress, file reads) marks it for check.
 */
/** The opacity the fill toggle fills regions at. */
const REGION_FILL_OPACITY = 0.6;

/** "Select all" takes at most this many region-source features into the regions. */
const SELECT_ALL_SOURCE_LIMIT = 5000;

@Component({
  selector: 'region-editor',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SharedModule,
    ButtonModule,
    ConfirmDialogModule,
    DropdownModule,
    InputTextModule,
    OverlayPanelModule,
    ToolbarModule,
    TooltipModule,
    ClassesPanelComponent,
    RegionTableComponent,
    ClassTreeComponent,
    SaveRegionsDialogComponent,
    SaveMaskDialogComponent,
    RegionColorDialogComponent,
    ManageClassesDialogComponent,
    RegionEditorHelpComponent,
  ],
  templateUrl: './region-editor.component.html',
  styleUrls: ['./region-editor.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [RegionPersistenceService],
})
export class RegionEditorComponent implements OnInit, OnDestroy {
  @ViewChild('op') private overlayPanel!: OverlayPanel;

  /**
   * Whether the editor is on screen (its dialog open). Closed, it asks the region source nothing:
   * its page of features, its class counts and, in a volume view, its classes' volumes are each a
   * request over the whole set (a stack's every slice), and they competed with the volume's own
   * slice loading for nothing anyone could see. Opened, it reads them again.
   */
  @Input() set active(value: boolean) {
    const was = this.isActive;
    this.isActive = value;
    if (value && !was) {
      void this.refreshSource();
      this.resetVolumes();
    }
  }
  private isActive = true;
  /** The host's HttpClient: a served region set's requests go through it (its auth). */
  private readonly http = inject(HttpClient, { optional: true });

  protected regions: Region[] = [];
  protected selectedRegions: Region[] = [];
  protected showShapeLabel!: boolean;
  protected shapeColor!: string;
  protected fillColor!: string;
  protected displayHelpDialog = false;
  protected showColorDialog = false;
  /** One colour editor per unique class among the selected regions, shown in the
   *  "edit colour of selected regions" dialog. Unclassified regions (no label)
   *  are grouped under a single entry with an empty `label`. */
  protected classColorEdits: ClassColorEdit[] = [];
  /** "Edit class on selected rows" popup: chosen existing class, and a new-class name. */
  protected bulkClass = '';
  protected newBulkClass = '';

  // ── annotation-class presets (jit-ui#70) ──
  /** Local mirror of the per-user preset set (chip strip, Class dropdown, dialog). */
  protected presetSet: PresetSet = defaultPresetSet();
  /** The class last picked in the panel; a chip-click applies it to the selected rows. */
  protected activeClass: string | null = null;
  protected showManageDialog = false;
  /** Working copy edited inside the Manage-classes dialog; committed on Apply/Done. */
  protected presetDraft: PresetSet | null = null;
  /** class name (match-mode keyed) → number of regions currently using it. */
  protected classCounts = new Map<string, number>();
  /** Fallback class that a region reverts to when its class is deleted (jit-ui#70). */
  protected readonly defaultClassName = 'Region';
  /** Classes as shown in the panel: sorted by region count (desc), then name. */
  protected displayClasses: ClassPreset[] = [];

  protected paginatorFirst = 0;
  protected paginatorRows = 10;
  protected readonly rowsPerPageOptions = [10, 25, 50];
  /** Regions whose Class cell is currently in edit mode → the label being typed.
   *  The draft is committed on Enter and discarded on Escape/✕, so typing never
   *  writes into the store's region (RT-18). Keyed by object identity, which
   *  avoids needing a unique id field. */
  protected editingLabelRegions = new Map<Region, string>();

  protected showSaveAsDialog = false;
  /**
   * The slice's region source (a large region set drawn by level of detail), or null. Its
   * features are rows of the table after the regions — stand-ins until one is selected or edited,
   * which takes it into the regions — and its classes count in the classes panel.
   */
  protected sourceView: RegionSourceView | null = null;
  /** Features still in the source (the table's rows after the regions). */
  private sourceTotal = 0;
  /** Stand-in rows for the source features on the current page. */
  private sourceRows: Region[] = [];
  /** Features per class still in the source. */
  private sourceClassCounts: Record<string, number> = {};
  /** The stand-in rows (rows of a source feature, not of a region). */
  private readonly standIns = new WeakSet<Region>();
  private standInSeq = 0;
  /** Bumped per source refresh, so a late answer is dropped. */
  private sourceRequest = 0;
  /** The classes the table's Class column offers: the presets and the region source's classes
   *  (a dropdown can only show a value that is one of its options). */
  protected tablePresetSet: PresetSet = defaultPresetSet();
  /** Whether regions are drawn filled (the atlas look) rather than outlined. */
  protected regionsFilled = false;
  /** Whether a volume view is on screen (classes can then be shown in 3D). */
  protected volumeView = false;
  /** Whether the volume view's slice pane is wanted (one slice edited beside the 3D view). */
  private slicePane = false;
  /** Whether the volume view draws the regions through the volume (see toggleThroughVolume). */
  protected regionsThroughVolume = false;
  /** Classes shown in 3D in the volume view, each with the classes its surface covers. */
  protected shown3d = new Map<string, string[]>();
  /** The classes of the class tree's pick (it and its subtree), as long as the pick holds. */
  private pickedClasses: readonly string[] = [];
  /** The selected rows' classes, marked in the class lists. */
  protected markedClasses: ReadonlySet<string> = new Set();
  /** The surfaces highlighted in the volume view (their keys, joined). */
  private highlighted3d = '';
  /** The colour each shown surface was last drawn in. */
  private colors3d = new Map<string, string>();
  /** Their names, for the class lists' toggles (a new set per change, for OnPush). */
  protected shown3dNames: ReadonlySet<string> = new Set();
  /** The classes hidden from view (their regions, source features and surfaces). */
  protected hiddenClasses: ReadonlySet<string> = new Set();
  /** Whether a region set's class hierarchy is shown as a tree (rather than the class list). */
  protected classTreeView = true;
  /** The class picked last in the class tree. */
  protected pickedClass: string | null = null;
  /** Regions per class (the regions' and the source's), for the class tree. */
  protected treeCounts = new Map<string, number>();
  /** A class's colour, for the class tree: a new function per colour change, so the tree repaints. */
  protected treeColor = (name: string): string => colorForLabel(name, this.presetSet);
  protected saveAsFilename = '';
  protected saveAsFileExists = false;
  /** True while a GeoJSON persist is serializing/uploading — drives the dialog's
   *  progress bar and Cancel button (parity with the Save-mask dialog). */
  protected saveAsBusy = false;
  /** The running GeoJSON save; unsubscribing cancels it (Cancel / destroy). */
  private _saveAsSub?: Subscription;
  /** Save-as file names to check for an existing file (debounced). */
  private readonly saveAsCheck$ = new Subject<string>();

  protected showExportDialog = false;
  protected exportFilename = '';

  protected showSaveMaskDialog = false;
  protected saveMaskFilename = '';
  /** Mask type chosen in the Save-mask dialog: a binary foreground/background
   *  mask, or a multi-class mask with a distinct id per region. */
  protected maskMode: MaskMode = 'binary';
  /** True while the mask worker is rasterizing/encoding — drives the progress
   *  bar and the Cancel button in the dialog. */
  protected maskBusy = false;
  /** 0–100 rasterization progress; switches to indeterminate during encoding. */
  protected maskProgress = 0;
  protected maskEncoding = false;
  /** The running mask export; unsubscribing cancels it (terminates its worker). */
  private maskJob?: Subscription;

  /**
   * PrimeNG p-table multi-selection mode toggle. When true, single-click
   * selects one row (replacing prior); meta/ctrl-click toggles a row in/out
   * of the selection. When false, every click toggles. Default true to
   * match the most common spreadsheet-like UX.
   */
  protected metaKey = true;

  private _updatingFromEditor = false;
  private _suppressSelectionSyncToPlot = false;
  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly zone = inject(NgZone);

  /** Re-render this OnPush view, re-entering the zone when the change came from outside it. */
  private changed(): void {
    markForCheckInZone(this.cdr, this.zone);
  }

  /** Physical pixel size (µm/pixel) of the active image, for region areas in
   *  µm²; empty when the format reports no physical size. */
  protected mpp: PixelSize = {};

  constructor(
    @Inject(REGION_EDITOR_API) private regionApi: IRegionEditorApi,
    private messageService: MessageService,
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
      presets$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((set) => {
        if (set) this.presetSet = set;
        this.treeColor = (name: string): string => colorForLabel(name, this.presetSet);
        this.updateDisplayClasses();
        this.recolor3d();
        this.changed();
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
    this.regionApi
      .getRegionUpdateEvent()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
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
        if (this.volumeView) this.resetVolumes();
        this.changed();
        void this.refreshSource();
      });

    this.regionApi
      .getRegionSourceView$?.()
      ?.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((view) => {
        if (view?.source !== this.sourceView?.source) this.pickedClass = null;
        this.sourceView = view;
        void this.refreshSource();
      });

    this.regionApi
      .getRegionStyle$?.()
      ?.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((style) => {
        this.regionsFilled = style.fillOpacity > 0;
        this.changed();
      });

    this.regionApi
      .getVolumeView$?.()
      ?.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((volume) => {
        const counting = this.stackCounts;
        this.volumeView = volume;
        this.resetVolumes();
        this.changed();
        if (this.stackCounts !== counting) void this.refreshSource();
      });

    this.regionApi
      .getRegionsThroughVolume$?.()
      ?.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((through) => {
        this.regionsThroughVolume = through;
        this.changed();
      });

    this.regionApi
      .getSliceEditor$?.()
      ?.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((pane) => {
        const counting = this.stackCounts;
        this.slicePane = pane;
        if (this.stackCounts !== counting) void this.refreshSource();
      });

    // What is shown in 3D: the router clears it when another image is plotted.
    this.regionApi
      .getRegionClasses3d$?.()
      ?.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((groups) => {
        this.shown3d = new Map(groups.map((g) => [g.key, [...g.classes]]));
        this.shown3dNames = new Set(this.shown3d.keys());
        this.highlighted3d = '';
        this.updateSelectionHighlight();
        this.changed();
      });

    this.regionApi
      .getHiddenClasses$?.()
      ?.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((hidden) => {
        this.hiddenClasses = hidden;
        this.changed();
      });

    // A surface clicked in the volume view (with the selection tool) picks its class.
    this.regionApi
      .getRegionPicked3d$?.()
      ?.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ key, additive }) => this.onPicked3d(key, additive));

    this.persistence
      .fileExists(this.saveAsCheck$)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((exists) => {
        this.saveAsFileExists = exists;
        this.changed();
      });

    // Physical pixel size of the active image (for region areas in µm²/mm²).
    this.regionApi
      .getImageMeta()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((meta) => {
        this.mpp = pickMpp(meta);
        this.changed();
      });

    this.regionApi
      .getSelectedRegions$()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((selected) => {
        if (this._suppressSelectionSyncToPlot) return;
        // Map the contract's selected regions to the editor's own instances by id.
        const next = selected.map((s) => this.regions.find((r) => r.id === s.id)).filter((r): r is Region => !!r);
        const same =
          next.length === this.selectedRegions.length &&
          next.every((r, i) => r.id === this.selectedRegions[i]?.id);
        if (!same) this.selectedRegions = next;
        this.updateSelectionHighlight();
        // Scroll the paginator so the most-recently-selected row is visible.
        if (next.length > 0) {
          const lastIdx = this.regions.findIndex((r) => r.id === next[next.length - 1].id);
          if (lastIdx >= 0) {
            const pageStart = Math.floor(lastIdx / this.paginatorRows) * this.paginatorRows;
            if (pageStart !== this.paginatorFirst) this.paginatorFirst = pageStart;
          }
        }
        this.changed();
      });
  }

  /** Cancels a running GeoJSON save (aborts its upload) and mask export (terminates
   *  its worker); the API subscriptions end through `takeUntilDestroyed`. */
  ngOnDestroy() {
    this._saveAsSub?.unsubscribe();
    this.maskJob?.unsubscribe();
  }

  /**
   * Table → Plot: PrimeNG fires onRowSelect/onRowUnselect after updating
   * `selectedRegions`. Push the selected regions to the contract by identity —
   * the package maps them to its internal index space (which includes the
   * intensity-profile lines the editor never sees).
   */
  protected onSelectionChanged() {
    const selected = this.selectedRegions ?? [];
    // Rows picked in the table replace the class tree's pick.
    this.pickedClasses = [];
    this.updateSelectionHighlight();
    const fromSource = selected.filter((r) => this.standIns.has(r));
    this._suppressSelectionSyncToPlot = true;
    try {
      this.regionApi.setSelectedRegions(selected.filter((r) => !this.standIns.has(r)));
    } finally {
      this._suppressSelectionSyncToPlot = false;
    }
    // A selected source row is taken into the regions (and so selected on the image too).
    if (fromSource.length) void this.regionApi.selectSourceFeatures?.(this.sourceIds(fromSource), true);
  }

  // ── The region source's features as table rows ───────────────────────

  /** Whether the slice has a region source: it then has regions to save even with an empty table. */
  protected get hasRegionSource(): boolean {
    return !!this.sourceView;
  }

  /** Rows in the table: the regions, then the features still in the region source. */
  protected get tableTotal(): number {
    return this.regions.length + this.sourceTotal;
  }

  /** The class hierarchy of the slice's region source, when it has one (the classes as a tree). */
  protected get classHierarchy(): RegionClassNode[] | null {
    return this.sourceView?.source.info.hierarchy ?? null;
  }

  /** Whether `row` is a region-source feature's stand-in rather than a region. */
  protected isSourceRow(row: Region): boolean {
    return this.standIns.has(row);
  }

  private sourceIds(rows: Region[]): string[] {
    return rows.map((r) => r.sourceId).filter((id): id is string => !!id);
  }

  /** A table row for a source feature: no geometry until it is taken. */
  private standIn(row: RegionIndexRow): Region {
    const r = Object.assign(new Region(), {
      id: -++this.standInSeq,
      name: row.label ?? row.id,
      label: row.label ?? undefined,
      color: this.sourceView?.colorOf(row) ?? row.color ?? this.shapeColor,
      sourceId: row.id,
      sourceArea: row.area,
      bounds: null,
    });
    this.standIns.add(r);
    return r;
  }

  /**
   * Re-read the source part of the table (the stand-ins on the current page, the count) and the
   * source's class counts. The page holds regions first, so its source rows start at
   * `max(first, regions)` − regions.
   */
  private async refreshSource(): Promise<void> {
    if (!this.isActive) return;
    const request = ++this.sourceRequest;
    const view = this.sourceView;
    let rows: RegionIndexRow[] = [];
    let total = 0;
    let counts: Record<string, number> = {};
    if (view && this.regionApi.getRegionSourceIndex) {
      const own = this.regions.length;
      const start = Math.max(this.paginatorFirst, own);
      const limit = Math.max(0, this.paginatorFirst + this.paginatorRows - start);
      try {
        const [page, perClass] = await Promise.all([
          this.regionApi.getRegionSourceIndex({ offset: start - own, limit }),
          this.regionApi.getRegionSourceClassCounts?.(this.stackCounts),
        ]);
        rows = page?.rows ?? [];
        total = page?.total ?? 0;
        counts = perClass ?? {};
      } catch (err) {
        console.warn('[regions] could not list the region source', err);
      }
    }
    if (request !== this.sourceRequest) return;
    this.sourceTotal = total;
    this.sourceRows = rows.map((r) => this.standIn(r));
    this.sourceClassCounts = counts;
    this.recomputeClassCounts();
    this.changed();
  }

  /** Take a source row's feature into the regions, then run `then` on the region it became. */
  private async takeThen(row: Region, then: (region: Region) => void): Promise<void> {
    const [id] = (await this.regionApi.selectSourceFeatures?.(this.sourceIds([row]))) ?? [];
    const region = this.regions.find((r) => r.id === id);
    if (region) then(region);
  }

  /** Toggle the filled (atlas) look: each region filled in its colour, labels inside. */
  /** In a volume view: the regions drawn through the volume, or hidden behind what it shows. */
  protected toggleThroughVolume(): void {
    this.regionApi.setRegionsThroughVolume?.(!this.regionsThroughVolume);
  }

  protected toggleFill(): void {
    this.regionApi.setRegionStyle?.({ fillOpacity: this.regionsFilled ? 0 : REGION_FILL_OPACITY });
  }

  /**
   * Show or hide a class in the volume view as a 3D reconstruction — a tree node with every class
   * under it, as one surface in its colour.
   */
  protected toggleClass3d(name: string, classes: string[] = [name]): void {
    const next = new Map(this.shown3d);
    if (next.has(name)) next.delete(name);
    else next.set(name, classes);
    this.shown3d = next;
    this.shown3dNames = new Set(next.keys());
    this.changed();
    this.show3d(this.groups3d());
    this.updateSelectionHighlight();
  }

  /** Hide (or show again) these classes' regions, wherever they are drawn. */
  protected setClassesHidden(classes: readonly string[], hidden: boolean): void {
    this.regionApi.setClassesHidden?.(classes, hidden);
  }

  /** The surfaces shown in 3D, in their classes' colours now. */
  private groups3d(): Array<{ key: string; classes: string[]; color: string; label: string }> {
    const titles = new Map((this.classHierarchy ?? []).map((n) => [n.name, n.title]));
    return [...this.shown3d].map(([key, classes]) => {
      const title = titles.get(key);
      return { key, classes, color: this.treeColor(key), label: title ? `${key} · ${title}` : key };
    });
  }

  /** The classes selected now: the class tree's pick (with its subtree) and the selected rows'. */
  private selectedClassNames(): Set<string> {
    const names = new Set(this.pickedClasses);
    for (const r of this.selectedRegions ?? []) if (r.label) names.add(r.label);
    return names;
  }

  /**
   * Highlight, in the volume view, the surfaces holding a selected class (focus + context: they
   * turn near opaque, the others fade), and mark the selected rows' classes in the class lists.
   */
  private updateSelectionHighlight(): void {
    const names = this.selectedClassNames();
    const marked = new Set((this.selectedRegions ?? []).map((r) => r.label).filter((l): l is string => !!l));
    if ([...marked].join('\n') !== [...this.markedClasses].join('\n')) this.markedClasses = marked;
    const keys = [...this.shown3d].filter(([, classes]) => classes.some((c) => names.has(c))).map(([k]) => k);
    const id = keys.join('\n');
    if (id === this.highlighted3d) return;
    this.highlighted3d = id;
    this.regionApi.highlightRegionClasses3d?.(keys);
  }

  /** A surface clicked in the volume view: pick its class as the tree would; beside them, clear. */
  private onPicked3d(key: string | null, additive: boolean): void {
    if (key === null) {
      if (additive) return;
      this.pickedClass = null;
      this.pickedClasses = [];
      this.selectedRegions = [];
      this.onSelectionChanged();
      this.changed();
      return;
    }
    void this.pickClasses({ name: key, classes: this.shown3d.get(key) ?? [key], additive });
  }

  /** A class colour changed (its swatch, or Manage): repaint the surfaces shown in 3D whose colour it changed. */
  private recolor3d(): void {
    const groups = this.groups3d();
    if (!groups.some((g) => g.color !== this.colors3d.get(g.key))) return;
    this.show3d(groups);
  }

  private show3d(groups: Array<{ key: string; classes: string[]; color: string }>): void {
    this.colors3d = new Map(groups.map((g) => [g.key, g.color]));
    this.regionApi.showRegionClasses3d?.(groups).catch((err) => {
      this.toast('error', 'Could not show the region in 3D', `${(err as Error)?.message ?? err}`);
    });
  }

  /** Pick a class in the class tree: select its regions and its subclasses', the source's taken. */
  protected async pickClasses(pick: ClassTreePick): Promise<void> {
    this.pickedClass = pick.name;
    this.pickedClasses = pick.additive ? [...new Set([...this.pickedClasses, ...pick.classes])] : pick.classes;
    this.updateSelectionHighlight();
    this.changed();
    await this.regionApi.selectRegionClasses?.(pick.classes, pick.additive);
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
    return regions.map((region) =>
      region.color
        ? region
        : withRegionPatch(region, { color: classColors.get(region.label ?? '') || this.shapeColor }),
    );
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
    this.changed();
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
        this.editingLabelRegions = new Map([...this.editingLabelRegions].map(([r, d]) => [copies.get(r) ?? r, d]));
      }
    }
    return copies;
  }

  /** Set one region's outline colour (an explicit override) and commit live. */
  protected changeRegionColor(region: Region, color: string): void {
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
  protected labelRegionUpdate(region: Region, commit = false) {
    this.fillClassColors();
    if (commit) this.commit();
  }

  /** Labelled rows without a colour get their class colour (copies). */
  private fillClassColors(): void {
    this.patchRegions((r) => (!r.color && r.label ? { color: this.colorForName(r.label) } : null));
  }

  /** The current page of the table. Memoized on (regions, first, rows), so
   *  change detection doesn't hand p-table a new array every tick (RT-20). */
  protected get pagedRegions(): Region[] {
    const key = this._pageKey;
    if (
      key.regions !== this.regions ||
      key.source !== this.sourceRows ||
      key.first !== this.paginatorFirst ||
      key.rows !== this.paginatorRows
    ) {
      this._pageKey = {
        regions: this.regions,
        source: this.sourceRows,
        first: this.paginatorFirst,
        rows: this.paginatorRows,
      };
      const own = this.regions.slice(this.paginatorFirst, this.paginatorFirst + this.paginatorRows);
      this._page =
        own.length >= this.paginatorRows
          ? own
          : [...own, ...this.sourceRows.slice(0, this.paginatorRows - own.length)];
      // A new page may show classes whose volume is not known yet (after this check).
      if (this.volumeView) queueMicrotask(() => this.requestVolumes());
    }
    return this._page;
  }

  /** In a volume view, each class's volume over the whole stack, for the table (null: areas). */
  protected tableVolumes: ReadonlyMap<string, number | null> | null = null;
  /** Bumped when the regions change, so a volume computed before is dropped. */
  private volumeRequest = 0;

  /** Compute the volumes of the classes on the table's page that are not known yet. */
  private requestVolumes(): void {
    const api = this.regionApi.getClassVolumes?.bind(this.regionApi);
    // Closed: asked for again when it opens (see active).
    if (!this.isActive) return;
    if (!this.volumeView || !api) {
      if (this.tableVolumes) {
        this.tableVolumes = null;
        this.changed();
      }
      return;
    }
    const known = this.tableVolumes ?? new Map<string, number | null>();
    const labels = new Set(this.pagedRegions.map((r) => r.label).filter((l): l is string => !!l));
    const missing = [...labels].filter((l) => !known.has(l));
    if (!missing.length && this.tableVolumes) return;
    this.tableVolumes = new Map([...known, ...missing.map((l): [string, null] => [l, null])]);
    this.changed();
    if (!missing.length) return;
    const request = this.volumeRequest;
    api(missing).then(
      (volumes) => {
        if (request !== this.volumeRequest || !this.tableVolumes) return;
        this.tableVolumes = new Map([...this.tableVolumes, ...Object.entries(volumes)]);
        this.changed();
      },
      (err) => {
        if (request !== this.volumeRequest || !this.tableVolumes) return;
        // Leave them unknown ('—') rather than computing forever.
        const next = new Map(this.tableVolumes);
        for (const l of missing) next.delete(l);
        this.tableVolumes = next;
        this.changed();
        console.warn('[regions] could not compute class volumes', err);
      },
    );
  }

  /** The regions changed (or the view did): forget the volumes and compute the page's again. */
  private resetVolumes(): void {
    this.volumeRequest++;
    this.tableVolumes = null;
    this.requestVolumes();
  }
  private _pageKey: { regions?: Region[]; source?: Region[]; first?: number; rows?: number } = {};
  private _page: Region[] = [];

  protected onPageChange(event: { first?: number; rows?: number }) {
    this.paginatorFirst = event.first ?? 0;
    this.paginatorRows = event.rows ?? this.paginatorRows;
    void this.refreshSource();
  }

  /** Select every region in the table (and highlight them on the diagram), the source's taken. */
  protected async selectAllRegions() {
    this.selectedRegions = [...this.regions];
    this.onSelectionChanged();
    if (!this.sourceTotal || !this.regionApi.getRegionSourceIndex) return;
    const page = await this.regionApi.getRegionSourceIndex({ offset: 0, limit: SELECT_ALL_SOURCE_LIMIT });
    const ids = (page?.rows ?? []).map((r) => r.id);
    if (ids.length) await this.regionApi.selectSourceFeatures?.(ids, true);
  }

  protected deleteSelectedRegions() {
    if (this.selectedRegions && this.selectedRegions.length > 0) {
      const fromSource = this.selectedRegions.filter((r) => this.standIns.has(r));
      if (fromSource.length) this.regionApi.deleteSourceFeatures?.(this.sourceIds(fromSource));
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

  protected clearAllRegions() {
    this.confirmationService.confirm({
      key: 'positionDialog',
      message: 'Are you sure you want to delete all regions?',
      accept: () => {
        this.selectedRegions = [];
        this.paginatorFirst = 0;
        this.commit([]);
        this.onSelectionChanged();
        if (this.hasRegionSource) void this.deleteAllSourceFeatures();
      },
    });
  }

  /** Delete every feature still in the slice's region source (with "Delete all regions"). */
  private async deleteAllSourceFeatures(): Promise<void> {
    const index = this.regionApi.getRegionSourceIndex;
    if (!index || !this.regionApi.deleteSourceFeatures) return;
    const page = await index.call(this.regionApi, { offset: 0, limit: Number.MAX_SAFE_INTEGER });
    if (page?.rows.length) this.regionApi.deleteSourceFeatures(page.rows.map((r) => r.id));
  }

  protected deleteRegion(shapeIdx: number) {
    // A row past the regions is a source feature: delete it from the source.
    if (shapeIdx >= this.regions.length) {
      const row = this.sourceRows[shapeIdx - Math.max(this.paginatorFirst, this.regions.length)];
      if (row) this.regionApi.deleteSourceFeatures?.(this.sourceIds([row]));
      return;
    }
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
    const maxFirst = Math.max(0, Math.floor((this.tableTotal - 1) / this.paginatorRows) * this.paginatorRows);
    if (this.paginatorFirst > maxFirst) {
      this.paginatorFirst = maxFirst;
    }
  }
  protected changeShowShapeLabel(showLabel: boolean) {
    this.commit();
  }

  protected isEditingLabel(region: Region): boolean {
    return this.editingLabelRegions.has(region);
  }

  protected startEditLabel(region: Region, event?: Event): void {
    event?.stopPropagation(); // don't toggle row selection
    if (this.standIns.has(region)) {
      void this.takeThen(region, (r) => this.startEditLabel(r));
      return;
    }
    // A new map per start/stop, so the OnPush table sees the change.
    this.editingLabelRegions = new Map(this.editingLabelRegions).set(region, region.label ?? '');
  }

  /** The label typed so far for a row in edit mode (no re-render needed). */
  protected setLabelDraft(region: Region, value: string): void {
    if (this.editingLabelRegions.has(region)) this.editingLabelRegions.set(region, value);
  }

  protected stopEditLabel(region: Region, commit: boolean, event?: Event): void {
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
  protected regionArea(region: Region): string {
    return formatArea(regionAreaPx(region), this.mpp);
  }

  /**
   * This method rounds all the rectangle regions lengths to multiple of 512
   */
  protected roundRectangleLengths() {
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

  protected showHelp() {
    this.displayHelpDialog = true;
  }

  /** Open the colour dialog for the currently-selected region(s), building one
   *  colour picker per unique class in the selection. Each picker is seeded with
   *  the first selected region of that class's colour (else the class colour). */
  protected openColorDialog() {
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
  protected applyColorToSelected(edits: ClassColorEdit[] = this.classColorEdits) {
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
  protected colorForName(name?: string): string {
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

  /**
   * Whether the classes count every slice of the stack: in a volume view (the whole stack on
   * screen), unless its slice pane shows one slice. The table lists the slice's regions anyway.
   */
  private get stackCounts(): boolean {
    return this.volumeView && !this.slicePane;
  }

  /** Rebuild the per-class region counts shown in the panel (the stack's, see stackCounts). */
  private recomputeClassCounts(): void {
    const counts = new Map<string, number>();
    const tree = new Map<string, number>();
    const add = (label: string, n: number) => {
      const k = presetKey(this.presetSet, label);
      counts.set(k, (counts.get(k) ?? 0) + n);
      tree.set(label, (tree.get(label) ?? 0) + n);
    };
    const regions = this.stackCounts ? this.regionApi.getSliceAnnotationRegions() : this.regions;
    for (const r of regions) if (r.label) add(r.label, 1);
    // The region source's classes count too (its features are rows of the table).
    for (const [label, n] of Object.entries(this.sourceClassCounts)) add(label, n);
    this.classCounts = counts;
    this.treeCounts = tree;
    this.updateDisplayClasses();
  }

  /** Rebuild the panel's display order — most-used classes first, then by name. A class only
   *  the region source has is listed too, in its colour. */
  private updateDisplayClasses(): void {
    const known = new Set(this.presetSet.classes.map((c) => presetKey(this.presetSet, c.name)));
    const fromSource: ClassPreset[] = [];
    for (const label of Object.keys(this.sourceClassCounts)) {
      const k = presetKey(this.presetSet, label);
      if (known.has(k)) continue;
      known.add(k);
      fromSource.push({ name: label, color: colorForLabel(label, this.presetSet) });
    }
    this.tablePresetSet = fromSource.length
      ? { ...this.presetSet, classes: [...this.presetSet.classes, ...fromSource] }
      : this.presetSet;
    this.displayClasses = [...this.presetSet.classes, ...fromSource].sort((a, b) => {
      const d = this.classCount(b.name) - this.classCount(a.name);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
  }

  /** Number of regions currently using a class (keyed by the active match mode). */
  protected classCount(name: string): number {
    return this.classCounts.get(presetKey(this.presetSet, name)) ?? 0;
  }

  /** Recolour a class from its panel swatch and repaint its (non-overridden) regions. */
  protected setClassColor(name: string, color: string): void {
    if (!color) return;
    this.regionApi.setClassificationColor(name, color);
    this.commit();
  }

  /** Remove a class. Any regions still using it fall back to the default
   *  "Region" class, so they aren't orphaned (and the class isn't immediately
   *  re-added from its regions by syncClassesFromRegions). */
  protected deleteClass(name: string): void {
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
  protected applyPresetToRegion(region: Region, className: string): void {
    if (this.standIns.has(region)) {
      void this.takeThen(region, (r) => this.applyPresetToRegion(r, className));
      return;
    }
    const name = (className ?? '').trim();
    const patch: Partial<Region> = { label: name, colorOverridden: false };
    if (name) patch.color = colorForLabel(name, this.presetSet);
    this.patchRegions((r) => (r === region ? patch : null));
    this.commit();
  }

  /** Make a class active (used for new regions) and, if rows are selected, apply
   *  it to them in one commit. */
  protected selectActiveClass(name: string): void {
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
  protected applyBulkClass(): void {
    if (!this.bulkClass) return;
    this.applyClassToSelected(this.bulkClass);
    this.overlayPanel?.hide();
  }

  /** "Edit class on selected rows" popup — add a new class and set it on the selection. */
  protected addAndApplyBulkClass(): void {
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
  protected openManageDialog(): void {
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
  protected applyManageDialog(close: boolean): void {
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
    const removed = this.presetSet.classes.map((c) => c.name).filter((n) => !kept.has(keyOf(n)));
    this.reassignRegionsToDefaultClass(removed);
    this.regionApi.setPresetSet(this.presetDraft);
    this.commit(); // recolour existing (non-overridden) regions from the new presets
    if (close) this.showManageDialog = false;
  }
  protected resetPresetsToDefaults(): void {
    this.regionApi.resetPresets();
    this.presetDraft = this.clonePresetSet(this.regionApi.getPresetSet());
    this.commit();
  }
  protected exportPresets(): void {
    const json = JSON.stringify(this.clonePresetSet(this.regionApi.getPresetSet()), null, 2);
    saveAs(new Blob([json], { type: 'application/json' }), 'annotation-classes.json');
  }
  protected importPresets(event: Event): void {
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
      this.messageService.add({
        key: VIZ_TOAST_KEY,
        severity: 'success',
        summary: 'Classes imported',
        detail: 'Annotation classes loaded.',
      });
    } catch (err) {
      this.messageService.add({
        key: VIZ_TOAST_KEY,
        severity: 'error',
        summary: 'Import failed',
        detail: `${(err as Error)?.message ?? err}`,
      });
    }
    this.changed();
  }

  /** The files chosen in the import inputs: one GeoJSON, a label volume with its ontology, or a
   *  folder of per-slice GeoJSON files. */
  protected importRois(event: Event) {
    const files = Array.from((event.target as HTMLInputElement).files ?? []);
    if (files.length) void this.importRegionFiles(files.map((f) => importFile(f, f.webkitRelativePath || f.name)));
  }

  /** Whether the host can pick regions on its server ("Import regions from server"). */
  protected get canImportFromServer(): boolean {
    return this.persistence.canPickServerRegions();
  }
  /** An import from the server is in flight. */
  protected importing = false;

  /** "Import regions from server": the host picks files or a served region set; they import as chosen files do. */
  protected importFromServer(): void {
    this.importing = true;
    this.changed();
    this.persistence.pickServerRegions().subscribe({
      next: (pick) => {
        if (!pick) return;
        if (pick.kind === 'files') {
          void this.importRegionFiles(pick.files.map((f) => importFile(f.data, f.name)));
          return;
        }
        void this.importServedRegionSet(pick.url, pick.name);
      },
      error: (err) => this.importFailed(err),
      complete: () => {
        this.importing = false;
        this.changed();
      },
    });
  }

  /**
   * Import `files` (see planRegionImport): one GeoJSON file as before; a label volume as one
   * region source per slice, traced from it the first time the slice is shown, its classes named
   * (and treed) by the ontology chosen with it; a folder as one source per slice file. Either
   * replaces the regions and sources of every slice.
   */
  private async importRegionFiles(files: RegionImportFile[]): Promise<void> {
    const plan = planRegionImport(files);
    if (!plan) {
      this.importFailed(
        new Error('Choose a GeoJSON file, a folder of GeoJSON files, or a .nii, .nii.gz or .nrrd label volume.'),
      );
      return;
    }
    if (plan.kind === 'single') {
      await this.applyImportedRois(await plan.file.text());
      return;
    }
    const attach = this.regionApi.importSliceRegionSources?.bind(this.regionApi);
    if (!attach) {
      this.importFailed(new Error('This viewer cannot hold region sources.'));
      return;
    }
    try {
      const openers = new Map<number, RegionSourceOpener>();
      let summary: string;
      if (plan.kind === 'volume') {
        const volume = await readLabelVolume(plan.volume.name, await plan.volume.bytes());
        const classes = labelClasses(plan.ontology ? JSON.parse(await plan.ontology.text()) : undefined);
        for (let z = 0; z < volume.slices; z++) {
          openers.set(z, () => openGeoJsonRegionSource(labelSliceGeoJson(volume, z, classes)));
        }
        summary = `${volume.slices} slices of ${volume.width} × ${volume.height}`;
        this.warnIfSizeDiffers(volume.width, volume.height);
      } else {
        const regionSet = plan.regionSet ? JSON.parse(await plan.regionSet.text()) : null;
        plan.slices.forEach((file, z) =>
          openers.set(z, async () => openGeoJsonRegionSource(await folderSliceGeoJson(file, regionSet))),
        );
        summary = `${plan.slices.length} slice files`;
      }
      const attached = attach(openers);
      this.afterSourceImport();
      this.toast(
        'success',
        'Regions imported',
        `${summary}; ${attached} slice${attached === 1 ? '' : 's'} annotated.`,
      );
    } catch (err) {
      this.importFailed(err);
    }
  }

  /** A region set the host's server serves (jit-service's /regions/{id}/), read through its HttpClient. */
  private async importServedRegionSet(url: string, name?: string): Promise<void> {
    const importSource = this.regionApi.importRegionSourceOpener?.bind(this.regionApi);
    if (!importSource) {
      this.importFailed(new Error('This viewer cannot hold region sources.'));
      return;
    }
    try {
      await importSource(() => openHttpRegionSource(url, { http: this.http ?? undefined }));
      this.afterSourceImport();
      this.toast('success', 'Regions imported', name ?? url);
    } catch (err) {
      this.importFailed(err);
    }
  }

  /** The table and selection after the regions were replaced by imported sources. */
  private afterSourceImport(): void {
    this.selectedRegions = [];
    this.paginatorFirst = 0;
    this.commit([]);
    this.onSelectionChanged();
  }

  /** Warn when an imported volume's slices are not the image's size: its outlines would not fit. */
  private warnIfSizeDiffers(width: number, height: number): void {
    const meta = this.regionApi.getMaskImageSize();
    if (meta && (meta.width !== width || meta.height !== height)) {
      this.toast(
        'info',
        'Different size',
        `The volume's slices are ${width} × ${height}; the image is ${meta.width} × ${meta.height}.`,
      );
    }
  }

  private importFailed(err: unknown): void {
    this.importing = false;
    this.messageService.add({
      key: VIZ_TOAST_KEY,
      severity: 'error',
      summary: 'Error importing regions',
      detail: `${(err as Error)?.message ?? err}`,
    });
    console.error('Error importing regions:', err);
    this.changed();
  }

  /**
   * Replace the regions with an imported GeoJSON file's, and the slice's region source with them.
   * A large file becomes the slice's region source instead (drawn by level of detail; listed above
   * the table), the table emptied.
   */
  private async applyImportedRois(text: string): Promise<void> {
    try {
      if (await this.regionApi.importRegionSource?.(text)) {
        this.selectedRegions = [];
        this.paginatorFirst = 0;
        this.commit([]);
        this.onSelectionChanged();
        return;
      }
      // Parsed first: a file that is not GeoJSON leaves the source alone.
      const regions = this.regionApi.importRegions(text);
      await this.regionApi.dropRegionSource?.();
      this.regions = regions;
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

  protected exportRois() {
    if (!this.regionsForSave().length && !this.hasRegionSource) return;
    this.exportFilename = this.persistence.defaultExportName();
    this.showExportDialog = true;
  }

  protected confirmExport() {
    const filename = this.exportFilename.trim();
    const regions = this.regionsForSave();
    if (!filename || (!regions.length && !this.hasRegionSource)) return;
    this.showExportDialog = false;
    this.persistence
      .download(regions, filename)
      .catch((err) => this.toast('error', 'Error exporting regions', `${(err as Error)?.message ?? err}`));
  }

  /** Open the "Save mask" dialog, seeded with `<image-stem>_mask.png`. */
  protected openSaveMaskDialog() {
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
  protected confirmSaveMask() {
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
    this.maskJob = this.maskExport
      .export({
        regions: this.regions,
        imageSize: size,
        mode: this.maskMode,
        sourceName: this.persistence.selectedFileName(),
      })
      .subscribe({
        next: (e) => {
          this.changed();
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
            case 'progress':
              this.maskProgress = e.percent;
              break;
            case 'encoding':
              this.maskEncoding = true;
              break;
            case 'done':
              this.finishMask(e.blob, filename);
              break;
          }
        },
        error: (err: Error) => {
          this.maskError(err.message);
          this.changed();
        },
      });
  }

  /** Cancel an in-progress mask export (terminates its worker) and reset state. */
  protected cancelSaveMask() {
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

  protected persistRegions() {
    // Folder stack: write each slice's regions back to its own slice-file's
    // sibling geojson — no single-filename prompt (jit-ui#93).
    if (this.persistence.savesPerSlice()) {
      this.saveStackSlices();
      return;
    }
    const filename = this.persistence.defaultSaveName();
    if (!filename || (!this.regionsForSave().length && !this.hasRegionSource)) return;

    this.saveAsFilename = filename;
    this.saveAsFileExists = false;
    this.showSaveAsDialog = true;
    this.saveAsCheck$.next(this.saveAsFilename);
  }

  /** Save a folder stack's regions as one geojson per slice-file (jit-ui#93).
   *  No dialog covers the toolbar meanwhile, so a Save while one is uploading
   *  is ignored rather than starting a second write (and orphaning the first). */
  private async saveStackSlices() {
    if (this.saveAsBusy) return;
    this.saveAsBusy = true;
    let slices: SliceGeoJson[];
    try {
      slices = await this.persistence.sliceGeoJsons();
    } catch (err) {
      this.saveAsBusy = false;
      this.changed();
      this.toast('error', 'Error saving regions', `${(err as Error)?.message ?? err}`);
      return;
    }
    // Cancelled while the slices serialized, or nothing to write.
    if (!this.saveAsBusy || !slices.length) {
      this.saveAsBusy = false;
      return;
    }
    this._saveAsSub = this.persistence.saveSlices(slices).subscribe({
      next: () => {
        this.saveAsBusy = false;
        this.changed();
        this.toast(
          'success',
          'Regions saved',
          `Saved ROIs for ${slices.length} slice${slices.length === 1 ? '' : 's'}`,
        );
      },
      error: (err) => {
        this.saveAsBusy = false;
        this.changed();
        this.toast('error', 'Error saving regions', `${(err as Error)?.message ?? err}`);
      },
    });
  }

  protected checkSaveAsFileExists() {
    this.saveAsCheck$.next(this.saveAsFilename);
  }

  protected confirmSaveAs() {
    if (!this.persistence.selectedFileName()) return;

    const filename = this.saveAsFilename.trim();
    if (!filename) return;

    // Keep the dialog open showing an (indeterminate) progress bar while the
    // regions serialize and upload, then close on success.
    const doSave = () => {
      this.saveAsBusy = true;
      // Also run from the overwrite confirmation, which the host's dialog may answer.
      this.changed();
      this._saveAsSub = this.persistence
        .save(() => this.regionsForSave(), filename)
        .subscribe({
          next: () => {
            this.saveAsBusy = false;
            this.showSaveAsDialog = false;
            this.changed();
            this.toast('success', 'Regions saved', `Saved as ${filename}`);
          },
          error: (err) => {
            this.saveAsBusy = false;
            this.changed();
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
  protected cancelSaveAs() {
    this._saveAsSub?.unsubscribe();
    this._saveAsSub = undefined;
    this.saveAsBusy = false;
  }

  private toast(severity: 'success' | 'error' | 'info', summary: string, detail: string): void {
    this.messageService.add({ key: VIZ_TOAST_KEY, severity, summary, detail });
  }
}
