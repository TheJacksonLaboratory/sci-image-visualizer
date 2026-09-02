import {
  Component, EventEmitter, Inject, Input, OnDestroy, OnInit, Output,
} from '@angular/core';
import { Subscription, combineLatest } from 'rxjs';

import { VISUALIZER, IVisualizer, ISpatialControls } from '../contracts/visualizer.contract';
import {
  CategoricalColumnMeta, SpatialColumnMeta, SpatialDataset,
} from '../contracts/spatial-dataset.contract';
import { ColormapNode, SpatialViewState, DEFAULT_SPATIAL_VIEW } from '../contracts/display-types';
import { lutFor } from '../implementations/spatial/spatial-encoding';

/** One legend row for a categorical colouring. */
export interface SpatialLegendEntry {
  label: string;
  color: string;
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
  @Output() visibleChange = new EventEmitter<boolean>();

  readonly clipOptions = CLIP_OPTIONS;

  /** Null when the host bound no `SPATIAL_DATA_PORT`. */
  controls: ISpatialControls | null = null;
  dataset: SpatialDataset | null = null;
  view: SpatialViewState = { ...DEFAULT_SPATIAL_VIEW };

  /** Colour-by column choices — "None" plus every column the dataset declares. */
  columnOptions: { label: string; value: string | null }[] = [];
  selectedColumn: string | null = null;

  /** Gene typeahead. */
  geneQuery: string | null = null;
  geneSuggestions: string[] = [];
  geneSearchFailed = false;

  /** Categorical key, or null when the active colouring is continuous. */
  legend: SpatialLegendEntry[] | null = null;
  /** CSS gradient for a continuous colouring, or null when categorical. */
  colorBarCss: string | null = null;

  private colormap: ColormapNode | null = null;
  private reverse = false;
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
      this.geneQuery = null;
      this.geneSuggestions = [];
      void this.refreshKey();
    }));

    this.subs.add(this.controls.getViewState$().subscribe((view) => {
      this.view = view;
      this.selectedColumn = view.colorBy?.kind === 'column' ? view.colorBy.name : null;
      if (view.colorBy?.kind === 'feature') this.geneQuery = view.colorBy.name;
      void this.refreshKey();
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
      this.geneQuery = null;
      return;
    }
    this.geneQuery = null;
    this.controls?.colorByColumn(name);
  }

  /** Gene typeahead query — delegates to the port (or its local fallback). */
  async searchGenes(event: { query: string }): Promise<void> {
    if (!this.controls) return;
    try {
      this.geneSuggestions = await this.controls.searchFeatures(event.query, 25);
      this.geneSearchFailed = false;
    } catch {
      // A failed lookup must not wedge the box — show none and say so.
      this.geneSuggestions = [];
      this.geneSearchFailed = true;
    }
  }

  /** A gene was picked; it supersedes any column selection. */
  onGene(name: string): void {
    if (!name) return;
    this.selectedColumn = null;
    this.controls?.colorByFeature(name);
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
  onClip(value: [number, number]): void {
    this.controls?.setViewState({ percentileClip: value });
  }
  reset(): void {
    this.controls?.setViewState({ ...DEFAULT_SPATIAL_VIEW });
    this.selectedColumn = null;
    this.geneQuery = null;
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

    if (meta?.kind === 'categorical') {
      try {
        const colors = await this.controls.categoryColors(by.name);
        this.legend = meta.categories.map((label, i) => ({ label, color: colors[i] }));
        this.colorBarCss = null;
      } catch {
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
