import {
  Component, EventEmitter, Inject, Input, OnDestroy, OnInit, Output,
} from '@angular/core';
import { Subscription, combineLatest } from 'rxjs';

import { VISUALIZER, IVisualizer, ISpatialControls } from '../contracts/visualizer.contract';
import {
  CategoricalColumnMeta, SpatialColumnMeta, SpatialDataset,
} from '../contracts/spatial-dataset.contract';
import { ColormapNode, SpatialViewState, DEFAULT_SPATIAL_VIEW } from '../contracts/display-types';
import { SPATIAL_3D_MAX_CATEGORIES, lutFor } from '../implementations/spatial/spatial-encoding';
import {
  SpatialSelectionMask, emptySelection,
} from '../implementations/spatial/spatial-selection';

/** One legend row for a categorical colouring. */
export interface SpatialLegendEntry {
  label: string;
  color: string;
}

/** A gene name as a dropdown option. Objects rather than bare strings because the
 *  dropdown filters on a named field (`filterBy="label"`), which a string has not. */
const geneOption = (name: string): { label: string; value: string } => ({
  label: name,
  value: name,
});

/** Per-instance id source — see {@link SpatialControlsComponent.chartsBodyId}. */
let controlsInstanceSeq = 0;

/** Outlier clipping presets, as `[lo, hi]` percentile fractions. */
const CLIP_OPTIONS: { label: string; value: [number, number] }[] = [
  { label: 'None', value: [0, 1] },
  { label: '1%', value: [0.01, 0.99] },
  { label: '2%', value: [0.02, 0.98] },
  { label: '5%', value: [0.05, 0.95] },
];

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
 * `lutFor`), so the key cannot drift from what is on screen.
 */
@Component({
  selector: 'spatial-controls',
  templateUrl: './spatial-controls.component.html',
  styleUrls: ['./spatial-controls.component.scss'],
})
export class SpatialControlsComponent implements OnInit, OnDestroy {
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
   * the user can see.
   *
   * `geneOptions` is the full name list when the dataset inlines it (a targeted
   * panel: 8 for the ABC demo, 300–5,000 for Xenium/CosMx). A whole-transcriptome
   * dataset does not ship its ~31k names, so there the list is what the port's last
   * search returned and filtering is server-side — same control either way.
   */
  geneOptions: { label: string; value: string }[] = [];
  selectedGene: string | null = null;
  /** True when the options come from the port per keystroke rather than a resident
   *  list, which changes what an empty list means (nothing matched *yet*). */
  genesAreRemote = false;
  geneSearchFailed = false;

  /** Categorical key, or null when the active colouring is continuous. */
  legend: SpatialLegendEntry[] | null = null;
  /** CSS gradient for a continuous colouring, or null when categorical. */
  colorBarCss: string | null = null;

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

  private colormap: ColormapNode | null = null;
  private reverse = false;
  /** Guards the gene typeahead and the legend/colour-bar rebuild: both are async
   *  and both are driven by input the user changes faster than they resolve. */
  private geneSearchToken = 0;
  private keyToken = 0;
  private readonly subs = new Subscription();

  constructor(@Inject(VISUALIZER) private readonly viz: IVisualizer) {}

  ngOnInit(): void {
    this.controls = this.viz.getSpatialControls?.() ?? null;
    if (!this.controls) return;

    this.subs.add(this.controls.getDataset$().subscribe((dataset) => {
      this.dataset = dataset;
      this.columnOptions = [
        { label: 'None (flat colour)', value: null },
        ...(dataset?.columns ?? []).map((c) => ({ label: this.columnLabel(c), value: c.name })),
      ];
      // A new dataset almost certainly has different columns; drop stale UI state.
      this.selectedGene = null;
      this.geneSearchFailed = false;
      const names = dataset?.features?.names;
      this.genesAreRemote = !!dataset?.features && !names;
      this.geneOptions = names ? names.map(geneOption) : [];
      void this.refreshKey();
    }));

    this.subs.add(this.controls.getViewState$().subscribe((view) => {
      this.view = view;
      this.selectedColumn = view.colorBy?.kind === 'column' ? view.colorBy.name : null;
      this.selectedGene = view.colorBy?.kind === 'feature' ? view.colorBy.name : null;
      void this.refreshKey();
    }));

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

  /**
   * A keystroke in the gene dropdown's filter box.
   *
   * With the names resident the dropdown filters them itself and this only clears a
   * stale failure. Without them there is nothing to filter, so the query goes to the
   * port and its answer BECOMES the option list — the same control, filtering one
   * hop further away.
   */
  async onGeneFilter(query: string): Promise<void> {
    this.geneSearchFailed = false;
    if (!this.controls || !this.genesAreRemote) return;
    // Typing outruns the lookup, so a slow answer for an earlier query would
    // replace the options for the text now in the box — including a failure, which
    // would wrongly mark the current query as failed.
    const mine = ++this.geneSearchToken;
    if (!query) {
      this.geneOptions = [];
      return;
    }
    try {
      const names = await this.controls.searchFeatures(query, 50);
      if (mine !== this.geneSearchToken) return;
      this.geneOptions = names.map(geneOption);
    } catch {
      if (mine !== this.geneSearchToken) return;
      // A failed lookup must not wedge the control — show none and say so.
      this.geneOptions = [];
      this.geneSearchFailed = true;
    }
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
  onGeneMapSmoothing(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ geneMapSmoothing: value });
  }
  onGeneMapOpacity(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ geneMapOpacity: value });
  }
  /** True while a gene is the colour source — the only thing a gene map can map. */
  get canMapGene(): boolean {
    return this.view.colorBy?.kind === 'feature';
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
  reset(): void {
    this.controls?.setViewState({ ...DEFAULT_SPATIAL_VIEW });
    this.clearSelection();
    this.selectedColumn = null;
    this.selectedGene = null;
  }

  /**
   * Description of the active column, when it has one. Surfaced because a
   * DERIVED column (k-means clusters, QC totals computed at conversion) must not
   * read as though it came with the data.
   */
  get activeDescription(): string | null {
    const by = this.view.colorBy;
    if (!by || by.kind !== 'column') return null;
    return this.dataset?.columns.find((c) => c.name === by.name)?.description ?? null;
  }

  /** Label for the current colouring, for the key's heading. */
  get colorByLabel(): string {
    const by = this.view.colorBy;
    if (!by) return 'Flat colour';
    return by.kind === 'feature' ? `Gene · ${by.name}` : by.name;
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

  private columnLabel(c: SpatialColumnMeta): string {
    const kind = c.kind === 'categorical'
      ? `${(c as CategoricalColumnMeta).categories.length} categories`
      : c.unit ?? 'continuous';
    return `${c.name} — ${kind}`;
  }

  /** Rebuild the legend or colour bar for the current colouring. */
  private async refreshKey(): Promise<void> {
    const by = this.view.colorBy;
    if (!by || !this.controls) {
      this.legend = null;
      this.colorBarCss = null;
      return;
    }
    const meta = by.kind === 'column'
      ? this.dataset?.columns.find((c) => c.name === by.name)
      : undefined;

    const mine = ++this.keyToken;
    if (meta?.kind === 'categorical') {
      try {
        const colors = await this.controls.categoryColors(by.name);
        // Same race, same cost if it is lost: a slower earlier column would paint
        // its palette into the legend for the column now selected.
        if (mine !== this.keyToken) return;
        this.legend = meta.categories.map((label, i) => ({ label, color: colors[i] }));
        this.colorBarCss = null;
      } catch {
        if (mine !== this.keyToken) return;
        // The column's values may not have loaded yet; leave the key empty
        // rather than showing a legend that might not match the render.
        this.legend = null;
        this.colorBarCss = null;
      }
      return;
    }

    // Continuous (a numeric column or a gene): a colour bar from the same LUT.
    this.legend = null;
    this.colorBarCss = this.buildColorBar();
  }

  /** `linear-gradient(...)` sampling the active colormap at 16 stops. */
  private buildColorBar(): string {
    const lut = lutFor(this.colormap?.data?.value, this.reverse);
    const stops: string[] = [];
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      const [r, g, b] = lut[Math.round((i / steps) * 255)];
      stops.push(`rgb(${r},${g},${b}) ${((i / steps) * 100).toFixed(0)}%`);
    }
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }
}
