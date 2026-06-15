import { Component, Inject, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { OverlayPanel } from 'primeng/overlaypanel';
import { saveAs } from 'file-saver';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, switchMap } from 'rxjs/operators';

import { Polygon, Rectangle, Region, MultiPolygon } from '../models/region';
import { IImageMetadata } from '../contracts/image.contract';
import { ConfirmationService, MessageService } from 'primeng/api';
import { IRegionEditorApi, REGION_EDITOR_API } from '../contracts/region-editor-api.contract';
import { RegionIoPort, REGION_IO_PORT } from '../contracts/ports/region-io.port';

@Component({
  // Canonical prefixed selector first; the unprefixed original is kept as an
  // alias for one release (pre-publication back-compat).
  selector: 'jaxviz-region-editor, region-editor',
  templateUrl: './region-editor.component.html',
  styleUrls: ['./region-editor.component.scss'],
})
export class RegionEditorComponent implements OnInit, OnDestroy {
  /** Maximum number of characters shown in the coordinates tooltip
   *  before it is truncated with an ellipsis. Keeps the tooltip readable
   *  for freeform polygons that may contain hundreds of points. */
  private static readonly TOOLTIP_MAX_LEN = 100;

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
  classificationColors: { label: string; color: string }[] = [];
  labelColors: Map<string, string> = new Map();
  selectedLabelColor = '';
  labelToEdit = '';
  paginatorFirst = 0;
  paginatorRows = 10;
  readonly rowsPerPageOptions = [10, 25, 50];
  /** Regions whose Class cell is currently in edit mode.
   *  Using object identity as the key avoids needing a unique id field. */
  editingLabelRegions = new Set<any>();

  showSaveAsDialog = false;
  saveAsFilename = '';
  saveAsFileExists = false;
  private _saveAsCheck$ = new Subject<string>();

  showExportDialog = false;
  exportFilename = '';

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
    // Seed from the visualizer's current regions — already scoped to the
    // active image by the per-image cache, and handed back as neutral Region
    // objects (no backend shape format involved).
    // Annotation regions only — intensity-profile lines are owned by the
    // intensity tool and excluded by the contract, so the editor never sees them.
    this.regions = this.applyRegionColors(this.regionApi.getAnnotationRegions());
    this.regionsCopy = this.deepClone(this.regions);

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

  addRectangle() {
    const region = new Region();
    region.bounds = new Rectangle();
    region.bounds.width = 512;
    region.bounds.height = 512;
    region.label = 'legend';
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
    region.label = 'legend';
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
  addCoordinate(region: Region) {
    const polygon = region.bounds;
    if (polygon && polygon instanceof Polygon) {
      polygon.coordinates.push([0, 0]);
      polygon.xpoints.push(0);
      polygon.ypoints.push(0);
      polygon.npoints += 1;
      this.setRegionsFromEditor();
    }
  }
  xCoordinateUpdate(region: Region, coordIdx: number, event: any) {
    const bounds = region.bounds;
    if (bounds instanceof Polygon) {
      bounds.coordinates[coordIdx][0] = event.value;
      bounds.xpoints[coordIdx] = event.value;
      this.setRegionsFromEditor();
    }
  }
  yCoordinateUpdate(region: Region, coordIdx: number, event: any) {
    const bounds = region.bounds;
    if (bounds instanceof Polygon) {
      bounds.coordinates[coordIdx][1] = event.value;
      bounds.ypoints[coordIdx] = event.value;
      this.setRegionsFromEditor();
    }
  }
  deleteCoordinate(region: Region, ri: number) {
    let coordinates: any[];
    const bounds = region.bounds;
    if (bounds instanceof Polygon) {
      coordinates = bounds.coordinates;
      coordinates.splice(ri, 1);
      bounds.xpoints.splice(ri, 1);
      bounds.ypoints.splice(ri, 1);
      bounds.npoints = coordinates.length;
      this.setRegionsFromEditor();
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

  truncateForTooltip(value: string): string {
    if (!value) return '';
    return value.length > RegionEditorComponent.TOOLTIP_MAX_LEN
      ? value.slice(0, RegionEditorComponent.TOOLTIP_MAX_LEN) + '…'
      : value;
  }

  showHelp() {
    this.displayHelpDialog = true;
  }

  openColorDialog() {
    // Edit the colours of every classification present in the region table — no
    // selection required.
    const uniqueLabels = [
      ...new Set(this.regions.filter((r) => r.label).map((r) => r.label as string)),
    ];
    this.classificationColors = uniqueLabels.map((label) => ({
      label,
      color: this.labelColors.get(label) ?? this.shapeColor,
    }));
    this.showColorDialog = true;
  }

  applyClassificationColors() {
    for (const entry of this.classificationColors) {
      this.labelColors.set(entry.label, entry.color);
      this.regionApi.setClassificationColor(entry.label, entry.color);
      for (const region of this.regions) {
        if (region.label === entry.label) {
          region.color = entry.color;
        }
      }
    }
    this.setRegionsFromEditor(this.fillColor);
    this.showColorDialog = false;
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

  exportRois() {
    if (!this.regions.length) return;
    const name = this.regionIo.getSelectedFileName();
    const stem = name ? name.substring(0, name.lastIndexOf('.')) : 'rois';
    this.exportFilename = `${stem}.geojson`;
    this.showExportDialog = true;
  }

  confirmExport() {
    const filename = this.exportFilename.trim();
    if (!filename || !this.regions.length) return;
    this.showExportDialog = false;
    const jsonString = this.regionApi.getGeoJsonString(this.regions);
    const blob = new Blob([jsonString], { type: 'application/json' });
    saveAs(blob, filename);
  }

  persistRegions() {
    const name = this.regionIo.getSelectedFileName();
    if (!name || !this.regions.length) return;

    this.saveAsFilename = name.substring(0, name.lastIndexOf('.')) + '.geojson';
    this.saveAsFileExists = false;
    this.showSaveAsDialog = true;
    this._saveAsCheck$.next(this.saveAsFilename);
  }

  checkSaveAsFileExists() {
    this._saveAsCheck$.next(this.saveAsFilename);
  }

  confirmSaveAs() {
    if (!this.regionIo.getSelectedFileName()) return;

    const filename = this.saveAsFilename.trim();
    if (!filename) return;

    const doSave = () => {
      this.showSaveAsDialog = false;
      const geoJsonStr = this.regionApi.getGeoJsonString(this.regions);
      this.regionIo.saveGeoJson(geoJsonStr, filename).subscribe({
        next: () => {
          this.messageService.add({
            key: 'app-toast',
            severity: 'success',
            summary: 'Regions saved',
            detail: `Saved as ${filename}`,
          });
        },
        error: (err) => {
          this.messageService.add({
            key: 'app-toast',
            severity: 'error',
            summary: 'Error saving regions',
            detail: `${err.message || err}`,
          });
        },
      });
    };

    if (this.saveAsFileExists) {
      this.showSaveAsDialog = false;
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
}
