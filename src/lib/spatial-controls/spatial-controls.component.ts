import {
  Component, EventEmitter, Inject, Input, NgZone, OnDestroy, OnInit, Output, ViewChild,
} from '@angular/core';
import { Subscription, combineLatest } from 'rxjs';

import { VISUALIZER, IVisualizer, ISpatialControls } from '../contracts/visualizer.contract';
import { SpatialChartsComponent } from './spatial-charts/spatial-charts.component';
import { SpatialDataset } from '../contracts/spatial-dataset.contract';
import { ColormapNode, SpatialViewState, DEFAULT_SPATIAL_VIEW } from '../contracts/display-types';
import { SPATIAL_3D_MAX_CATEGORIES } from '../spatial/spatial-encoding';
import {
  CLIP_OPTIONS, PanelOption, columnOptions, middleSection, parseGeneGroups, sectionLabel,
} from '../spatial/spatial-panel-model';
import { SpatialSelectionMask, emptySelection } from '../spatial/spatial-selection';
import { GenePickerModel } from './spatial-gene-picker';
import { SpatialKeyModel, SpatialLegendEntry } from './spatial-key/spatial-key.model';
import { colorByLabel } from './spatial-key/spatial-key.component';

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
 */
@Component({
  selector: 'spatial-controls',
  templateUrl: './spatial-controls.component.html',
  styleUrls: ['./spatial-controls.component.scss'],
})
export class SpatialControlsComponent implements OnInit, OnDestroy {
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
  onResizeEnd(): void {
    this.charts?.resize();
  }

  /** Dialog visibility, two-way bound so a toolbar button can open it. */
  @Input() visible = false;
  /** Set while the 3D cloud is the active mode. Changes what the ROI selection
   *  MEANS — a screen-space lasso cutting through the cloud's full depth rather
   *  than a shape in tissue coordinates — so the hint below it says so. */
  @Input() is3d = false;
  @Output() visibleChange = new EventEmitter<boolean>();

  readonly clipOptions = CLIP_OPTIONS;

  /** Null when the host bound no `SPATIAL_DATA_PORT`. */
  controls: ISpatialControls | null = null;
  dataset: SpatialDataset | null = null;
  view: SpatialViewState = { ...DEFAULT_SPATIAL_VIEW };

  /** Colour-by column choices — "None" plus every column the dataset declares. */
  columnOptions: { label: string; value: string | null }[] = [];
  selectedColumn: string | null = null;

  /** Virtual-scrolled only past this many options: the scroller earns its
   *  complexity for a few thousand names, and for eight it adds only overhead —
   *  a virtual viewport that short swallows the clicks it is meant to forward. */
  readonly geneVirtualScrollFrom = 200;
  /**
   * Gene picker: a filterable dropdown rather than a free-text typeahead, so the
   * options are visible before anything is typed and each keystroke narrows a list
   * the user can see. One model feeds every gene dropdown of the panel.
   */
  readonly genes = new GenePickerModel(
    () => this.controls,
    () => [
      ...(this.view?.transcriptGenes ?? []),
      ...(this.view?.colorBy?.kind === 'feature' ? [this.view.colorBy.name] : []),
    ],
    (fn) => this.zone.run(fn),
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
  selectedGene: string | null = null;

  /** The key — legend or colour bar — for the active colouring. Kept here, not in
   *  `<spatial-key>`: whether the colouring is categorical decides which knobs the rest of
   *  the panel offers, whether or not the key is on screen. */
  readonly key = new SpatialKeyModel((fn) => this.zone.run(fn));
  /** Categorical key, or null when the active colouring is continuous. */
  get legend(): SpatialLegendEntry[] | null {
    return this.key.legend;
  }
  /** CSS gradient for a continuous colouring, or null when categorical. */
  get colorBarCss(): string | null {
    return this.key.colorBarCss;
  }

  /** Current selection — drives the count, the Clear button and the muting. */
  selection: SpatialSelectionMask = emptySelection();
  /** The legend row whose category is currently selected, for highlighting. */
  selectedCategory: number | null = null;
  /** An ROI selection that matched nothing, so the UI can say so rather than
   *  looking like the button did nothing. */
  selectionMissed = false;

  /**
   * Whether the Distribution section is expanded. Collapsed by default: the
   * panel's primary job is the colour controls, and the chart roughly doubles
   * its height.
   */
  chartsOpen = false;
  /** Per-instance id for the collapsible body, so `aria-controls` points at one
   *  element and expanding the second panel cannot scroll the first one's chart. */
  readonly chartsBodyId = `sc-charts-body-${++controlsInstanceSeq}`;

  /**
   * The dataset's imaged section positions, or null when its z is continuous
   * rather than sectioned. Read once per dataset — the scan walks the z of every
   * observation, so it must not sit in a template getter.
   */
  sections: Float32Array | null = null;

  /** Colormap tree for the continuous colour scale and the density map: the library's
   *  own `COLORMAP_OPTIONS`. */
  colormapOptions: ColormapNode[] = [];

  private colormap: ColormapNode | null = null;
  private reverse = false;
  private readonly subs = new Subscription();

  constructor(
    @Inject(VISUALIZER) private readonly viz: IVisualizer,
    private readonly zone: NgZone,
  ) {}

  ngOnInit(): void {
    this.controls = this.viz.getSpatialControls?.() ?? null;
    this.colormapOptions = this.viz.getColormapOptions?.() ?? [];
    if (!this.controls) return;

    this.subs.add(this.controls.getDataset$().subscribe((dataset) => {
      this.dataset = dataset;
      this.columnOptions = columnOptions(dataset);
      // A new dataset almost certainly has different columns; drop stale UI state.
      this.selectedGene = null;
      this.genes.setDataset(dataset);
      this.sections = this.controls?.sampledSections() ?? null;
      // A dataset with no cells to outline leads with its observations.
      this.open = { ...this.open, cells: !!(dataset?.polygonTiles || dataset?.polygons),
        observations: !(dataset?.polygonTiles || dataset?.polygons) };
      void this.refreshKey();
    }));

    this.subs.add(this.controls.getViewState$().subscribe((view) => {
      this.view = view;
      this.selectedColumn = view.colorBy?.kind === 'column' ? view.colorBy.name : null;
      this.selectedGene = view.colorBy?.kind === 'feature' ? view.colorBy.name : null;
      void this.refreshKey();
    }));

    // The renderer's own streams may emit outside the zone: re-entered here, once, for
    // every panel they feed.
    const estimate$ = this.controls.getTranscriptEstimate$?.();
    if (estimate$) this.subs.add(estimate$.subscribe((e) => this.zone.run(() => { this.estimate = e; })));
    const counts$ = this.controls.getGeneCountsInView$?.();
    if (counts$) this.subs.add(counts$.subscribe((c) => this.zone.run(() => { this.geneCounts = c; })));
    const density$ = this.controls.getDensityStats$?.();
    if (density$) {
      this.subs.add(density$.subscribe((d) => this.zone.run(() => { this.densityStats = d; })));
    }

    this.subs.add(this.controls.getSelection$().subscribe((selection) => {
      this.selection = selection;
      if (selection.count === 0) this.selectedCategory = null;
    }));

    // The colour bar must use the colormap the renderer is using.
    this.subs.add(
      combineLatest([this.viz.getColormap(), this.viz.getReverseScale()])
        .subscribe(([colormap, reverse]) => {
          this.colormap = (colormap as ColormapNode) ?? null;
          this.reverse = !!reverse;
          void this.refreshKey();
        }),
    );
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  onVisibleChange(value: boolean): void {
    this.visible = value;
    this.visibleChange.emit(value);
  }

  // ── colour source ───────────────────────────────────────────────────────

  /** Column dropdown. Choosing a column supersedes any gene selection. */
  onColumn(name: string | null): void {
    this.selectedColumn = name;
    if (!name) {
      this.controls?.clearColorBy();
      this.selectedGene = null;
      return;
    }
    this.selectedGene = null;
    this.controls?.colorByColumn(name);
  }

  /** A keystroke in a gene dropdown's filter box — see {@link GenePickerModel.onFilter}. */
  onGeneFilter(query: string): Promise<void> {
    return this.genes.onFilter(query);
  }

  /** A gene dropdown opened — see {@link GenePickerModel.ensureList}. */
  ensureGeneList(): Promise<void> {
    return this.genes.ensureList();
  }

  /** A gene was picked; it supersedes any column selection. */
  onGene(name: string | null): void {
    this.selectedGene = name;
    if (!name) {
      this.controls?.clearColorBy();
      return;
    }
    this.selectedColumn = null;
    this.controls?.colorByFeature(name);
  }

  // ── selection ───────────────────────────────────────────────────────────

  /** Select every observation inside the drawn regions (their union). */
  selectFromRegions(): void {
    const count = this.controls?.selectFromRegions() ?? 0;
    this.selectedCategory = null;
    this.selectionMissed = count === 0;
  }

  /** Legend click: select one category. Clicking the active row clears it, so a
   *  second click is an undo rather than a no-op. */
  async selectCategory(index: number): Promise<void> {
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
  toggleCharts(): void {
    this.chartsOpen = !this.chartsOpen;
    if (!this.chartsOpen) return;
    setTimeout(() => {
      document.getElementById(this.chartsBodyId)
        ?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }, 0);
  }

  clearSelection(): void {
    this.controls?.clearSelection();
    this.selectedCategory = null;
    this.selectionMissed = false;
  }

  /** True while a selection is active — everything else renders muted. */
  get hasSelection(): boolean {
    return this.selection.count > 0;
  }

  // ── display ─────────────────────────────────────────────────────────────

  // PrimeNG's slider reports `number | undefined`; ignore the empty case rather
  // than writing `undefined` into the store and rendering NaN-sized markers.
  onPointScale(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ pointScale: value });
  }
  onOpacity(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ opacity: value });
  }
  onLogScale(on: boolean): void {
    this.controls?.setViewState({ logScale: on });
  }
  /**
   * Set when the active categorical colouring has more categories than the 3D
   * cloud can keep apart, so the points are drawing FLAT.
   *
   * Said in the panel rather than left to a console warning: `subclass` (338) is
   * served precisely because the density volumes and the 2D view can render it, and
   * a user who picks it in the cloud and sees one colour deserves to know both why
   * and what to do instead.
   */
  get exceedsCloudPalette(): boolean {
    return this.is3d && (this.legend?.length ?? 0) > SPATIAL_3D_MAX_CATEGORIES;
  }
  /** The ceiling itself, for the message. */
  readonly cloudPaletteLimit = SPATIAL_3D_MAX_CATEGORIES;

  onGeneMap(on: boolean): void {
    this.controls?.setViewState({ geneMap: on });
  }
  /** 3D: smooth the per-section sheets along z into a continuous volume. */
  onGeneMapVolume(on: boolean): void {
    this.controls?.setViewState({ geneMapVolume: on });
  }
  /** 3D: restrict the sheets to one imaged section. */
  onGeneMapOneSection(on: boolean): void {
    if (!on) {
      this.controls?.setViewState({ geneMapSection: null });
      return;
    }
    this.controls?.setViewState({ geneMapSection: middleSection(this.sections) });
  }
  onGeneMapSection(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ geneMapSection: value });
  }
  get geneMapOneSection(): boolean {
    return this.view.geneMapSection != null;
  }
  /** "12 of 53" for the gene map's own section, 1-based like the cloud's. */
  get geneMapSectionLabel(): string {
    return sectionLabel(this.sections, this.view.geneMapSection);
  }
  onGeneMapSmoothing(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ geneMapSmoothing: value });
  }
  onGeneMapOpacity(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ geneMapOpacity: value });
  }
  /**
   * What the 3D gene map is currently showing, said plainly — the sheets are a
   * measurement and the volume is an estimate, and the panel has to be the place
   * that says which one is on screen.
   */
  get geneMapVolumeNote(): string {
    const total = this.sections?.length ?? 0;
    if (this.view.geneMapVolume) {
      return 'Interpolated along z: the planes between the imaged sections carry an '
        + 'ESTIMATE, smoothed from their neighbours\' mean. Nothing is drawn beyond the '
        + 'outermost section.';
    }
    if (this.geneMapOneSection) {
      return 'One imaged section\'s field — measured, not interpolated. Hide the '
        + 'observations to read it, or leave them on to check the field against them.';
    }
    return `One field per imaged section${total ? ` (${total})` : ''}, at its own depth, `
      + 'with the gaps between sections empty. Kernel-weighted mean per cell, not a sum.';
  }

  /** True while a gene is the colour source — the only thing a gene map can map. */
  get canMapGene(): boolean {
    return this.view.colorBy?.kind === 'feature';
  }

  // ── what the 3D scene draws ─────────────────────────────────────────────
  // The volume, the cloud and the density volumes share one space, so each one
  // hides the others to some degree. Independent toggles because the useful views
  // are the combinations, not a single "3D mode".

  onShowVolume(on: boolean): void {
    this.controls?.setViewState({ showVolume: on });
  }
  onVolumeOpacity(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ volumeOpacity: value });
  }
  onShowPoints(on: boolean): void {
    this.controls?.setViewState({ showPoints: on });
  }
  /** The "one section at a time" switch: null restores the whole stack. */
  onOneSection(on: boolean): void {
    if (!on) {
      this.controls?.setViewState({ pointSection: null });
      return;
    }
    // Open in the middle of the stack rather than on the first section, which for
    // a brain is a nearly empty olfactory-bulb slide.
    this.controls?.setViewState({ pointSection: middleSection(this.sections) });
  }
  onPointSection(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ pointSection: value });
  }
  /** True while the cloud is restricted to a single section. */
  get oneSection(): boolean {
    return this.view.pointSection != null;
  }
  /** Highest section index the slider can reach. */
  get lastSection(): number {
    return Math.max(0, (this.sections?.length ?? 1) - 1);
  }
  /** "12 of 53" — 1-based, because the sections are slides, not array slots. */
  get sectionLabel(): string {
    return sectionLabel(this.sections, this.view.pointSection);
  }
  /** Whether this dataset has sections to pick from at all. */
  get isSectioned(): boolean {
    return (this.sections?.length ?? 0) > 1;
  }

  onDensityVolume(on: boolean): void {
    this.controls?.setViewState({ densityVolume: on });
  }
  onDensitySmoothing(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ densitySmoothing: value });
  }

  /** What the density volumes are actually showing, said plainly — an estimate is
   *  only honest if the reader knows it is one, and which clusters are in view. */
  get densityNote(): string {
    const capped = `the ${SpatialControlsComponent.DENSITY_MAX_CLUSTERS} largest clusters`;
    const what = this.legend ? capped : this.hasSelection ? 'the selected cells' : 'all cells';
    return `Density estimate over ${what} — smoothed between the imaged sections, `
      + 'not measured cells. Lower Opacity to read the fields under the cloud.';
  }

  /** Mirrors the renderer's cap, for the note only. */
  private static readonly DENSITY_MAX_CLUSTERS = 6;
  onClip(value: [number, number]): void {
    this.controls?.setViewState({ percentileClip: value });
  }
  // ── sections ────────────────────────────────────────────────────────────

  /** Boundaries on offer: tiled (level-of-detail) or whole-dataset rings. */
  get hasCells(): boolean {
    return !!(this.dataset?.polygonTiles || this.dataset?.polygons);
  }

  /** Transcripts on offer: tiles to draw, or a density map. */
  get hasTranscripts(): boolean {
    return !!this.dataset?.transcriptTiles || !!this.dataset?.density;
  }

  onShowImage(on: boolean): void {
    this.controls?.setViewState({ showImage: on });
  }

  onShowAnnotations(on: boolean): void {
    this.controls?.setViewState({ showAnnotations: on });
  }

  /** Which collapsible sections are open. Per dialog instance, not persisted. */
  open: Record<'images' | 'cells' | 'transcripts' | 'annotations' | 'observations', boolean> = {
    images: false, cells: true, transcripts: false, annotations: false, observations: false,
  };

  toggleSection(name: keyof SpatialControlsComponent['open']): void {
    this.setOpen(name, !this.open[name]);
  }

  /** Expand or collapse a section — what a panel's header asks for. */
  setOpen(name: keyof SpatialControlsComponent['open'], on: boolean): void {
    this.open = { ...this.open, [name]: on };
  }

  // ── renderer readouts, for the Transcripts section ────────────────────

  /** Estimated transcripts in view, against the budget — Explorer's points bar. */
  estimate: { points: number; max: number } | null = null;
  /** The density window in use and its densest bin, for the threshold control. */
  densityStats: { lo: number; hi: number; max: number } | null = null;
  /** Transcripts of each selected gene in the current view, from the renderer. */
  geneCounts: Record<string, number> | null = null;

  reset(): void {
    this.controls?.setViewState({ ...DEFAULT_SPATIAL_VIEW });
    this.clearSelection();
    this.selectedColumn = null;
    this.selectedGene = null;
  }

  /** Label for the current colouring, for the Distribution heading. */
  get colorByLabel(): string {
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
