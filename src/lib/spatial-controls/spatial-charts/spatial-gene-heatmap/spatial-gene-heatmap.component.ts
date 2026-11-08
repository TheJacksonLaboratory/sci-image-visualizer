import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CheckboxModule } from 'primeng/checkbox';
import { DropdownModule } from 'primeng/dropdown';
import { InputTextModule } from 'primeng/inputtext';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TooltipModule } from 'primeng/tooltip';
import { PLASMA_LUT, RDBU_LUT } from 'napari-js/colormaps';

import type { SpatialGeneHeatmapAccess } from '../../../contracts/visualizer.contract';
import type {
  SpatialGeneHeatmap,
  SpatialGeneHeatmapMeans,
  SpatialGeneHeatmapScale,
} from '../../../contracts/spatial-dataset.contract';
import { buildColormapLut } from '../../../contracts/colormap-lut';
import { rgbToHex } from '../../../contracts/color';
import { Supersede } from '../../../util/supersede';
import {
  HeatmapExtent,
  HeatmapWindow,
  ZoomAxes,
  clampWindow,
  fitWindow,
  groupAt,
  levelFor,
  maxLevel,
  panWindow,
  revealRow,
  tileRect,
  tilesFor,
  zoomWindow,
} from '../../../spatial/gene-heatmap/heatmap-viewport';
import {
  GroupScale,
  blockRows,
  lutRgba,
  paintValues,
  rangeOf,
  scaleMeans,
} from '../../../spatial/gene-heatmap/heatmap-paint';
import { HeatmapTile, HeatmapTileStore, tileKey } from '../../../spatial/gene-heatmap/heatmap-tile-store';

/** Which matrix is drawn: every cell, or each group's mean. */
export type GeneHeatmapView = 'cells' | 'groups';

/** Room left of the plot for gene names, and above it for the group bar and column labels. */
const GUTTER = 104;
const TOP = 66;
const BAR = 10;
/** Labels are drawn once a row or column is at least this tall or wide on screen. */
const LABEL_PX = 9;
/** Each wheel notch zooms by this much. */
const WHEEL_ZOOM = 1.25;

const CELLS_LUT = lutRgba(buildColormapLut(PLASMA_LUT)!);
const DIVERGING_LUT = lutRgba(buildColormapLut(RDBU_LUT, true)!);

interface HoverLine {
  label: string;
  value: string;
}

/**
 * Every gene of the dataset against its cells, the cells sorted by the groups of one
 * categorical column — the whole transcriptome on one zoomable canvas.
 *
 * Two views of the same matrix:
 *  - **Cells**: a column per cell, as the server's tiles at the level of detail the zoom
 *    needs. Zoomed out, a pixel is the mean of a block of cells and genes; zoomed in, one
 *    cell and one gene, with their names.
 *  - **Groups**: a column per group, each gene's mean in it (from one small download),
 *    z-scored across the groups by default.
 *
 * Genes are ordered by the group where they peak, so the matrix reads as a diagonal of
 * marker blocks. Scroll zooms both axes about the pointer (Shift: genes only, Alt: cells
 * only), dragging pans, a double-click resets, and clicking a gene emits it, for the map to
 * be coloured by it.
 *
 * Drawn on a 2D canvas: the tiles are small images scaled with smoothing off, which is all
 * the GPU work this needs.
 */
@Component({
  selector: 'spatial-gene-heatmap',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CheckboxModule,
    DropdownModule,
    InputTextModule,
    SelectButtonModule,
    TooltipModule,
  ],
  templateUrl: './spatial-gene-heatmap.component.html',
  styleUrls: ['./spatial-gene-heatmap.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialGeneHeatmapComponent implements AfterViewInit, OnChanges, OnDestroy {
  /** Where the heatmap's data comes from. */
  @Input() access: SpatialGeneHeatmapAccess | null = null;
  /** The categorical column the cells are grouped by. */
  @Input() column: string | null = null;
  /**
   * What the data is of: changes when the same access and column name now mean other data —
   * another dataset with a column of that name, or a grouping imported again under its name.
   * Any value; a new one reloads the heatmap like a new column.
   */
  @Input() source: unknown = null;
  /** Display colour of each group, by name, as the map draws it. */
  @Input() colors: Record<string, string> = {};
  /** Observation ids (barcodes, cell ids), by observation index, for labels and the tooltip. */
  @Input() ids: readonly string[] | null = null;
  /** A gene was clicked. */
  @Output() readonly geneClick = new EventEmitter<string>();

  @ViewChild('frame') private frameRef?: ElementRef<HTMLDivElement>;
  @ViewChild('canvas') private canvasRef?: ElementRef<HTMLCanvasElement>;

  protected readonly viewOptions = [
    { label: 'Cells', value: 'cells' as GeneHeatmapView },
    { label: 'Groups', value: 'groups' as GeneHeatmapView },
  ];
  protected readonly cellScaleOptions = [
    { label: 'Expression', value: 'expression' as SpatialGeneHeatmapScale },
    { label: 'Per gene (0–1)', value: 'gene' as SpatialGeneHeatmapScale },
  ];
  protected readonly groupScaleOptions = [
    { label: 'z-score per gene', value: 'z' as GroupScale },
    { label: 'Mean expression', value: 'expression' as GroupScale },
    { label: 'Per gene (0–1)', value: 'gene' as GroupScale },
  ];

  protected view: GeneHeatmapView = 'cells';
  protected cellScale: SpatialGeneHeatmapScale = 'expression';
  protected groupScale: GroupScale = 'z';
  /** Leave out the genes never detected (they come last). */
  protected hideUndetected = true;
  protected search = '';
  protected searchNote: string | null = null;

  protected info: SpatialGeneHeatmap | null = null;
  protected loading: string | null = null;
  protected error: string | null = null;
  protected hover: { x: number; y: number; lines: HoverLine[] } | null = null;
  /** The value range and colours the legend shows. */
  protected legend: { lo: number; hi: number; gradient: string; label: string } | null = null;
  /** What one column and one row of the drawn level stand for. */
  protected status = '';

  private means: SpatialGeneHeatmapMeans | null = null;
  private scaled: { scale: GroupScale; values: Float32Array } | null = null;
  private order: Uint32Array | null = null;
  private store: HeatmapTileStore | null = null;
  /** Painted tiles, by tile and paint settings. */
  private painted = new Map<string, HTMLCanvasElement>();
  private window: HeatmapWindow = { x0: 0, x1: 1, y0: 0, y1: 1 };
  /** The level drawn last, for the hover's value and the status. */
  private level = { cx: 0, gy: 0 };
  private highlightRow: number | null = null;

  private readonly load = new Supersede();
  private readonly meansLoad = new Supersede();
  private resize: ResizeObserver | null = null;
  private frame = 0;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private size = { w: 0, h: 0, dpr: 1 };
  private textColor = '#ccc';
  private viewReady = false;
  /** The legend and status last handed to the template. */
  private shown = '';

  constructor(
    private readonly host: ElementRef<HTMLElement>,
    private readonly cdr: ChangeDetectorRef,
    private readonly zone: NgZone,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['access'] || changes['column'] || changes['source']) void this.reload();
    else if (changes['colors'] || changes['ids']) this.requestDraw();
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    const frame = this.frameRef?.nativeElement;
    if (frame && typeof ResizeObserver !== 'undefined') {
      this.resize = new ResizeObserver(() => this.measure());
      this.resize.observe(frame);
    }
    this.zone.runOutsideAngular(() => {
      // Not a template binding: a wheel listener must be non-passive to keep the page still.
      this.canvasRef?.nativeElement.addEventListener('wheel', this.onWheel, { passive: false });
    });
    this.measure();
  }

  ngOnDestroy(): void {
    this.load.cancel();
    this.meansLoad.cancel();
    this.store?.dispose();
    this.resize?.disconnect();
    this.canvasRef?.nativeElement.removeEventListener('wheel', this.onWheel);
    if (this.frame) cancelAnimationFrame(this.frame);
  }

  // ── loading ───────────────────────────────────────────────────────────

  private async reload(): Promise<void> {
    const task = this.load.next();
    this.meansLoad.cancel();
    this.store?.dispose();
    this.store = null;
    this.painted.clear();
    this.info = this.means = this.order = null;
    this.scaled = null;
    this.hover = null;
    this.error = null;
    this.highlightRow = null;
    const { access, column } = this;
    if (!access || !column) {
      this.loading = null;
      this.cdr.markForCheck();
      this.requestDraw();
      return;
    }
    this.loading =
      'Reading every gene of the dataset. The first time for a grouping takes one pass over the expression matrix.';
    this.cdr.markForCheck();
    try {
      const info = await access.info(column);
      if (!task()) return;
      this.info = info;
      this.loading = null;
      this.window = fitWindow(this.extent());
      this.startView();
    } catch (err) {
      if (!task()) return;
      this.loading = null;
      this.error = `The gene heatmap could not be loaded: ${(err as Error)?.message ?? err}`;
    }
    this.cdr.markForCheck();
    this.requestDraw();
  }

  /** What the current view needs beyond the layout: the tiles, or the means. */
  private startView(): void {
    const { info, access, column } = this;
    if (!info || !access || !column) return;
    if (this.view === 'cells') {
      if (!this.store) {
        const scale = this.cellScale;
        this.store = new HeatmapTileStore(
          async (t) => {
            const values = await access.tile(column, t.cx, t.gy, t.tx, t.ty, scale);
            const size = info.tileSize;
            const levelRows = Math.ceil(info.genes.length / 2 ** t.gy);
            const levelCols = Math.ceil(info.cells / 2 ** t.cx);
            const rows = Math.min(size, levelRows - t.ty * size);
            const cols = Math.min(size, levelCols - t.tx * size);
            // A port need not check the size, and a short tile would paint shifted rows.
            if (values.length !== rows * cols) {
              throw new Error(`a tile of ${values.length} values where ${rows} × ${cols} were expected`);
            }
            return { rows, cols, values };
          },
          () => this.requestDraw(),
          (err) => {
            this.error = `Some of the heatmap could not be loaded: ${(err as Error)?.message ?? err}`;
            this.cdr.markForCheck();
          },
        );
      }
      if (!this.order) {
        access
          .order(column)
          .then((order) => {
            if (this.info === info) {
              this.order = order;
              this.requestDraw();
            }
          })
          .catch(() => undefined);
      }
    } else if (!this.means) {
      const task = this.meansLoad.next();
      this.loading = 'Loading the means per group…';
      access
        .means(column)
        .then((means) => {
          if (!task() || this.info !== info) return;
          this.means = means;
          this.scaled = null;
          this.loading = null;
          this.cdr.markForCheck();
          this.requestDraw();
        })
        .catch((err) => {
          if (!task()) return;
          this.loading = null;
          this.error = `The means per group could not be loaded: ${(err as Error)?.message ?? err}`;
          this.cdr.markForCheck();
        });
    }
  }

  // ── controls ──────────────────────────────────────────────────────────

  protected onView(view: GeneHeatmapView): void {
    if (view === this.view) return;
    this.view = view;
    this.hover = null;
    this.window = this.info ? this.carryWindow() : this.window;
    this.startView();
    this.requestDraw();
  }

  /** Keep the genes on screen when switching views; the columns start whole. */
  private carryWindow(): HeatmapWindow {
    const fit = fitWindow(this.extent());
    return { ...fit, y0: this.window.y0, y1: this.window.y1 };
  }

  protected onCellScale(scale: SpatialGeneHeatmapScale): void {
    if (scale === this.cellScale) return;
    this.cellScale = scale;
    this.store?.dispose();
    this.store = null;
    this.painted.clear();
    this.startView();
    this.requestDraw();
  }

  protected onGroupScale(scale: GroupScale): void {
    this.groupScale = scale;
    this.requestDraw();
  }

  protected onHideUndetected(on: boolean): void {
    this.hideUndetected = on;
    this.window = clampWindow(this.carryWindow(), this.extent());
    this.requestDraw();
  }

  protected resetZoom(): void {
    this.window = fitWindow(this.extent());
    this.highlightRow = null;
    this.requestDraw();
  }

  /** Find a gene by name (exact, then prefix, then substring) and bring its row into view. */
  protected findGene(): void {
    const info = this.info;
    const q = this.search.trim().toLowerCase();
    if (!info || !q) return;
    const genes = info.genes;
    let row = genes.findIndex((g) => g.toLowerCase() === q);
    if (row < 0) row = genes.findIndex((g) => g.toLowerCase().startsWith(q));
    if (row < 0) row = genes.findIndex((g) => g.toLowerCase().includes(q));
    if (row < 0) {
      this.searchNote = `No gene matches "${this.search.trim()}".`;
      return;
    }
    this.searchNote = null;
    if (row >= this.rows()) {
      this.hideUndetected = false;
      this.searchNote = `${genes[row]} is never detected; showing the undetected genes too.`;
    }
    this.highlightRow = row;
    this.window = revealRow(this.window, this.extent(), row);
    this.requestDraw();
  }

  // ── pointer ───────────────────────────────────────────────────────────

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.info) return;
    const at = this.toData(e.offsetX, e.offsetY, true);
    if (!at) return;
    e.preventDefault();
    const factor = Math.pow(WHEEL_ZOOM, Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 100 || 1));
    const axes: ZoomAxes = this.view === 'groups' || e.shiftKey ? 'y' : e.altKey ? 'x' : 'both';
    this.window = zoomWindow(this.window, this.extent(), factor, at, axes);
    this.zone.run(() => {
      this.hover = null;
      this.cdr.markForCheck();
    });
    this.requestDraw();
  };

  protected onPointerDown(e: PointerEvent): void {
    this.drag = { x: e.offsetX, y: e.offsetY, moved: false };
    (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
  }

  protected onPointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (drag) {
      const dxPx = e.offsetX - drag.x;
      const dyPx = e.offsetY - drag.y;
      if (!drag.moved && Math.abs(dxPx) + Math.abs(dyPx) < 3) return;
      drag.moved = true;
      drag.x = e.offsetX;
      drag.y = e.offsetY;
      const plot = this.plot();
      const w = this.window;
      const dx = this.view === 'groups' ? 0 : (-dxPx / plot.w) * (w.x1 - w.x0);
      const dy = (-dyPx / plot.h) * (w.y1 - w.y0);
      this.window = panWindow(w, this.extent(), dx, dy);
      this.hover = null;
      this.requestDraw();
      return;
    }
    this.hover = this.hoverAt(e.offsetX, e.offsetY);
  }

  protected onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    if (drag && !drag.moved) {
      const row = this.rowAt(e.offsetX, e.offsetY);
      if (row !== null && this.info) {
        this.highlightRow = row;
        this.geneClick.emit(this.info.genes[row]);
        this.requestDraw();
      }
    }
  }

  /** Moves the tooltip off the pointer, towards the middle of the frame. */
  protected get hoverTransform(): string {
    const h = this.hover;
    if (!h) return '';
    const x = h.x > this.size.w / 2 ? 'calc(-100% - 14px)' : '14px';
    const y = h.y > this.size.h / 2 ? 'calc(-100% - 14px)' : '14px';
    return `translate(${x}, ${y})`;
  }

  protected onPointerLeave(): void {
    this.hover = null;
  }

  /** The gene under a point of the plot or of the names beside it. */
  private rowAt(px: number, py: number): number | null {
    const plot = this.plot();
    if (py < plot.y || py > plot.y + plot.h || px > plot.x + plot.w) return null;
    const w = this.window;
    const row = Math.floor(w.y0 + ((py - plot.y) / plot.h) * (w.y1 - w.y0));
    return row >= 0 && row < this.rows() ? row : null;
  }

  /** Canvas pixels to data units; null outside the plot unless `loose`. */
  private toData(px: number, py: number, loose = false): { x: number; y: number } | null {
    const plot = this.plot();
    const inside = px >= plot.x && px <= plot.x + plot.w && py >= plot.y && py <= plot.y + plot.h;
    if (!inside && !loose) return null;
    const w = this.window;
    const x = w.x0 + ((Math.max(plot.x, Math.min(plot.x + plot.w, px)) - plot.x) / plot.w) * (w.x1 - w.x0);
    const y = w.y0 + ((Math.max(plot.y, Math.min(plot.y + plot.h, py)) - plot.y) / plot.h) * (w.y1 - w.y0);
    return { x, y };
  }

  private hoverAt(px: number, py: number): { x: number; y: number; lines: HoverLine[] } | null {
    const info = this.info;
    const at = this.toData(px, py);
    if (!info || !at) return null;
    const row = Math.floor(at.y);
    const col = Math.floor(at.x);
    if (row < 0 || row >= this.rows()) return null;
    const lines: HoverLine[] = [{ label: 'Gene', value: info.genes[row] }];
    if (this.view === 'groups') {
      const k = col;
      const group = info.groups[k];
      if (!group || !this.means) return null;
      const K = info.groups.length;
      const i = row * K + k;
      lines.push({ label: info.column, value: `${group.name} (${group.cells.toLocaleString()} cells)` });
      lines.push({ label: 'Mean', value: fmt(this.means.means[i]) });
      lines.push({ label: 'Expressing', value: `${(this.means.fractions[i] * 100).toFixed(1)}%` });
      if (this.groupScale !== 'expression' && this.scaled) {
        lines.push({
          label: this.groupScale === 'z' ? 'z-score' : 'Of its max',
          value: fmt(this.scaled.values[i]),
        });
      }
    } else {
      if (col < 0 || col >= info.cells) return null;
      const { cx, gy } = this.level;
      const span = 2 ** cx;
      if (span === 1) {
        const obs = this.order?.[col];
        lines.push({
          label: 'Cell',
          value: obs === undefined ? `column ${col + 1}` : (this.ids?.[obs] ?? `#${obs}`),
        });
      } else {
        const first = Math.floor(col / span) * span;
        lines.push({
          label: 'Cells',
          value: `${(first + 1).toLocaleString()}–${Math.min(info.cells, first + span).toLocaleString()} (mean)`,
        });
      }
      const k = groupAt(
        info.groups.map((g) => g.start),
        col,
      );
      if (k >= 0) lines.push({ label: info.column, value: info.groups[k].name });
      const v = this.valueAt(col, row);
      if (v !== null) {
        const genes = 2 ** gy;
        lines.push({
          label: this.cellScale === 'gene' ? 'Of its max' : 'Expression',
          value: fmt(v) + (genes > 1 ? ` (mean of ${genes} genes)` : ''),
        });
      }
    }
    return { x: px, y: py, lines };
  }

  /** The drawn level's value at a column and gene, when its tile is loaded. */
  private valueAt(col: number, row: number): number | null {
    const info = this.info;
    if (!info || !this.store) return null;
    const { cx, gy } = this.level;
    const lc = col >> cx;
    const lr = row >> gy;
    const T = info.tileSize;
    const tile = this.store.get({ cx, gy, tx: Math.floor(lc / T), ty: Math.floor(lr / T) });
    if (!tile) return null;
    const v = tile.values[(lr - tile.ty * T) * tile.cols + (lc - tile.tx * T)];
    return Number.isFinite(v) ? v : null;
  }

  // ── geometry ──────────────────────────────────────────────────────────

  /** Rows shown: every gene, or the detected ones. */
  private rows(): number {
    const info = this.info;
    if (!info) return 1;
    return this.hideUndetected && info.expressedGenes > 0 ? info.expressedGenes : info.genes.length;
  }

  private extent(): HeatmapExtent {
    const info = this.info;
    const cols = !info ? 1 : this.view === 'groups' ? info.groups.length : info.cells;
    const rows = this.rows();
    return { cols, rows, minCols: Math.min(cols, 4), minRows: Math.min(rows, 2) };
  }

  private plot(): { x: number; y: number; w: number; h: number } {
    return {
      x: GUTTER,
      y: TOP,
      w: Math.max(1, this.size.w - GUTTER - 4),
      h: Math.max(1, this.size.h - TOP - 4),
    };
  }

  private measure(): void {
    const frame = this.frameRef?.nativeElement;
    const canvas = this.canvasRef?.nativeElement;
    if (!frame || !canvas) return;
    const w = Math.max(1, Math.floor(frame.clientWidth));
    const h = Math.max(1, Math.floor(frame.clientHeight));
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.size = { w, h, dpr };
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    this.textColor = getComputedStyle(this.host.nativeElement).color || this.textColor;
    this.requestDraw();
  }

  // ── drawing ───────────────────────────────────────────────────────────

  private requestDraw(): void {
    if (!this.viewReady || this.frame) return;
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (f: FrameRequestCallback) => setTimeout(f, 16);
    this.frame = raf(() => {
      this.frame = 0;
      this.draw();
    }) as unknown as number;
  }

  /** Draw now. Public to the tests, which have no animation frames to wait for. */
  draw(): void {
    const canvas = this.canvasRef?.nativeElement;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { w, h, dpr } = this.size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const info = this.info;
    if (!info) return;
    const plot = this.plot();
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();
    if (this.view === 'cells') this.drawCells(ctx, info, plot);
    else this.drawGroups(ctx, info, plot);
    this.drawHighlight(ctx, plot);
    ctx.restore();
    this.drawGroupBar(ctx, info, plot);
    this.drawRowLabels(ctx, info, plot);
    this.drawColumnLabels(ctx, info, plot);
    // The legend and status are template bindings; a draw scheduled from the wheel runs
    // outside Angular, so a change is brought back in — only when there is one.
    const shown = `${this.status}|${this.legend?.lo}|${this.legend?.hi}|${this.legend?.label}`;
    if (shown !== this.shown) {
      this.shown = shown;
      this.zone.run(() => this.cdr.markForCheck());
    }
  }

  private drawCells(ctx: CanvasRenderingContext2D, info: SpatialGeneHeatmap, plot: Plot): void {
    const store = this.store;
    if (!store) return;
    const w = this.window;
    const finest = Math.min(info.finestLevel, maxLevel(info.cells));
    const cx = levelFor(w.x1 - w.x0, plot.w, finest, maxLevel(info.cells));
    const gy = levelFor(w.y1 - w.y0, plot.h, 0, maxLevel(info.genes.length));
    this.level = { cx, gy };
    const T = info.tileSize;
    const G = info.genes.length;
    store.want(tilesFor(w, cx, gy, T, info.cells, G));
    // Coarser tiles already loaded stand in while the finer ones arrive, coarsest first so the
    // finest drawn ends on top.
    const drawn: HeatmapTile[] = [];
    for (const t of store.loaded()) {
      if (t.cx < cx || t.gy < gy) continue;
      const r = tileRect(t, T, info.cells, G);
      if (r.x1 <= w.x0 || r.x0 >= w.x1 || r.y1 <= w.y0 || r.y0 >= w.y1) continue;
      drawn.push(t);
    }
    drawn.sort((a, b) => b.cx + b.gy - (a.cx + a.gy));
    ctx.imageSmoothingEnabled = false;
    const [lo, hi] = rangeOf(
      new Float32Array(0),
      this.cellScale === 'gene' ? 'cells-gene' : 'cells-expression',
      info.max,
    );
    for (const t of drawn) {
      const image = this.paintTile(t, lo, hi);
      if (!image) continue;
      const cw = 2 ** t.cx;
      const rh = 2 ** t.gy;
      const x0 = t.tx * T * cw;
      const y0 = t.ty * T * rh;
      const sx = plot.x + ((x0 - w.x0) / (w.x1 - w.x0)) * plot.w;
      const sy = plot.y + ((y0 - w.y0) / (w.y1 - w.y0)) * plot.h;
      const sw = ((t.cols * cw) / (w.x1 - w.x0)) * plot.w;
      const shh = ((t.rows * rh) / (w.y1 - w.y0)) * plot.h;
      ctx.drawImage(image, sx, sy, sw, shh);
    }
    this.legend = legendFor(
      lo,
      hi,
      CELLS_LUT,
      this.cellScale === 'gene' ? 'of each gene’s max' : (info.unit ?? 'expression'),
    );
    const cells = 2 ** cx;
    const genes = 2 ** gy;
    const parts = [
      `${info.cells.toLocaleString()} cells × ${this.rows().toLocaleString()} genes`,
      cells === 1 ? 'a column per cell' : `each column the mean of ${cells.toLocaleString()} cells`,
      genes === 1 ? 'a row per gene' : `each row the mean of ${genes.toLocaleString()} genes`,
    ];
    if (finest > 0 && cx === finest)
      parts.push(`closest zoom: ${(2 ** finest).toLocaleString()} cells per column`);
    if (store.pending) parts.push('loading…');
    this.status = parts.join(' · ');
  }

  private paintTile(t: HeatmapTile, lo: number, hi: number): HTMLCanvasElement | null {
    const key = `${tileKey(t)}|${lo}|${hi}`;
    let canvas = this.painted.get(key);
    if (canvas) return canvas;
    if (typeof document === 'undefined') return null;
    canvas = document.createElement('canvas');
    canvas.width = t.cols;
    canvas.height = t.rows;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const pixels = paintValues(t.values, lo, hi, CELLS_LUT);
    ctx.putImageData(new ImageData(pixels, t.cols, t.rows), 0, 0);
    this.painted.set(key, canvas);
    // Painted tiles follow the store's: a few hundred at most.
    if (this.painted.size > 512) this.painted.delete(this.painted.keys().next().value!);
    return canvas;
  }

  private drawGroups(ctx: CanvasRenderingContext2D, info: SpatialGeneHeatmap, plot: Plot): void {
    const means = this.means;
    if (!means) return;
    const K = info.groups.length;
    const G = info.genes.length;
    if (!this.scaled || this.scaled.scale !== this.groupScale) {
      this.scaled = { scale: this.groupScale, values: scaleMeans(means.means, G, K, this.groupScale) };
    }
    const values = this.scaled.values;
    const rows = this.rows();
    const w = this.window;
    const gy = levelFor(w.y1 - w.y0, plot.h, 0, maxLevel(rows));
    this.level = { cx: 0, gy };
    const block = blockRows(values, rows, K, gy, w.y0, w.y1);
    if (!block.blocks || typeof document === 'undefined') return;
    const [lo, hi] = rangeOf(values.subarray(0, rows * K), this.groupScale);
    const lut = this.groupScale === 'z' ? DIVERGING_LUT : CELLS_LUT;
    const image = document.createElement('canvas');
    image.width = K;
    image.height = block.blocks;
    const ictx = image.getContext('2d');
    if (!ictx) return;
    ictx.putImageData(new ImageData(paintValues(block.values, lo, hi, lut), K, block.blocks), 0, 0);
    ctx.imageSmoothingEnabled = false;
    const size = 2 ** gy;
    const sy = plot.y + ((block.firstRow - w.y0) / (w.y1 - w.y0)) * plot.h;
    const sh = ((block.blocks * size) / (w.y1 - w.y0)) * plot.h;
    const sx = plot.x + ((0 - w.x0) / (w.x1 - w.x0)) * plot.w;
    const sw = (K / (w.x1 - w.x0)) * plot.w;
    ctx.drawImage(image, sx, sy, sw, sh);
    const label = this.groupScale === 'z' ? 'z-score' : this.groupScale === 'gene' ? 'of each gene’s max' : 'mean';
    this.legend = legendFor(lo, hi, lut, label);
    this.status = [
      `${rows.toLocaleString()} genes × ${K} groups`,
      size === 1 ? 'a row per gene' : `each row the mean of ${size.toLocaleString()} genes`,
    ].join(' · ');
  }

  private drawHighlight(ctx: CanvasRenderingContext2D, plot: Plot): void {
    const row = this.highlightRow;
    if (row === null) return;
    const w = this.window;
    const y0 = plot.y + ((row - w.y0) / (w.y1 - w.y0)) * plot.h;
    const y1 = plot.y + ((row + 1 - w.y0) / (w.y1 - w.y0)) * plot.h;
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(plot.x + 0.5, y0, plot.w - 1, Math.max(1, y1 - y0));
  }

  private drawGroupBar(ctx: CanvasRenderingContext2D, info: SpatialGeneHeatmap, plot: Plot): void {
    const w = this.window;
    const y = plot.y - BAR - 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, y, plot.w, BAR);
    ctx.clip();
    info.groups.forEach((g, k) => {
      const [a, b] = this.view === 'groups' ? [k, k + 1] : [g.start, g.start + g.cells];
      const sx0 = plot.x + ((a - w.x0) / (w.x1 - w.x0)) * plot.w;
      const sx1 = plot.x + ((b - w.x0) / (w.x1 - w.x0)) * plot.w;
      if (sx1 < plot.x || sx0 > plot.x + plot.w) return;
      ctx.fillStyle = this.colors[g.name] ?? '#888';
      ctx.fillRect(sx0, y, Math.max(1, sx1 - sx0), BAR);
    });
    ctx.restore();
  }

  private drawRowLabels(ctx: CanvasRenderingContext2D, info: SpatialGeneHeatmap, plot: Plot): void {
    const w = this.window;
    const rowPx = plot.h / (w.y1 - w.y0);
    ctx.fillStyle = this.textColor;
    if (rowPx < LABEL_PX) {
      ctx.save();
      ctx.font = '12px sans-serif';
      ctx.translate(GUTTER / 2, plot.y + plot.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`Genes (${this.rows().toLocaleString()})`, 0, 0);
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, plot.y, GUTTER, plot.h);
    ctx.clip();
    ctx.font = `${Math.min(13, Math.max(9, Math.floor(rowPx * 0.8)))}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const r0 = Math.max(0, Math.floor(w.y0));
    const r1 = Math.min(this.rows(), Math.ceil(w.y1));
    for (let r = r0; r < r1; r++) {
      const y = plot.y + ((r + 0.5 - w.y0) / (w.y1 - w.y0)) * plot.h;
      ctx.fillText(clip(ctx, info.genes[r], GUTTER - 8), GUTTER - 4, y);
    }
    ctx.restore();
  }

  private drawColumnLabels(ctx: CanvasRenderingContext2D, info: SpatialGeneHeatmap, plot: Plot): void {
    const w = this.window;
    const colPx = plot.w / (w.x1 - w.x0);
    const top = plot.y - BAR - 4;
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x - 2, 0, plot.w + 4, top + 1);
    ctx.clip();
    ctx.fillStyle = this.textColor;
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'middle';
    const rotated = (label: string, x: number) => {
      ctx.save();
      ctx.translate(x, top);
      ctx.rotate(-Math.PI / 3);
      ctx.textAlign = 'left';
      ctx.fillText(clip(ctx, label, TOP - 4), 2, 0);
      ctx.restore();
    };
    if (this.view === 'groups') {
      info.groups.forEach((g, k) => {
        const x = plot.x + ((k + 0.5 - w.x0) / (w.x1 - w.x0)) * plot.w;
        if (colPx >= 60) {
          ctx.textAlign = 'center';
          ctx.fillText(clip(ctx, g.name, colPx - 4), x, top - 6);
        } else rotated(g.name, x);
      });
    } else if (colPx >= LABEL_PX && this.order) {
      const c0 = Math.max(0, Math.floor(w.x0));
      const c1 = Math.min(info.cells, Math.ceil(w.x1));
      for (let c = c0; c < c1; c++) {
        const obs = this.order[c];
        const x = plot.x + ((c + 0.5 - w.x0) / (w.x1 - w.x0)) * plot.w;
        rotated(this.ids?.[obs] ?? `#${obs}`, x);
      }
    } else {
      // Zoomed out: each group's name over its span, where it fits.
      ctx.textAlign = 'center';
      for (const g of info.groups) {
        const a = Math.max(w.x0, g.start);
        const b = Math.min(w.x1, g.start + g.cells);
        if (b <= a) continue;
        const sx0 = plot.x + ((a - w.x0) / (w.x1 - w.x0)) * plot.w;
        const sx1 = plot.x + ((b - w.x0) / (w.x1 - w.x0)) * plot.w;
        if (sx1 - sx0 < ctx.measureText(g.name).width + 6) continue;
        ctx.fillText(g.name, (sx0 + sx1) / 2, top - 6);
      }
    }
    ctx.restore();
  }
}

type Plot = { x: number; y: number; w: number; h: number };

/** A label cut with an ellipsis to fit `max` pixels. */
function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/** The legend's CSS gradient, sampled from the table, and its range. */
function legendFor(lo: number, hi: number, rgba: Uint8Array, label: string) {
  const stops: string[] = [];
  for (let i = 0; i <= 8; i++) {
    const k = Math.round((i / 8) * 255) * 4;
    stops.push(`${rgbToHex([rgba[k], rgba[k + 1], rgba[k + 2]])} ${(i / 8) * 100}%`);
  }
  return { lo, hi, gradient: `linear-gradient(to right, ${stops.join(', ')})`, label };
}
