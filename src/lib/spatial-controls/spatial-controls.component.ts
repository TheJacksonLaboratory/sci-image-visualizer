import {
  Component, ElementRef, EventEmitter, Inject, Input, NgZone, OnDestroy, OnInit, Output, ViewChild,
} from '@angular/core';
import { Subscription, combineLatest } from 'rxjs';

import { VISUALIZER, IVisualizer, ISpatialControls } from '../contracts/visualizer.contract';
import { SpatialChartsComponent } from './spatial-charts/spatial-charts.component';
import {
  CategoricalColumnMeta, SpatialColumnMeta, SpatialDataset,
} from '../contracts/spatial-dataset.contract';
import {
  ColormapNode, ColormapValue, SpatialViewState, DEFAULT_SPATIAL_VIEW, TranscriptGlyphName,
} from '../contracts/display-types';
import {
  DEFAULT_CATEGORICAL_PALETTE, SPATIAL_3D_MAX_CATEGORIES, lutFor, spatialContinuousLut,
} from '../spatial/spatial-encoding';
import {
  INFERNO_SCALE, TRANSCRIPT_GLYPHS, cellTypeColumnFor, cellsShown, clusterColorMap, clusterOfGene, defaultGlyphFor,
  glyphOutline, isCuratedColumn,
} from '../spatial/spatial-tiles';
import {
  SpatialSelectionMask, emptySelection,
} from '../spatial/spatial-selection';
import { searchGeneNames } from '../spatial/gene-search';
import { Supersede } from '../spatial/supersede';

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

/** Glyph choices with an SVG `points` string for the preview. */
const GLYPH_OPTIONS = TRANSCRIPT_GLYPHS.map((g) => {
  const o = glyphOutline(g);
  const pts: string[] = [];
  for (let i = 0; i < o.length; i += 2) pts.push(`${o[i].toFixed(3)},${o[i + 1].toFixed(3)}`);
  return { label: g.replace('-', ' '), value: g as TranscriptGlyphName, points: pts.join(' ') };
});

/**
 * `group,gene` rows (CSV or TSV, header optional) → gene groups, in file order.
 * Exported for tests.
 */
export function parseGeneGroups(text: string): { name: string; genes: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const [a, b] = line.split(/,|\t/).map((f) => f.trim().replace(/^"|"$/g, ''));
    if (!a || !b || (/^(group|cell_?type|name)$/i.test(a) && /^(gene|genes|feature)$/i.test(b))) continue;
    const list = groups.get(a) ?? [];
    if (!list.includes(b)) list.push(b);
    groups.set(a, list);
  }
  return [...groups].map(([name, genes]) => ({ name, genes }));
}

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
   * the user can see.
   *
   * `geneOptions` is the full name list when the dataset inlines it (a targeted
   * panel: 8 for the ABC demo, 300–5,000 for Xenium/CosMx). A whole-transcriptome
   * dataset does not ship its ~31k names, so there the list is what the port's last
   * search returned and filtering is server-side — same control either way.
   */
  geneOptions: { label: string; value: string }[] = [];
  /**
   * Every gene the dataset inlined, whether or not it is currently an option.
   *
   * Held as plain strings and searched per keystroke. A whole-transcriptome dataset
   * inlines ~18k names — cheap to keep, ruinous to hand a dropdown all at once — so
   * {@link geneOptions} is only ever the best few hundred of these.
   */
  private geneNames: string[] = [];
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

  /**
   * The dataset's imaged section positions, or null when its z is continuous
   * rather than sectioned. Read once per dataset — the scan walks the z of every
   * observation, so it must not sit in a template getter.
   */
  sections: Float32Array | null = null;

  /**
   * Colormap tree for the continuous colour scale, and the node currently picked
   * from it. The library's own `COLORMAP_OPTIONS`, shown with the same swatches
   * the image's colormap picker uses — choosing a gradient is a visual decision,
   * so a list of names would be the wrong control.
   */
  colormapOptions: ColormapNode[] = [];
  selectedColormapNode: ColormapNode | null = null;

  private colormap: ColormapNode | null = null;
  private reverse = false;
  /** Guards the gene typeahead and the legend/colour-bar rebuild: both are async
   *  and both are driven by input the user changes faster than they resolve. */
  private readonly geneSearch = new Supersede();
  private readonly keyLoad = new Supersede();
  /** Guards the whole-transcriptome gene-list preload against a dataset switch. */
  private readonly geneListLoad = new Supersede();
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
      this.columnOptions = [
        { label: 'None (flat colour)', value: null },
        ...(dataset?.columns ?? []).map((c) => ({ label: this.columnLabel(c), value: c.name })),
      ];
      // A new dataset almost certainly has different columns; drop stale UI state.
      this.selectedGene = null;
      this.geneSearchFailed = false;
      // A gene search or list preload still in flight answers for the previous dataset.
      this.geneSearch.invalidate();
      this.geneListLoad.invalidate();
      this.geneListLoading = false;
      const names = dataset?.features?.names;
      this.genesAreRemote = !!dataset?.features && !names;
      this.geneNames = names ? [...names] : [];
      // The head of the list, not all of it: see `geneNames`.
      this.geneOptions = searchGeneNames(this.geneNames, '').map(geneOption);
      this.sections = this.controls?.sampledSections() ?? null;
      this.buildTileOptions(dataset);
      this.groupRowsFor = null;
      // A dataset with no cells to outline leads with its observations.
      this.open = { ...this.open, cells: !!(dataset?.polygonTiles || dataset?.polygons),
        observations: !(dataset?.polygonTiles || dataset?.polygons) };
      void this.refreshKey();
      void this.refreshGroups();
    }));

    this.subs.add(this.controls.getViewState$().subscribe((view) => {
      this.view = view;
      this.selectedColumn = view.colorBy?.kind === 'column' ? view.colorBy.name : null;
      this.selectedGene = view.colorBy?.kind === 'feature' ? view.colorBy.name : null;
      this.selectedColormapNode = this.colormapNodeFor(view.continuousColormap);
      this.selectedDensityColormapNode = this.colormapNodeFor(view.densityColormap);
      this.geneTree = this.buildGeneTree();
      this.geneMenu = this.buildGeneMenu();
      this.refreshDensityWindow();
      void this.refreshKey();
      void this.refreshGroups();
      void this.refreshCellGroupColors();
    }));

    const estimate$ = this.controls.getTranscriptEstimate$?.();
    if (estimate$) this.subs.add(estimate$.subscribe((e) => this.zone.run(() => { this.estimate = e; })));
    const counts$ = this.controls.getGeneCountsInView$?.();
    if (counts$) this.subs.add(counts$.subscribe((c) => this.zone.run(() => { this.geneCounts = c; })));
    const density$ = this.controls.getDensityStats$?.();
    if (density$) {
      this.subs.add(density$.subscribe((d) => this.zone.run(() => {
        this.densityStats = d;
        this.refreshDensityWindow();
      })));
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
    if (!this.genesAreRemote) {
      // Resident names: search them here and materialise only the top matches. The
      // dropdown's own filter then runs over those and agrees — they were chosen by the
      // same query — so the control behaves as if it still held the whole list.
      this.geneOptions = this.withSelected(searchGeneNames(this.geneNames, query));
      return;
    }
    if (!this.controls) return;
    // Typing outruns the lookup, so a slow answer for an earlier query would
    // replace the options for the text now in the box — including a failure, which
    // would wrongly mark the current query as failed.
    const current = this.geneSearch.next();
    if (!query) {
      this.geneOptions = [];
      return;
    }
    try {
      const names = await this.controls.searchFeatures(query, 50);
      if (!current()) return;
      this.zone.run(() => { this.geneOptions = this.withSelected(names); });
    } catch {
      if (!current()) return;
      // A failed lookup must not wedge the control — show none and say so.
      this.zone.run(() => {
        this.geneOptions = this.withSelected([]);
        this.geneSearchFailed = true;
      });
    }
  }

  /**
   * Opening either gene dropdown — "Colour by gene" or the transcript genes. Both share
   * one list and one search, so each opens on the head of the full list rather than on
   * whatever the other was last filtered to.
   *
   * A whole-transcriptome dataset does not inline its ~30k names; they are fetched here,
   * once, on first open — the list is then resident and every keystroke filters locally,
   * exactly as for a targeted panel. Until it arrives the dropdown falls back to asking
   * the server per keystroke.
   */
  async ensureGeneList(): Promise<void> {
    if (this.genesAreRemote && this.controls && !this.geneListLoading) {
      this.geneListLoading = true;
      // A switch to another remote-gene dataset mid-fetch would otherwise hand it this
      // dataset's names as its own.
      const current = this.geneListLoad.next();
      try {
        const names = await this.controls.searchFeatures('', SpatialControlsComponent.GENE_LIST_MAX);
        if (current() && names.length && this.genesAreRemote) {
          this.zone.run(() => {
            this.geneNames = names;
            this.genesAreRemote = false;
          });
        }
      } catch {
        // Keep the per-keystroke search; the list is a convenience, not a requirement.
      } finally {
        if (current()) this.geneListLoading = false;
      }
    }
    this.zone.run(() => {
      this.geneOptions = this.withSelected(
        this.genesAreRemote ? [] : searchGeneNames(this.geneNames, ''),
      );
    });
  }

  /** Most names fetched for the lazy list — well above any panel, whole-transcriptome included. */
  private static readonly GENE_LIST_MAX = 100_000;
  private geneListLoading = false;

  /** Options for `names`, plus the genes already chosen (a multi-select shows a chip only
   *  for a value it can find among its options). */
  private withSelected(names: readonly string[]): { label: string; value: string }[] {
    const chosen = [...(this.view?.transcriptGenes ?? []), ...(this.selectedGene ? [this.selectedGene] : [])];
    const seen = new Set(names);
    return [...chosen.filter((g) => !seen.has(g)), ...names].map(geneOption);
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
    const middle = this.sections ? Math.floor((this.sections.length - 1) / 2) : 0;
    this.controls?.setViewState({ geneMapSection: middle });
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
    const total = this.sections?.length ?? 0;
    if (!total) return '';
    const at = Math.max(0, Math.min(total - 1, this.view.geneMapSection ?? 0));
    return `${at + 1} of ${total}`;
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
    const middle = this.sections ? Math.floor((this.sections.length - 1) / 2) : 0;
    this.controls?.setViewState({ pointSection: middle });
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
    const total = this.sections?.length ?? 0;
    if (!total) return '';
    const at = Math.max(0, Math.min(total - 1, this.view.pointSection ?? 0));
    return `${at + 1} of ${total}`;
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
  // ── cells & transcripts ────────────────────────────────────────────────

  readonly cellDrawOptions = [
    { label: 'Fill', value: 'fill' }, { label: 'Outline', value: 'outline' }, { label: 'Both', value: 'both' },
  ];
  readonly transcriptColorOptions = [
    { label: 'Cluster', value: 'cluster' }, { label: 'Cell type', value: 'cellType' }, { label: 'Gene', value: 'gene' },
  ];
  readonly glyphOptions = GLYPH_OPTIONS;
  readonly budgetOptions = [25_000, 50_000, 100_000, 200_000, 400_000]
    .map((n) => ({ label: n.toLocaleString(), value: n }));

  /** Boundaries on offer: tiled (level-of-detail) or whole-dataset rings. */
  get hasCells(): boolean {
    return !!(this.dataset?.polygonTiles || this.dataset?.polygons);
  }

  get hasTranscripts(): boolean {
    return !!this.dataset?.transcriptTiles || !!this.dataset?.density;
  }


  /** Whether outlines are on — the explicit choice, or automatically for data that has them. */
  get cellsOn(): boolean {
    return cellsShown(this.dataset, this.view);
  }

  get activeCellSet(): string | null {
    const tiles = this.dataset?.polygonTiles;
    return this.view.cellSet ?? tiles?.defaultSet ?? tiles?.sets[0]?.name ?? null;
  }

  /**
   * Option lists for the cell/transcript controls. Built once per dataset rather than in
   * getters: a getter returns a fresh array on every change-detection pass, and PrimeNG
   * re-renders its buttons whenever the array identity changes — which made them
   * impossible to click.
   */
  cellSetOptions: { label: string; value: string }[] = [];
  transcriptModeOptions: { label: string; value: SpatialViewState['transcriptMode'] }[] = [];

  private buildTileOptions(ds: SpatialDataset | null): void {
    // Short labels, cell set first, and "Both" when there are two — as Xenium Explorer.
    const sets = [...(ds?.polygonTiles?.sets ?? [])]
      .sort((a, b) => (a.name === 'cell' ? -1 : b.name === 'cell' ? 1 : 0));
    this.cellSetOptions = [
      ...sets.map((s) => ({ label: s.label.replace(/\s*boundar(y|ies)$/i, ''), value: s.name })),
      ...(sets.length > 1 ? [{ label: 'Both', value: 'both' }] : []),
    ];
    this.transcriptModeOptions = [
      ...(ds?.transcriptTiles ? [
        { label: 'Points', value: 'circles' as const },
        { label: 'Icons', value: 'glyphs' as const },
      ] : []),
      ...(ds?.density ? [{ label: 'Density Map', value: 'density' as const }] : []),
    ];
    const has = (name: string) => !!ds?.columns.some((c) => c.name === name);
    this.cellColorOptions = [
      { label: 'Group Affiliation', value: 'group' },
      ...(ds?.features ? [{ label: 'Gene Expression', value: 'gene' as const }] : []),
      ...(has('transcript_density') ? [{ label: 'Transcript Density Map', value: 'transcriptDensity' as const }] : []),
      { label: 'Single Color', value: 'single' },
      ...(has('segmentation_method') ? [{ label: 'Segmentation Method', value: 'segmentation' as const }] : []),
    ];
    this.buildGroupOptions(ds);
  }

  /** Cell colour modes on offer (Xenium Explorer's "Cell Color"). */
  cellColorOptions: { label: string; value: SpatialViewState['cellColorMode'] }[] = [];

  // ── groups ──────────────────────────────────────────────────────────────

  /**
   * The group picker: categorical columns under their section heading, a family of
   * variants (k-means at k = 2…10) listed once. Values are a column name, or
   * `family:<id>` for a family.
   */
  groupOptions: { label: string; items: { label: string; value: string }[] }[] = [];
  /** Variants of the active family (k = 2…10), when a family is active. */
  groupVariantOptions: { label: string; value: string }[] = [];
  /** The last variant chosen per family, so switching away and back keeps k. */
  private familyChoice = new Map<string, string>();

  private buildGroupOptions(ds: SpatialDataset | null): void {
    const sections = new Map<string, { label: string; value: string }[]>();
    const seenFamilies = new Set<string>();
    for (const c of ds?.columns ?? []) {
      if (c.kind !== 'categorical' || c.name === 'segmentation_method') continue;
      const section = c.section ?? 'Groups';
      const list = sections.get(section) ?? [];
      if (c.family) {
        if (seenFamilies.has(c.family.id)) continue;
        seenFamilies.add(c.family.id);
        list.push({ label: c.family.label, value: `family:${c.family.id}` });
      } else {
        list.push({ label: c.description && c.section ? c.description : this.columnLabel(c), value: c.name });
      }
      sections.set(section, list);
    }
    this.groupOptions = [...sections].map(([label, items]) => ({ label, items }));
    this.refreshVariants();
  }

  /** The picker's value for the active group column. */
  get activeGroupEntry(): string | null {
    const name = this.activeCellTypeColumn;
    const meta = name ? this.dataset?.columns.find((c) => c.name === name) : undefined;
    if (meta?.kind === 'categorical' && meta.family) return `family:${meta.family.id}`;
    return name;
  }

  private refreshVariants(): void {
    const name = this.activeCellTypeColumn;
    const meta = name ? this.dataset?.columns.find((c) => c.name === name) : undefined;
    const family = meta?.kind === 'categorical' ? meta.family : undefined;
    const next = family
      ? (this.dataset?.columns ?? [])
        .filter((c) => c.kind === 'categorical' && c.family?.id === family.id)
        .map((c) => ({ label: (c as CategoricalColumnMeta).family!.variant, value: c.name }))
      : [];
    if (JSON.stringify(next) !== JSON.stringify(this.groupVariantOptions)) this.groupVariantOptions = next;
  }

  onGroupEntry(value: string): void {
    if (value.startsWith('family:')) {
      const id = value.slice('family:'.length);
      const members = (this.dataset?.columns ?? [])
        .filter((c) => c.kind === 'categorical' && c.family?.id === id);
      const name = this.familyChoice.get(id) ?? members[0]?.name;
      if (name) this.onCellTypeColumn(name);
      return;
    }
    this.onCellTypeColumn(value);
  }

  onGroupVariant(name: string): void {
    const meta = this.dataset?.columns.find((c) => c.name === name);
    if (meta?.kind === 'categorical' && meta.family) this.familyChoice.set(meta.family.id, name);
    this.onCellTypeColumn(name);
  }

  /** The active grouping's categories with colours and cell counts, largest first. */
  groupRows: { label: string; color: string; count: number }[] = [];
  groupTotal = 0;
  groupsExpanded = true;
  private groupRowsFor: string | null = null;
  groupImportError: string | null = null;
  groupImporting = false;

  private async refreshGroups(): Promise<void> {
    this.refreshVariants();
    const name = this.activeCellTypeColumn;
    if (!name || !this.controls) {
      this.groupRows = [];
      this.groupTotal = 0;
      this.groupRowsFor = null;
      return;
    }
    if (name === this.groupRowsFor) return;
    this.groupRowsFor = name;
    try {
      const v = await this.controls.categoricalView(name);
      if (this.groupRowsFor !== name) return;
      const counts = new Uint32Array(v.categories.length);
      for (const c of v.codes) if (c < counts.length) counts[c]++;
      const rows = v.categories.map((label, i) => ({ label, color: v.colors[i] ?? '#999', count: counts[i] }))
        .sort((a, b) => b.count - a.count);
      this.zone.run(() => {
        this.groupRows = rows;
        this.groupTotal = rows.reduce((n, r) => n + r.count, 0);
      });
    } catch {
      this.groupRowsFor = null;
    }
  }

  isGroupShown(label: string): boolean {
    return !this.view.hiddenGroups.includes(label);
  }

  get allGroupsShown(): boolean {
    return this.view.hiddenGroups.length === 0;
  }

  onGroupShown(label: string, on: boolean): void {
    const hidden = new Set(this.view.hiddenGroups);
    if (on) hidden.delete(label);
    else hidden.add(label);
    this.controls?.setViewState({ hiddenGroups: [...hidden] });
  }

  onAllGroupsShown(on: boolean): void {
    this.controls?.setViewState({ hiddenGroups: on ? [] : this.groupRows.map((r) => r.label) });
  }

  get canImportGroups(): boolean {
    return !!this.controls?.importGroups;
  }

  /** '+': a CSV/TSV of `cell_id` and group, named after the file. */
  async onImportGroupsFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.controls?.importGroups) return;
    this.groupImportError = null;
    this.groupImporting = true;
    try {
      const label = file.name.replace(/\.(csv|tsv|txt)$/i, '');
      const { column } = await this.controls.importGroups(label, await file.text());
      this.zone.run(() => this.onCellTypeColumn(column.name));
    } catch (err) {
      this.zone.run(() => { this.groupImportError = String((err as Error)?.message ?? err); });
    } finally {
      this.zone.run(() => { this.groupImporting = false; });
    }
  }

  get activeCellTypeColumn(): string | null {
    return this.dataset ? cellTypeColumnFor(this.dataset, this.view) : null;
  }

  onShowCells(on: boolean): void {
    this.controls?.setViewState({ showCells: on });
  }

  onCellSet(set: string): void {
    this.controls?.setViewState({ cellSet: set });
  }

  onCellDraw(draw: SpatialViewState['cellDraw']): void {
    this.controls?.setViewState({ cellDraw: draw });
  }

  onCellOpacity(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ cellOpacity: value });
  }

  onCellTypeColumn(name: string | null): void {
    // Switched-off groups belong to the grouping they were switched off in.
    this.controls?.setViewState({ cellTypeColumn: name, hiddenGroups: [] });
  }

  onCellColorMode(mode: SpatialViewState['cellColorMode']): void {
    this.controls?.setViewState({ cellColorMode: mode });
  }

  onCellColorGene(gene: string | null): void {
    this.controls?.setViewState({ cellColorGene: gene });
  }

  onCellSingleColor(hex: string): void {
    this.controls?.setViewState({ cellSingleColor: hex });
  }

  /** Fill opacity as a 0–100 number, for the box beside the slider. */
  onCellOpacityPercent(v: number | null): void {
    if (v === null || !Number.isFinite(v)) return;
    this.controls?.setViewState({ cellOpacity: Math.min(1, Math.max(0.05, v / 100)) });
  }

  onShowImage(on: boolean): void {
    this.controls?.setViewState({ showImage: on });
  }

  onShowAnnotations(on: boolean): void {
    this.controls?.setViewState({ showAnnotations: on });
  }

  // ── sections ────────────────────────────────────────────────────────────

  /** Which collapsible sections are open. Per dialog instance, not persisted. */
  open: Record<'images' | 'cells' | 'transcripts' | 'annotations' | 'observations', boolean> = {
    images: false, cells: true, transcripts: false, annotations: false, observations: false,
  };

  toggleSection(name: keyof SpatialControlsComponent['open']): void {
    this.open = { ...this.open, [name]: !this.open[name] };
  }

  // ── transcripts (Xenium Explorer layout) ─────────────────────────────────

  /** The mode the section header's switch turns back on. */
  private lastTranscriptMode: Exclude<SpatialViewState['transcriptMode'], 'off'> = 'circles';

  onTranscriptsOn(on: boolean): void {
    if (!on) {
      if (this.view.transcriptMode !== 'off') this.lastTranscriptMode = this.view.transcriptMode;
      this.controls?.setViewState({ transcriptMode: 'off' });
      return;
    }
    const mode = this.dataset?.transcriptTiles ? this.lastTranscriptMode : 'density';
    this.onTranscriptMode(mode);
    this.open = { ...this.open, transcripts: true };
  }

  /** Estimated transcripts in view, against the budget — Explorer's points bar. */
  estimate: { points: number; max: number } | null = null;
  /** The density window in use and its densest bin, for the threshold control. */
  densityStats: { lo: number; hi: number; max: number } | null = null;

  get estimatePercent(): number {
    const e = this.estimate;
    return e && e.max > 0 ? Math.min(100, (100 * e.points) / e.max) : 0;
  }

  get estimateOverMax(): boolean {
    return !!this.estimate && this.estimate.points > this.estimate.max;
  }

  editingMax = false;

  /** The selected genes as Explorer's tree: named groups, then the ungrouped ones. */
  /** Rebuilt when the view changes — never per change-detection pass (see buildTileOptions). */
  geneTree: { name: string | null; genes: string[] }[] = [];
  geneMenu: { label: string; icon: string; command: () => void; disabled?: boolean }[] = [];

  private buildGeneTree(): { name: string | null; genes: string[] }[] {
    const selected = this.view.transcriptGenes;
    const chosen = new Set(selected);
    const grouped = new Set<string>();
    const out: { name: string | null; genes: string[] }[] = [];
    for (const g of this.view.transcriptGeneGroups) {
      const genes = g.genes.filter((x) => chosen.has(x));
      if (!genes.length) continue;
      genes.forEach((x) => grouped.add(x));
      out.push({ name: g.name, genes });
    }
    const rest = selected.filter((x) => !grouped.has(x));
    if (rest.length) out.push({ name: null, genes: rest });
    return out;
  }

  /** Real genes in the panel — the tree's denominator. */
  get geneTotal(): number {
    return this.dataset?.transcriptTiles?.geneCount ?? this.dataset?.features?.count ?? this.geneNames.length;
  }

  collapsedGeneGroups = new Set<string>();
  geneTreeOpen = true;

  toggleGeneGroup(name: string): void {
    const next = new Set(this.collapsedGeneGroups);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    this.collapsedGeneGroups = next;
  }

  isGeneShown(gene: string): boolean {
    return !this.view.transcriptHiddenGenes.includes(gene);
  }

  areGenesShown(genes: string[]): boolean {
    return genes.some((g) => this.isGeneShown(g));
  }

  /** The eye toggle: hide or show genes without removing them from the selection. */
  onGenesShown(genes: string[], on: boolean): void {
    const hidden = new Set(this.view.transcriptHiddenGenes);
    for (const g of genes) {
      if (on) hidden.delete(g);
      else hidden.add(g);
    }
    this.controls?.setViewState({ transcriptHiddenGenes: [...hidden] });
  }

  onGeneColor(gene: string, hex: string): void {
    this.controls?.setViewState({ transcriptGeneColors: { ...this.view.transcriptGeneColors, [gene]: hex } });
  }

  // ── per-gene icon and colour picker ──────────────────────────────────────

  /** Swatches in the picker: the categorical palette genes are coloured from by default. */
  readonly colorPresets = DEFAULT_CATEGORICAL_PALETTE.slice(0, 10).map((c) => c.toLowerCase());
  /** The gene the open picker edits. */
  styleGene: string | null = null;

  openGeneStyle(event: Event, gene: string, panel: { toggle(e: Event): void; hide(): void }): void {
    if (this.styleGene === gene) {
      panel.toggle(event);
      return;
    }
    this.styleGene = gene;
    panel.hide();
    // Re-open anchored on the row that was clicked, once the panel has closed.
    setTimeout(() => panel.toggle(event));
  }

  /** The icon the open picker shows as chosen. */
  get styleGlyph(): TranscriptGlyphName | null {
    const gene = this.styleGene;
    return gene ? this.glyphOf(gene, Math.max(0, this.view.transcriptGenes.indexOf(gene))) : null;
  }

  glyphPoints(glyph: TranscriptGlyphName): string {
    return GLYPH_OPTIONS.find((o) => o.value === glyph)?.points ?? '';
  }

  /** A typed hex colour, accepted as `#rrggbb` or `rrggbb`; anything else is ignored. */
  onGeneHex(gene: string, text: string): void {
    const m = /^#?([0-9a-f]{6})$/i.exec(text.trim());
    if (m) this.onGeneColor(gene, `#${m[1].toLowerCase()}`);
  }

  /** Back to the gene's default icon and colour (by its position in the list). */
  resetGeneStyle(gene: string): void {
    const colors = { ...this.view.transcriptGeneColors };
    const glyphs = { ...this.view.transcriptGlyphs };
    delete colors[gene];
    delete glyphs[gene];
    this.controls?.setViewState({ transcriptGeneColors: colors, transcriptGlyphs: glyphs });
  }

  /** '±': every gene, or back to the chosen list. */
  onToggleAllGenes(): void {
    if (!this.canShowAllGenes) return;
    this.onTranscriptAllGenes(!this.view.transcriptAllGenes);
  }

  /** '⋮' menu. */
  private buildGeneMenu(): { label: string; icon: string; command: () => void; disabled?: boolean }[] {
    return [
      {
        label: 'Add marker genes of clusters…', icon: 'pi pi-sitemap',
        disabled: !this.canAddMarkers, command: () => this.openMarkers(),
      },
      {
        label: 'New group from selected genes', icon: 'pi pi-folder-plus',
        disabled: !this.view.transcriptGenes.length, command: () => this.onNewGeneGroup(),
      },
      { label: 'Import gene groups (CSV)…', icon: 'pi pi-upload', command: () => this.geneGroupInput?.click() },
      {
        label: 'Remove gene groups', icon: 'pi pi-times',
        disabled: !this.view.transcriptGeneGroups.length,
        command: () => this.controls?.setViewState({ transcriptGeneGroups: [] }),
      },
      {
        label: 'Clear selection', icon: 'pi pi-ban', disabled: !this.view.transcriptGenes.length,
        command: () => this.controls?.setViewState({ transcriptGenes: [], transcriptHiddenGenes: [] }),
      },
    ];
  }

  /** The hidden file input the menu's import opens. */
  @ViewChild('geneGroupFile') private geneGroupFileRef?: ElementRef<HTMLInputElement>;
  private get geneGroupInput(): HTMLInputElement | null {
    return this.geneGroupFileRef?.nativeElement ?? null;
  }

  trackByLabel = (_i: number, row: { label: string }) => row.label;
  trackByNode = (_i: number, node: { name: string | null }) => node.name ?? '';
  trackByLabelString = (_i: number, s: string) => s;

  get cellOpacityPercent(): number {
    return Math.round(this.view.cellOpacity * 100);
  }

  get densityOpacityPercent(): number {
    return Math.round(this.view.densityOpacity * 100);
  }
  geneGroupError: string | null = null;

  // ── per-gene counts in view ─────────────────────────────────────────────

  /** Transcripts of each selected gene in the current view, from the renderer. */
  geneCounts: Record<string, number> | null = null;

  geneCountOf(gene: string): number | null {
    return this.geneCounts ? (this.geneCounts[gene] ?? 0) : null;
  }

  // ── marker genes of clusters, as gene groups ────────────────────────────

  markersOpen = false;
  markerColumn: string | null = null;
  markerPerGroup = 5;
  readonly markerPerGroupOptions = [3, 5, 10, 20].map((n) => ({ label: `${n} genes`, value: n }));
  markerClusters: string[] = [];
  markerClusterOptions: { label: string; value: string }[] = [];
  markerLoading = false;
  markerError: string | null = null;

  get canAddMarkers(): boolean {
    return !!this.controls?.markerGenes && this.markerColumnOptions.length > 0;
  }

  /** Every categorical column but the segmentation method, which says nothing about genes. */
  get markerColumnOptions(): { label: string; value: string }[] {
    return (this.dataset?.columns ?? [])
      .filter((c): c is CategoricalColumnMeta => c.kind === 'categorical' && c.name !== 'segmentation_method')
      .map((c) => ({ label: c.description && c.section ? c.description : this.columnLabel(c), value: c.name }));
  }

  openMarkers(): void {
    const options = this.markerColumnOptions;
    const active = this.activeCellTypeColumn;
    if (!this.markerColumn || !options.some((o) => o.value === this.markerColumn)) {
      this.markerColumn = active && options.some((o) => o.value === active) ? active : options[0]?.value ?? null;
    }
    this.markerError = null;
    this.refreshMarkerClusters();
    this.markersOpen = true;
    this.open = { ...this.open, transcripts: true };
  }

  onMarkerColumn(column: string): void {
    this.markerColumn = column;
    this.refreshMarkerClusters();
  }

  /** The clusters of the chosen column, all picked to start with. */
  private refreshMarkerClusters(): void {
    const col = this.dataset?.columns.find((c) => c.name === this.markerColumn);
    const categories = col && col.kind === 'categorical' ? col.categories : [];
    this.markerClusterOptions = categories.map((c) => ({ label: c, value: c }));
    this.markerClusters = [...categories];
  }

  /**
   * Add each picked cluster's top marker genes as a gene group named after it, and select
   * them. A gene that marks several clusters goes to the one it is most specific to, so the
   * tree lists it once.
   */
  async addMarkerGenes(): Promise<void> {
    const column = this.markerColumn;
    const markerGenes = this.controls?.markerGenes;
    if (!column || !markerGenes || !this.markerClusters.length) return;
    // The form stays editable while the scan runs: apply what was picked when it was asked.
    const picked = new Set(this.markerClusters);
    this.markerLoading = true;
    this.markerError = null;
    try {
      const result = await markerGenes(column, this.markerPerGroup);
      this.zone.run(() => {
        const best = new Map<string, { group: string; score: number }>();
        for (const g of result.groups) {
          if (!picked.has(g.name)) continue;
          for (const gene of g.genes) {
            const prev = best.get(gene.name);
            if (!prev || gene.score > prev.score) best.set(gene.name, { group: g.name, score: gene.score });
          }
        }
        const groups = result.groups
          .filter((g) => picked.has(g.name))
          .map((g) => ({
            name: g.name,
            genes: g.genes.map((x) => x.name).filter((n) => best.get(n)?.group === g.name),
          }))
          .filter((g) => g.genes.length);
        if (!groups.length) {
          this.markerError = 'No marker genes passed the filter for the chosen clusters.';
          return;
        }
        const names = new Set(groups.map((g) => g.name));
        const genes = [...this.view.transcriptGenes];
        for (const g of groups) for (const n of g.genes) if (!genes.includes(n)) genes.push(n);
        this.controls?.setViewState({
          transcriptGeneGroups: [...this.view.transcriptGeneGroups.filter((g) => !names.has(g.name)), ...groups],
          transcriptGenes: genes,
          // Marker groups are clusters: colour the transcripts by them, as their cells are.
          transcriptColorBy: 'cluster',
          ...(this.view.transcriptMode === 'off' ? { transcriptMode: 'circles' as const } : {}),
        });
        this.markersOpen = false;
      });
    } catch (err) {
      this.zone.run(() => {
        const e = err as { error?: { error?: string }; message?: string };
        this.markerError = e?.error?.error ?? e?.message ?? 'Could not compute marker genes.';
      });
    } finally {
      this.zone.run(() => { this.markerLoading = false; });
    }
  }

  onNewGeneGroup(): void {
    const name = (globalThis.prompt?.('Name for this gene group', 'Gene group') ?? '').trim();
    if (!name) return;
    const groups = this.view.transcriptGeneGroups.filter((g) => g.name !== name);
    this.controls?.setViewState({
      transcriptGeneGroups: [...groups, { name, genes: [...this.view.transcriptGenes] }],
    });
  }

  /**
   * Import gene groups: CSV/TSV with a group and a gene column (header optional), e.g.
   * marker genes per cell type. The genes are added to the selection.
   */
  async onImportGeneGroups(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.geneGroupError = null;
    const groups = parseGeneGroups(await file.text());
    if (!groups.length) {
      this.zone.run(() => { this.geneGroupError = 'No "group,gene" rows found in that file.'; });
      return;
    }
    const names = new Set(groups.map((g) => g.name));
    const genes = [...new Set([...this.view.transcriptGenes, ...groups.flatMap((g) => g.genes)])];
    this.zone.run(() => this.controls?.setViewState({
      transcriptGeneGroups: [...this.view.transcriptGeneGroups.filter((g) => !names.has(g.name)), ...groups],
      transcriptGenes: genes,
      transcriptAllGenes: false,
    }));
  }

  // density
  readonly densityBins = [10, 20, 40, 80];

  get densityBinIndex(): number {
    return Math.max(0, this.densityBins.indexOf(this.view.densityBin));
  }

  onDensityBinIndex(i: number | undefined): void {
    if (i === undefined) return;
    this.controls?.setViewState({ densityBin: this.densityBins[i] ?? 10 });
  }

  onDensityOpacityPercent(v: number | null): void {
    if (v === null || !Number.isFinite(v)) return;
    this.controls?.setViewState({ densityOpacity: Math.min(1, Math.max(0.05, v / 100)) });
  }

  /**
   * The threshold window shown: the one set, else the one derived. A stored array, not a
   * getter: a range slider's `ngModel` given a fresh array every change-detection pass
   * schedules another pass, forever — which hung the page the moment the density
   * controls appeared.
   */
  densityWindow: [number, number] = [0, 1];
  densitySliderMax = 1;
  densityStep = 0.005;

  private refreshDensityWindow(): void {
    const next: [number, number] = this.view.densityRange
      ?? (this.densityStats ? [this.densityStats.lo, this.densityStats.hi] : [0, 1]);
    if (next[0] !== this.densityWindow[0] || next[1] !== this.densityWindow[1]) this.densityWindow = next;
    this.densitySliderMax = Math.max(this.densityStats?.max ?? 1, this.densityWindow[1]);
    this.densityStep = this.densitySliderMax / 200;
  }

  onDensityRange(range: [number, number] | number[] | undefined): void {
    if (!range || range.length !== 2) return;
    this.controls?.setViewState({ densityRange: [Math.min(range[0], range[1]), Math.max(range[0], range[1])] });
  }

  onDensityRangeEnd(which: 0 | 1, v: number | null): void {
    if (v === null || !Number.isFinite(v)) return;
    const next: [number, number] = [...this.densityWindow];
    next[which] = v;
    this.onDensityRange(next);
  }

  onDensityAuto(): void {
    this.controls?.setViewState({ densityRange: null });
  }

  selectedDensityColormapNode: ColormapNode | null = null;

  onDensityColormap(node: ColormapNode | null): void {
    this.selectedDensityColormapNode = node;
    this.controls?.setViewState({ densityColormap: node?.data?.value ?? null });
  }

  get densityColorBarCss(): string {
    const lut = lutFor(this.view.densityColormap ?? INFERNO_SCALE);
    const stops: string[] = [];
    for (let i = 0; i <= 16; i++) {
      const [r, g, b] = lut[Math.round((i / 16) * (lut.length - 1))];
      stops.push(`rgb(${r},${g},${b}) ${((i / 16) * 100).toFixed(0)}%`);
    }
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }

  onTranscriptMode(mode: SpatialViewState['transcriptMode']): void {
    // Seed the gene list from the gene being coloured by, so switching transcripts on
    // shows something straight away.
    const seed = !this.view.transcriptGenes.length && this.view.colorBy?.kind === 'feature'
      ? [this.view.colorBy.name] : null;
    this.controls?.setViewState({ transcriptMode: mode, ...(seed ? { transcriptGenes: seed } : {}) });
  }

  onTranscriptGenes(genes: string[] | null): void {
    this.controls?.setViewState({ transcriptGenes: [...(genes ?? [])] });
  }

  /** "All genes" needs the grouping pyramid, or at least tiles to draw individually. */
  get canShowAllGenes(): boolean {
    return !!this.dataset?.transcriptBins;
  }

  /** Why "All genes" is not offered yet, while the server builds its pyramid. */
  get allGenesPreparing(): string | null {
    const st = this.dataset?.transcriptBinsStatus;
    if (!st || this.canShowAllGenes) return null;
    if (st.state === 'failed') return `"All genes" is unavailable: preparing it failed (${st.message ?? 'unknown error'}).`;
    const pct = st.total ? ` — ${Math.floor((100 * (st.done ?? 0)) / st.total)}% when this dataset was opened` : '';
    return `"All genes" is being prepared on the server${pct}; reopen the dataset once it is done.`;
  }

  get showingAllGenes(): boolean {
    return this.canShowAllGenes && this.view.transcriptAllGenes && this.view.transcriptMode !== 'density';
  }

  onTranscriptAllGenes(on: boolean): void {
    this.controls?.setViewState({ transcriptAllGenes: on });
  }

  onTranscriptBudget(n: number): void {
    this.controls?.setViewState({ transcriptBudget: n });
  }

  onTranscriptColorBy(by: SpatialViewState['transcriptColorBy']): void {
    this.controls?.setViewState({ transcriptColorBy: by });
  }

  onTranscriptScale(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ transcriptScale: value });
  }

  onTranscriptOpacity(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ transcriptOpacity: value });
  }

  onTranscriptQuality(includeLow: boolean): void {
    this.controls?.setViewState({ transcriptQuality: includeLow ? 'all' : 'high' });
  }

  onDensityOpacity(value: number | undefined): void {
    if (value === undefined) return;
    this.controls?.setViewState({ densityOpacity: value });
  }

  glyphOf(gene: string, slot: number): TranscriptGlyphName {
    return this.view.transcriptGlyphs[gene] ?? defaultGlyphFor(slot);
  }

  onGlyph(gene: string, glyph: TranscriptGlyphName): void {
    this.controls?.setViewState({ transcriptGlyphs: { ...this.view.transcriptGlyphs, [gene]: glyph } });
  }

  /** The colour gene `slot` is drawn in when transcripts are coloured by gene. */
  geneColor(slot: number): string {
    const gene = this.view?.transcriptGenes[slot];
    return (gene && this.view.transcriptGeneColors[gene])
      || DEFAULT_CATEGORICAL_PALETTE[slot % DEFAULT_CATEGORICAL_PALETTE.length];
  }

  /** Colours of the cells' groups, by name — what a cluster of the same name is drawn in. */
  private cellGroupColors = new Map<string, string>();
  private cellGroupColorsFor: string | null = null;

  private async refreshCellGroupColors(): Promise<void> {
    const column = this.activeCellTypeColumn;
    if (column === this.cellGroupColorsFor) return;
    this.cellGroupColorsFor = column;
    const map = new Map<string, string>();
    const meta = column ? this.dataset?.columns.find((c) => c.name === column) : null;
    if (meta && meta.kind === 'categorical' && this.controls) {
      try {
        const colors = await this.controls.categoryColors(column!);
        meta.categories.forEach((c, k) => { if (colors[k]) map.set(c, colors[k]); });
      } catch {
        // No colours: palette colours, as the markers fall back to.
      }
    }
    // The cells' grouping changed while the colours loaded: the newer request applies its own.
    if (this.cellGroupColorsFor !== column) return;
    this.zone.run(() => { this.cellGroupColors = map; });
  }

  /** In Cluster colouring, a gene's swatch is its cluster's colour, as its markers are. */
  geneSwatchOf(gene: string): string {
    if (this.view.transcriptColorBy !== 'cluster') return this.geneColorOf(gene);
    const colors = clusterColorMap(this.view.transcriptGenes, this.view.transcriptGeneGroups,
      this.cellGroupColors, DEFAULT_CATEGORICAL_PALETTE);
    return colors.get(clusterOfGene(gene, this.view.transcriptGeneGroups)) ?? this.geneColorOf(gene);
  }

  geneColorOf(gene: string): string {
    return this.geneColor(Math.max(0, this.view.transcriptGenes.indexOf(gene)));
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

    const current = this.keyLoad.next();
    if (meta?.kind === 'categorical') {
      try {
        const colors = await this.controls.categoryColors(by.name);
        // Same race, same cost if it is lost: a slower earlier column would paint
        // its palette into the legend for the column now selected.
        if (!current()) return;
        this.legend = meta.categories.map((label, i) => ({ label, color: colors[i] }));
        this.colorBarCss = null;
      } catch {
        if (!current()) return;
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

  /**
   * The continuous colour scale's colormap. Clearing it goes back to following
   * the image's, which is the default.
   */
  onContinuousColormap(node: ColormapNode | null): void {
    this.selectedColormapNode = node;
    // The value is a ColormapValue, which is a NAME for the built-in scales and an
    // inline `[stop, colour]` array for the rest — half the library's colormaps
    // are the array kind, so anything that only accepts a string silently drops
    // them. A group row carries no value and clears the setting.
    this.controls?.setViewState({ continuousColormap: node?.data?.value ?? null });
  }

  /** The tree node holding a colormap value, so the picker shows what is in use. */
  private colormapNodeFor(value: ColormapValue | null): ColormapNode | null {
    if (!value) return null;
    for (const group of this.colormapOptions) {
      for (const node of group.children ?? []) {
        // Reference equality: the value came out of this same tree, and an inline
        // scale is a 256-entry array not worth comparing element by element.
        if (node.data?.value === value) return node;
      }
      if (group.data?.value === value) return group;
    }
    return null;
  }

  /**
   * `linear-gradient(...)` sampling the active colormap at 16 stops.
   *
   * Resolved exactly the way the renderer resolves it — the same override, the
   * same grey fallback. Built from `lutFor` alone, this bar showed a black-to-white
   * ramp while the canvas drew Viridis, which makes the key worse than no key.
   */
  private buildColorBar(): string {
    const lut = spatialContinuousLut(
      this.colormap?.data?.value, this.reverse, this.view.continuousColormap,
    );
    const stops: string[] = [];
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      const [r, g, b] = lut[Math.round((i / steps) * 255)];
      stops.push(`rgb(${r},${g},${b}) ${((i / steps) * 100).toFixed(0)}%`);
    }
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }
}
