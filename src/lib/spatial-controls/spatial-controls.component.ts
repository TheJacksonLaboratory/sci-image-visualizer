import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  EventEmitter,
  Inject,
  Input,
  NgZone,
  OnInit,
  Output,
  ViewChild,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { TooltipModule } from 'primeng/tooltip';
import { combineLatest } from 'rxjs';

import { VISUALIZER, IVisualizer, ISpatialControls } from '../contracts/visualizer.contract';
import { SpatialChartsComponent } from './spatial-charts/spatial-charts.component';
import { SpatialDataset } from '../contracts/spatial-dataset.contract';
import { ColormapNode, SpatialViewState, DEFAULT_SPATIAL_VIEW } from '../contracts/display-types';
import { PanelOption, parseGeneGroups } from '../spatial/spatial-panel-model';
import { SpatialSelectionMask, emptySelection } from '../spatial/spatial-selection';
import { GenePickerModel } from './spatial-gene-picker';
import { SpatialKeyModel, SpatialLegendEntry } from './spatial-key/spatial-key.model';
import { colorByLabel } from './spatial-key/spatial-key.component';
import { SpatialCellsPanelComponent } from './spatial-cells-panel/spatial-cells-panel.component';
import { SpatialTranscriptsPanelComponent } from './spatial-transcripts-panel/spatial-transcripts-panel.component';
import { SpatialObservationsPanelComponent } from './spatial-observations-panel/spatial-observations-panel.component';

/** @deprecated Moved to `spatial-key/spatial-key.model`; re-exported for one release. */
export type { SpatialLegendEntry };

/** @deprecated Moved to `spatial/spatial-panel-model`; re-exported for one release. */
export { parseGeneGroups };

/** Per-instance id source — see {@link SpatialControlsComponent.chartsBodyId}. */
let controlsInstanceSeq = 0;

/**
 * Spatial-omics controls: a non-modal, resizable, draggable dialog for choosing
 * what the observation markers are coloured by, and how they are drawn.
 *
 * Depends only on {@link ISpatialControls}, reached through the `VISUALIZER`
 * contract token — never a concrete backend — mirroring how
 * `ChannelHistogramComponent` depends only on `CHANNEL_HISTOGRAM_API`. When no
 * host has bound `SPATIAL_DATA_PORT`, `getSpatialControls()` returns null and
 * the dialog renders an explanatory empty state rather than dead controls.
 *
 * The legend swatches and the continuous colour bar are built with the SAME
 * functions the renderer uses (`categoryColors` → `resolveCategoryColors`,
 * `spatialContinuousLut`), so the key cannot drift from what is on screen.
 *
 * OnPush: the controls' streams, the key and gene-list models (which re-enter the zone
 * when their async work lands) and an awaited category selection mark it for check.
 */
@Component({
  selector: 'spatial-controls',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CheckboxModule,
    DialogModule,
    TooltipModule,
    SpatialCellsPanelComponent,
    SpatialTranscriptsPanelComponent,
    SpatialObservationsPanelComponent,
    SpatialChartsComponent,
  ],
  templateUrl: './spatial-controls.component.html',
  styleUrls: ['./spatial-controls.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialControlsComponent implements OnInit {
  /** The embedded chart, so a dialog resize can re-fit it. */
  @ViewChild(SpatialChartsComponent) private charts?: SpatialChartsComponent;

  /**
   * Re-fit the chart after the dialog is resized.
   *
   * Plotly does not follow a container resize on its own — its `responsive`
   * option listens for WINDOW resizes only, so dragging the dialog's handle
   * reaches it through nothing. PrimeNG tells us when the drag ends, which is a
   * far more direct signal than watching boxes, and firing once on release means
   * no relayout churn during the drag.
   */
  protected onResizeEnd(): void {
    this.charts?.resize();
  }

  /** Dialog visibility, two-way bound so a toolbar button can open it. */
  @Input() visible = false;
  /** Set while the 3D cloud is the active mode. Changes what the ROI selection
   *  MEANS — a screen-space lasso cutting through the cloud's full depth rather
   *  than a shape in tissue coordinates — so the hint below it says so. */
  @Input() is3d = false;
  /** The dialog was opened or closed; two-way with {@link visible}. */
  @Output() visibleChange = new EventEmitter<boolean>();

  /** Null when the host bound no `SPATIAL_DATA_PORT`. */
  protected controls: ISpatialControls | null = null;
  protected dataset: SpatialDataset | null = null;
  protected view: SpatialViewState = { ...DEFAULT_SPATIAL_VIEW };

  /**
   * Gene picker: a filterable dropdown rather than a free-text typeahead, so the
   * options are visible before anything is typed and each keystroke narrows a list
   * the user can see. One model feeds every gene dropdown of the panel.
   */
  protected readonly genes = new GenePickerModel(
    () => this.controls,
    () => [
      ...(this.view?.transcriptGenes ?? []),
      ...(this.view?.colorBy?.kind === 'feature' ? [this.view.colorBy.name] : []),
    ],
    (fn) => this.runAndMark(fn),
  );
  /** The gene dropdowns' options. */
  get geneOptions(): PanelOption<string>[] {
    return this.genes.options;
  }
  /** True when the options come from the port per keystroke rather than a resident list. */
  get genesAreRemote(): boolean {
    return this.genes.remote;
  }
  get geneSearchFailed(): boolean {
    return this.genes.failed;
  }

  /** The key — legend or colour bar — for the active colouring. Kept here, not in
   *  `<spatial-key>`: whether the colouring is categorical decides which knobs the rest of
   *  the panel offers, whether or not the key is on screen. */
  readonly key = new SpatialKeyModel((fn) => this.runAndMark(fn));
  /** Categorical key, or null when the active colouring is continuous. */
  protected get legend(): SpatialLegendEntry[] | null {
    return this.key.legend;
  }
  /** CSS gradient for a continuous colouring, or null when categorical. */
  protected get colorBarCss(): string | null {
    return this.key.colorBarCss;
  }

  /** Current selection — drives the count, the Clear button and the muting. */
  protected selection: SpatialSelectionMask = emptySelection();
  /** The legend row whose category is currently selected, for highlighting. */
  protected selectedCategory: number | null = null;
  /** An ROI selection that matched nothing, so the UI can say so rather than
   *  looking like the button did nothing. */
  protected selectionMissed = false;

  /**
   * Whether the Distribution section is expanded. Collapsed by default: the
   * panel's primary job is the colour controls, and the chart roughly doubles
   * its height.
   */
  protected chartsOpen = false;
  /** Per-instance id for the collapsible body, so `aria-controls` points at one
   *  element and expanding the second panel cannot scroll the first one's chart. */
  protected readonly chartsBodyId = `sc-charts-body-${++controlsInstanceSeq}`;

  /** Colormap tree for the continuous colour scale and the density map: the library's
   *  own `COLORMAP_OPTIONS`. */
  protected colormapOptions: ColormapNode[] = [];

  private colormap: ColormapNode | null = null;
  private reverse = false;
  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);

  constructor(
    @Inject(VISUALIZER) private readonly viz: IVisualizer,
    private readonly zone: NgZone,
  ) {}

  ngOnInit(): void {
    this.controls = this.viz.getSpatialControls?.() ?? null;
    this.colormapOptions = this.viz.getColormapOptions?.() ?? [];
    if (!this.controls) return;

    const untilDestroyed = <T>() => takeUntilDestroyed<T>(this.destroyRef);
    this.controls
      .getDataset$()
      .pipe(untilDestroyed())
      .subscribe((dataset) => {
        this.dataset = dataset;
        this.genes.setDataset(dataset);
        // A dataset with no cells to outline leads with its observations.
        this.open = {
          ...this.open,
          cells: !!(dataset?.polygonTiles || dataset?.polygons),
          observations: !(dataset?.polygonTiles || dataset?.polygons),
        };
        void this.refreshKey();
        this.cdr.markForCheck();
      });

    this.controls
      .getViewState$()
      .pipe(untilDestroyed())
      .subscribe((view) => {
        this.view = view;
        void this.refreshKey();
        this.cdr.markForCheck();
      });

    // The renderer's own streams may emit outside the zone: re-entered here, once, for
    // every panel they feed.
    const estimate$ = this.controls.getTranscriptEstimate$?.();
    estimate$?.pipe(untilDestroyed()).subscribe((e) =>
      this.runAndMark(() => {
        this.estimate = e;
      }),
    );
    const counts$ = this.controls.getGeneCountsInView$?.();
    counts$?.pipe(untilDestroyed()).subscribe((c) =>
      this.runAndMark(() => {
        this.geneCounts = c;
      }),
    );
    const density$ = this.controls.getDensityStats$?.();
    density$?.pipe(untilDestroyed()).subscribe((d) =>
      this.runAndMark(() => {
        this.densityStats = d;
      }),
    );

    this.controls
      .getSelection$()
      .pipe(untilDestroyed())
      .subscribe((selection) => {
        this.selection = selection;
        if (selection.count === 0) this.selectedCategory = null;
        this.cdr.markForCheck();
      });

    // The colour bar must use the colormap the renderer is using.
    combineLatest([this.viz.getColormap(), this.viz.getReverseScale()])
      .pipe(untilDestroyed())
      .subscribe(([colormap, reverse]) => {
        this.colormap = (colormap as ColormapNode) ?? null;
        this.reverse = !!reverse;
        void this.refreshKey();
      });
  }

  /** Apply an async result inside the zone and re-render this OnPush dialog. */
  private runAndMark(fn: () => void): void {
    this.zone.run(() => {
      fn();
      this.cdr.markForCheck();
    });
  }

  protected onVisibleChange(value: boolean): void {
    this.visible = value;
    this.visibleChange.emit(value);
  }

  // ── the shared gene list ────────────────────────────────────────────────

  /** A keystroke in a gene dropdown's filter box — see {@link GenePickerModel.onFilter}. */
  onGeneFilter(query: string): Promise<void> {
    return this.genes.onFilter(query);
  }

  /** A gene dropdown opened — see {@link GenePickerModel.ensureList}. */
  ensureGeneList(): Promise<void> {
    return this.genes.ensureList();
  }

  // ── selection ───────────────────────────────────────────────────────────

  /** Select every observation inside the drawn regions (their union). */
  protected selectFromRegions(): void {
    const count = this.controls?.selectFromRegions() ?? 0;
    this.selectedCategory = null;
    this.selectionMissed = count === 0;
  }

  /** Legend click: select one category. Clicking the active row clears it, so a
   *  second click is an undo rather than a no-op. */
  protected async selectCategory(index: number): Promise<void> {
    const by = this.view.colorBy;
    if (!this.controls || by?.kind !== 'column') return;
    if (this.selectedCategory === index) {
      this.clearSelection();
      return;
    }
    try {
      await this.controls.selectCategory(by.name, index);
      this.selectedCategory = index;
      this.selectionMissed = false;
    } catch {
      this.selectedCategory = null;
    }
    this.cdr.markForCheck();
  }

  /**
   * Expand or collapse the distribution section.
   *
   * Expanding SCROLLS it into view, because the panel is taller than the viewport
   * once this section is open and the chart is its last row: expanding it drew a
   * chart ~300 px below the fold, which reads as the section being empty. The
   * scroll is deferred a task so the chart's own deferred first draw has given the
   * body its height.
   */
  protected toggleCharts(): void {
    this.chartsOpen = !this.chartsOpen;
    if (!this.chartsOpen) return;
    setTimeout(() => {
      document.getElementById(this.chartsBodyId)?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }, 0);
  }

  protected clearSelection(): void {
    this.controls?.clearSelection();
    this.selectedCategory = null;
    this.selectionMissed = false;
  }

  /** True while a selection is active — everything else renders muted. */
  protected get hasSelection(): boolean {
    return this.selection.count > 0;
  }

  // ── sections ────────────────────────────────────────────────────────────

  /** Boundaries on offer: tiled (level-of-detail) or whole-dataset rings. */
  protected get hasCells(): boolean {
    return !!(this.dataset?.polygonTiles || this.dataset?.polygons);
  }

  /** Transcripts on offer: tiles to draw, or a density map. */
  protected get hasTranscripts(): boolean {
    return !!this.dataset?.transcriptTiles || !!this.dataset?.density;
  }

  protected onShowImage(on: boolean): void {
    this.controls?.setViewState({ showImage: on });
  }

  protected onShowAnnotations(on: boolean): void {
    this.controls?.setViewState({ showAnnotations: on });
  }

  /** Which collapsible sections are open. Per dialog instance, not persisted. */
  protected open: Record<'images' | 'cells' | 'transcripts' | 'annotations' | 'observations', boolean> = {
    images: false,
    cells: true,
    transcripts: false,
    annotations: false,
    observations: false,
  };

  protected toggleSection(name: keyof SpatialControlsComponent['open']): void {
    this.setOpen(name, !this.open[name]);
  }

  /** Expand or collapse a section — what a panel's header asks for. */
  protected setOpen(name: keyof SpatialControlsComponent['open'], on: boolean): void {
    this.open = { ...this.open, [name]: on };
  }

  // ── renderer readouts, for the Transcripts section ────────────────────

  /** Estimated transcripts in view, against the budget — Explorer's points bar. */
  protected estimate: { points: number; max: number } | null = null;
  /** The density window in use and its densest bin, for the threshold control. */
  protected densityStats: { lo: number; hi: number; max: number } | null = null;
  /** Transcripts of each selected gene in the current view, from the renderer. */
  protected geneCounts: Record<string, number> | null = null;

  protected reset(): void {
    this.controls?.setViewState({ ...DEFAULT_SPATIAL_VIEW });
    this.clearSelection();
  }

  /** Label for the current colouring, for the Distribution heading. */
  protected get colorByLabel(): string {
    return colorByLabel(this.view);
  }

  /** True when the active colouring is a categorical column (drives the key). */
  get isCategorical(): boolean {
    return this.legend !== null;
  }

  /** Whether log/clip apply — they are continuous-only knobs. */
  get isContinuous(): boolean {
    return !!this.view.colorBy && this.legend === null;
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** Rebuild the legend or colour bar for the current colouring. */
  private refreshKey(): Promise<void> {
    return this.key.refresh(this.controls, this.dataset, this.view, this.colormap, this.reverse);
  }
}
