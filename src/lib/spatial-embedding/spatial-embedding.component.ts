import {
  AfterViewInit, Component, ElementRef, HostBinding, Inject, OnDestroy, OnInit,
} from '@angular/core';
import { Subscription, combineLatest } from 'rxjs';
import * as Plotly from 'plotly.js-dist-min';

import { VISUALIZER, IVisualizer, ISpatialControls } from '../contracts/visualizer.contract';
import {
  SpatialDataset, SpatialEmbedding, SpatialEmbeddingMeta,
} from '../contracts/spatial-dataset.contract';
import { SpatialColorBy } from '../contracts/display-types';
import {
  SpatialSelectionMask, emptySelection, maskToIndices,
} from '../spatial/spatial-selection';
import { buildUmapTraces, umapLayout } from '../implementations/plotly/omics-trace-builders';

/** Per-instance plot-div id, for the same reason the charts panel has one: two mounted
 *  panels sharing a DOM id means `getElementById` hands both the first element. */
let embeddingInstanceSeq = 0;

/** Plotly config. `scrollZoom` is on: an embedding is explored by zooming into a cluster,
 *  and reaching for a toolbar button to do it breaks that. */
const EMBEDDING_CONFIG = {
  displaylogo: false,
  responsive: true,
  scrollZoom: true,
  modeBarButtonsToRemove: ['autoScale2d'],
};

/**
 * The embedding view — a UMAP (or t-SNE, or PCA) beside the tissue map.
 *
 * Answers the question the map cannot. The map says WHERE a population sits; the embedding
 * says which populations there are and how close they are in expression. The two are worth
 * having together only if they are linked, so this colours by whatever the map is coloured
 * by and dims to the map's current selection — the same cell is the same colour in both,
 * and a region picked on the tissue lights up here.
 *
 * A DOCKABLE panel, following the toolbar's precedent: docked beside the viewer by default,
 * where it takes real width from the canvas rather than covering it, and detachable into a
 * floating window for a second monitor. The charts panel is cramped into a dialog at 448px,
 * which is what forced the heatmap's column cap; this one is meant to be given room.
 */
@Component({
  selector: 'spatial-embedding',
  templateUrl: './spatial-embedding.component.html',
  styleUrls: ['./spatial-embedding.component.scss'],
})
export class SpatialEmbeddingComponent implements OnInit, AfterViewInit, OnDestroy {
  /**
   * Load-bearing, not cosmetic: a custom element is `display: inline` by default, and an
   * inline box cannot be a flex child that takes width from the canvas beside it.
   */
  @HostBinding('style.display') readonly hostDisplay = 'flex';
  @HostBinding('class.floating') get floatingClass(): boolean {
    return this.floating;
  }
  /** Docked width, owned here rather than by the shell so the splitter has one source of
   *  truth to move. Ignored while floating, where the window's own size governs. */
  @HostBinding('style.width.px') get widthPx(): number | null {
    return this.floating ? null : this.width;
  }

  readonly plotDiv = `spatial-embedding-plot-${++embeddingInstanceSeq}`;

  controls: ISpatialControls | null = null;
  dataset: SpatialDataset | null = null;
  /** Embeddings this dataset offers, for the picker. */
  options: SpatialEmbeddingMeta[] = [];
  active: SpatialEmbeddingMeta | null = null;
  busy = false;
  notice: string | null = null;
  /** Detached into a floating window rather than docked beside the viewer. */
  floating = false;
  /** Panel width when docked, in px — dragged by the splitter on its inner edge. */
  width = 420;

  private colorBy: SpatialColorBy | null = null;
  private selection: SpatialSelectionMask = emptySelection();
  private coords: SpatialEmbedding | null = null;
  private readonly subs = new Subscription();
  /** Sequences async loads: a slower embedding must not paint over a newer choice. */
  private token = 0;
  private resizeObserver?: ResizeObserver;
  private resizeFrame: number | null = null;
  private dragFrom: { x: number; width: number } | null = null;

  constructor(
    @Inject(VISUALIZER) private readonly viz: IVisualizer,
    private readonly host: ElementRef<HTMLElement>,
  ) {}

  /** Whether this dataset has anything to show here at all. */
  get available(): boolean {
    return this.options.length > 0;
  }

  ngOnInit(): void {
    this.controls = this.viz.getSpatialControls?.() ?? null;
    if (!this.controls) return;
    this.subs.add(combineLatest([
      this.controls.getDataset$(),
      this.controls.getViewState$(),
      this.controls.getSelection$(),
    ]).subscribe(([dataset, view, selection]) => {
      const datasetChanged = dataset?.id !== this.dataset?.id;
      this.dataset = dataset;
      this.colorBy = view.colorBy;
      this.selection = selection;
      if (datasetChanged) {
        this.options = dataset?.embeddings ? [...dataset.embeddings] : [];
        this.active = this.options[0] ?? null;
        this.coords = null;
      }
      void this.render();
    }));
  }

  ngAfterViewInit(): void {
    // Observe the HOST: the plot div sits behind an `*ngIf`, so it does not exist yet.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.onResize());
      this.resizeObserver.observe(this.host.nativeElement);
    }
    void this.render();
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.resizeObserver?.disconnect();
    if (this.resizeFrame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.resizeFrame);
    }
    try {
      Plotly.purge(this.plotDiv);
    } catch {
      // Never plotted, or the div went with the panel.
    }
  }

  /** Pick which embedding to show, when a dataset offers more than one. */
  onEmbedding(name: string): void {
    const next = this.options.find((e) => e.name === name);
    if (!next || next.name === this.active?.name) return;
    this.active = next;
    this.coords = null;
    void this.render();
  }

  /** Detach into a floating window, or dock again. */
  toggleFloating(): void {
    this.floating = !this.floating;
    // The panel's box changes, and Plotly does not follow a container resize on its own.
    this.onResize();
  }

  onSplitterDown(event: MouseEvent): void {
    event.preventDefault();
    this.dragFrom = { x: event.clientX, width: this.width };
  }

  onSplitterMove(event: MouseEvent): void {
    if (!this.dragFrom) return;
    // Dragging the inner edge leftwards widens the panel, so the delta is inverted.
    const next = this.dragFrom.width + (this.dragFrom.x - event.clientX);
    this.width = Math.max(240, Math.min(next, 1200));
    this.onResize();
  }

  onSplitterUp(): void {
    this.dragFrom = null;
  }

  private onResize(): void {
    if (this.resizeFrame !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      this.fitPlot();
      return;
    }
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null;
      this.fitPlot();
    });
  }

  private fitPlot(): void {
    const el = document.getElementById(this.plotDiv);
    if (!el || el.clientWidth <= 0) return;
    try {
      // No fixed height in the layout, so both dimensions come from the container.
      Plotly.relayout(el, { autosize: true });
    } catch {
      // Nothing plotted yet.
    }
  }

  private async render(): Promise<void> {
    const controls = this.controls;
    const meta = this.active;
    const el = document.getElementById(this.plotDiv);
    if (!el) return;
    if (!controls || !this.dataset || !meta) {
      this.purge();
      return;
    }

    const token = ++this.token;
    if (!this.coords || this.coords.meta.name !== meta.name) {
      if (!controls.getEmbedding) {
        this.notice = 'This data source does not serve embeddings.';
        this.purge();
        return;
      }
      this.busy = true;
      try {
        const loaded = await controls.getEmbedding(meta.name);
        if (token !== this.token) return; // a newer choice already won
        this.coords = loaded;
      } catch {
        if (token !== this.token) return;
        this.notice = `Could not load ${meta.label ?? meta.name}.`;
        this.purge();
        return;
      } finally {
        if (token === this.token) this.busy = false;
      }
    }

    const coords = this.coords;
    if (!coords) return;
    this.notice = null;

    // Colour by whatever the MAP is coloured by, so the same cell is the same colour in
    // both. A gene (continuous) is not handled here yet — the categorical case is what
    // makes an embedding readable, and a colour bar is a separate piece of work.
    const source = this.colorBy;
    const isCategorical = source?.kind === 'column' && this.dataset.columns
      .some((c) => c.name === source.name && c.kind === 'categorical');
    let categories: { codes: Uint16Array; names: string[]; colors: string[] } | undefined;
    if (isCategorical && source) {
      // `categoricalView` already resolves each category's colour — the same call the map
      // makes — so the two cannot disagree about what a colour means.
      const loaded = await controls.categoricalView(source.name).catch(() => null);
      if (token !== this.token) return;
      if (loaded) {
        categories = {
          codes: loaded.codes,
          names: [...loaded.categories],
          colors: [...loaded.colors],
        };
      }
    }

    const input = {
      x: coords.x,
      y: coords.y,
      label: meta.label ?? meta.name,
      derived: meta.derived,
      ...(categories ? { categories } : {}),
      // Dim rather than drop, so the embedding's shape stays as context.
      ...(this.selection.count > 0 ? { selection: this.selection.mask } : {}),
    };
    await Plotly.react(
      this.plotDiv, buildUmapTraces(input) as never, umapLayout(input) as never,
      EMBEDDING_CONFIG as never,
    );
  }

  /** What the panel is showing, said plainly. */
  get note(): string {
    if (!this.available) return 'This dataset publishes no embedding.';
    const n = this.dataset?.observations.count ?? 0;
    const scope = this.selection.count > 0
      ? ` ${maskToIndices(this.selection.mask).length.toLocaleString()} selected are highlighted;`
      : '';
    return `${n.toLocaleString()} observations.${scope} Coloured to match the map.`;
  }

  private purge(): void {
    try {
      Plotly.purge(this.plotDiv);
    } catch {
      // Nothing plotted.
    }
  }
}
