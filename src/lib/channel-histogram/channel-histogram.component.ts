import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  EventEmitter,
  Inject,
  Input,
  OnDestroy,
  OnInit,
  Output,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { SharedModule, TreeNode } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { SliderModule } from 'primeng/slider';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { TreeSelectModule } from 'primeng/treeselect';
import * as Plotly from 'plotly.js-dist-min';

import {
  CHANNEL_HISTOGRAM_API,
  IChannelHistogramApi,
  IChannelState,
  IHistogram,
  LUT_COLORS,
} from '../contracts/channel-histogram-api.contract';
import { autoWindowFromHistogram } from '../contracts/intensity';
import { HexColorPickerComponent } from '../hex-color-picker/hex-color-picker.component';

/** Delay between retries while the histogram sampling resolves. */
const HIST_RETRY_MS = 400;
/** Retries before giving up and showing an empty histogram. */
const HIST_MAX_RETRIES = 10;

let nextInstanceId = 0;

/** The native value range the 8-bit display window maps onto — the observed
 *  pixel extremes for a native (>8-bit) histogram, else plain 0..255 (so 8-bit
 *  images pass through unchanged). The 8-bit tile is server-stretched across this
 *  range, so it's the best client-side native↔display mapping. */
function nativeRange(h: IHistogram | null): { min: number; max: number } {
  if (h && (h.bitDepth ?? 8) > 8 && (h.observedMax ?? 0) > (h.observedMin ?? 0)) {
    return { min: h.observedMin as number, max: h.observedMax as number };
  }
  return { min: 0, max: 255 };
}

/**
 * Channels & Histogram pane: a non-modal, resizable, draggable dialog for
 * brightness/contrast (per-channel display window), gamma, channel
 * visibility/colour, the intensity histogram, and the colormap/reverse/invert
 * controls (moved here from the toolbar). Every edit flows through
 * {@link CHANNEL_HISTOGRAM_API} into the shared store, and both rendering
 * backends recolor the displayed image live. The pane depends only on the
 * contract, never the concrete visualizer.
 *
 * OnPush: the API's channel / colormap / invert / image streams, the async
 * histogram and the slider-activity timer mark it for check.
 */
@Component({
  selector: 'channel-histogram',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SharedModule,
    ButtonModule,
    CheckboxModule,
    DialogModule,
    InputNumberModule,
    SliderModule,
    TableModule,
    TooltipModule,
    TreeSelectModule,
    HexColorPickerComponent,
  ],
  templateUrl: './channel-histogram.component.html',
  styleUrls: ['./channel-histogram.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelHistogramComponent implements OnInit, OnDestroy {
  /** Dialog visibility, two-way bound so the host (toolbar button) can open it. */
  @Input() visible = false;
  /** The dialog was opened or closed; two-way with {@link visible}. */
  @Output() visibleChange = new EventEmitter<boolean>();

  /** DOM id of the Plotly histogram element — per instance, so two panes don't collide. */
  protected readonly histogramDiv = `channel-histogram-plot-${++nextInstanceId}`;
  protected readonly lutColors = LUT_COLORS;

  protected channels: IChannelState[] = [];
  protected selected: IChannelState | null = null;
  protected invert = false;
  protected logScale = false;
  /** Bounded retries while the (async) histogram sampling resolves. */
  private histRetries = 0;
  private histRetryTimer?: ReturnType<typeof setTimeout>;
  /** The selected channel's current histogram. Native bit depth (with
   *  observed/range fields) for >8-bit images, else the 8-bit client histogram.
   *  Drives the plot, the native window labels, and the export-button gate. */
  protected get hist(): IHistogram | null {
    return this._hist;
  }
  protected set hist(h: IHistogram | null) {
    this._hist = h;
    this.range = nativeRange(h);
  }
  private _hist: IHistogram | null = null;
  /** {@link nativeRange} of {@link hist}, kept with it so the template's window
   *  getters read it instead of re-deriving (and allocating) it per check. */
  private range = nativeRange(null);
  private histSub?: Subscription;
  /** Which window control is being adjusted right now — drives a small
   *  non-blocking activity spinner next to that slider, since the image recolor
   *  isn't instant on large stacks. Cleared a short moment after movement stops
   *  (the recolor isn't directly observable, so this is a trailing heuristic). */
  protected activeAdjust: 'min' | 'max' | 'gamma' | null = null;
  private adjustTimer?: ReturnType<typeof setTimeout>;

  protected colormapOptions: any;
  protected selectedColormap: any;

  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);
  /** Keeps the Plotly histogram sized to the (resizable) dialog body. */
  private resizeObserver?: ResizeObserver;

  constructor(@Inject(CHANNEL_HISTOGRAM_API) private api: IChannelHistogramApi) {}

  /** Per-channel pseudo-colour only applies when there's more than one channel
   *  (RGB / fluorescence). A single grayscale channel uses the colormap instead. */
  protected get multichannel(): boolean {
    return this.channels.length > 1;
  }

  ngOnInit(): void {
    this.colormapOptions = this.api.getColormapOptions();
    this.api
      .getColormap()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((cm) => {
        this.selectedColormap = cm;
        this.cdr.markForCheck();
      });
    this.api
      .getInvert$()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((i) => {
        this.invert = !!i;
        this.cdr.markForCheck();
      });
    this.api
      .getChannels$()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((channels) => {
        this.channels = channels ?? [];
        // Keep the selected row (by index) or default to the first channel.
        const keepIdx = this.selected?.index ?? 0;
        this.selected = this.channels.find((c) => c.index === keepIdx) ?? this.channels[0] ?? null;
        if (this.visible) this.updateMarkers();
        this.cdr.markForCheck();
      });
    // The histogram is of the source pixels — it changes with the image/slice,
    // not with window edits — so reload it when the image metadata changes.
    this.api
      .getImageMeta()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.visible) this.loadHistogram();
      });
  }

  /** Stops the pending histogram load / retry and activity timer, the resize
   *  observer and the Plotly plot; the API streams end through `takeUntilDestroyed`. */
  ngOnDestroy(): void {
    this.histSub?.unsubscribe();
    clearTimeout(this.histRetryTimer);
    clearTimeout(this.adjustTimer);
    this.teardownResize();
    try {
      Plotly.purge(this.histogramDiv);
    } catch {
      /* never rendered */
    }
  }

  protected onVisibleChange(v: boolean): void {
    this.visible = v;
    this.visibleChange.emit(v);
    if (!v) this.teardownResize();
  }

  /** p-dialog (onShow): the plot div now exists, so draw the histogram and keep
   *  it sized to the dialog (which is resizable) via a ResizeObserver. */
  protected onShow(): void {
    this.histRetries = 0;
    requestAnimationFrame(() => {
      this.loadHistogram();
      const el = document.getElementById(this.histogramDiv);
      if (el && !this.resizeObserver && typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => {
          try {
            (Plotly as any).Plots.resize(el);
          } catch {
            /* not rendered */
          }
        });
        this.resizeObserver.observe(el);
      }
    });
  }

  private teardownResize(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
  }

  protected selectChannel(ch: IChannelState): void {
    this.selected = ch;
    this.api.setSelectedChannel(ch.index); // a single-scalar 3D Surface follows the selected band
    this.histRetries = 0;
    this.loadHistogram();
  }

  // ── per-channel edits (live) ─────────────────────────────────────────
  // PrimeNG slider/inputNumber events carry `number | string | null`, so the
  // handlers coerce. Values arrive in NATIVE units (the slider
  // is labelled natively for 16-bit); we map them back to the store's 8-bit
  // display window via the channel's observed range (identity for 8-bit images,
  // so their behaviour is unchanged).
  protected onMinChange(value: number | string | null | undefined): void {
    if (!this.selected) return;
    const min = this.toDisp(value);
    const max = Math.max(min, this.selected.max);
    this.api.setChannelState(this.selected.index, { min, max });
    this.markBusy('min');
    this.updateMarkers();
  }
  protected onMaxChange(value: number | string | null | undefined): void {
    if (!this.selected) return;
    const max = this.toDisp(value);
    const min = Math.min(max, this.selected.min);
    this.api.setChannelState(this.selected.index, { min, max });
    this.markBusy('max');
    this.updateMarkers();
  }
  protected onGammaChange(value: number | string | null | undefined): void {
    if (!this.selected) return;
    const g = Number(value);
    if (isNaN(g)) return;
    this.api.setChannelState(this.selected.index, { gamma: g });
    this.markBusy('gamma');
  }

  /** Flag a control as actively adjusting so its spinner shows; auto-clears a
   *  short moment after the last change (kept alive while the user keeps
   *  dragging, since each change resets the timer). */
  private markBusy(which: 'min' | 'max' | 'gamma'): void {
    this.activeAdjust = which;
    clearTimeout(this.adjustTimer);
    this.adjustTimer = setTimeout(() => {
      this.activeAdjust = null;
      this.cdr.markForCheck();
    }, 500);
  }
  protected onVisibleToggle(ch: IChannelState, value: boolean): void {
    this.api.setChannelState(ch.index, { visible: value });
  }
  protected onColorChange(ch: IChannelState, color: string): void {
    this.api.setChannelState(ch.index, { color });
    // The histogram bars are drawn in the selected channel's colour — redraw
    // when that channel's colour changes.
    // Copy rather than mutate: `selected` is the object the store emitted.
    if (this.selected && ch.index === this.selected.index) {
      this.selected = { ...this.selected, color };
      this.renderHistogram();
    }
  }

  // ── display options ──────────────────────────────────────────────────
  protected onColormap(node: TreeNode): void {
    if (node && !node.children) this.api.setColormap(node);
  }
  protected onInvert(value: boolean): void {
    this.invert = value;
    this.api.setInvert(value);
  }
  protected toggleLog(value: boolean): void {
    this.logScale = value;
    this.renderHistogram();
  }

  /** Quick-assign a preset LUT colour to a channel (Fiji palette). */
  protected setPreset(ch: IChannelState, color: string): void {
    this.onColorChange(ch, color);
  }

  /** Export the displayed composite as a publication-ready PNG (8-bit figure). */
  protected exportComposite(): void {
    this.api.exportComposite();
  }

  /** Export the underlying data as a true-16-bit multi-band TIFF (server-side). */
  protected exportData(): void {
    this.api.exportData();
  }

  // ── native bit-depth helpers ─────────────────────────────────────────
  /** True when the current channel histogram is native >8-bit (16-bit etc.):
   *  gates the native slider labelling and the 16-bit TIFF export button. */
  protected get is16bit(): boolean {
    return (this.hist?.bitDepth ?? 8) > 8;
  }
  /** {@link nativeRange} of the current histogram. */
  private obsRange(): { min: number; max: number } {
    return this.range;
  }
  /** 8-bit display value (0..255) → native units. */
  private toNative(disp: number): number {
    const o = this.obsRange();
    return Math.round(o.min + (disp / 255) * (o.max - o.min));
  }
  /** Native units → clamped 8-bit display value (0..255). */
  private toDisp(value: number | string | null | undefined): number {
    const v = Number(value);
    if (v == null || isNaN(v)) return 0;
    const o = this.obsRange();
    const span = o.max - o.min || 1;
    const d = Math.round((255 * (v - o.min)) / span);
    return d < 0 ? 0 : d > 255 ? 255 : d;
  }
  /** Selected channel window endpoints in native units (for the sliders). */
  protected get minNative(): number {
    return this.selected ? this.toNative(this.selected.min) : 0;
  }
  protected get maxNative(): number {
    return this.selected ? this.toNative(this.selected.max) : 0;
  }
  /** Native slider bounds + step (256 display steps across the native range). */
  protected get sliderMin(): number {
    return this.obsRange().min;
  }
  protected get sliderMax(): number {
    return this.obsRange().max;
  }
  protected get sliderStep(): number {
    const r = this.obsRange();
    return this.is16bit ? Math.max(1, Math.round((r.max - r.min) / 255)) : 1;
  }

  // ── auto / reset ─────────────────────────────────────────────────────
  protected auto(): void {
    if (!this.selected) return;
    // Native path: saturate the true distribution, then map the native window
    // back to the 8-bit store. 8-bit path keeps the existing client auto-window.
    if (this.is16bit && this.hist) {
      const [nmin, nmax] = autoWindowFromHistogram(this.hist, 0.001, [this.sliderMin, this.sliderMax]);
      if (nmax > nmin) {
        this.api.setChannelState(this.selected.index, { min: this.toDisp(nmin), max: this.toDisp(nmax) });
        this.updateMarkers();
      }
      return;
    }
    this.api.autoContrast([this.selected.index], 0.001);
  }
  protected reset(): void {
    if (this.selected) this.api.resetContrast([this.selected.index]);
  }

  // ── histogram rendering ──────────────────────────────────────────────
  /** Fetch the selected channel's histogram (native for 16-bit, else 8-bit) and
   *  (re)draw it. Async — the native path hits the server; the 8-bit path may be
   *  null until tile sampling resolves, so we retry a few times. */
  private loadHistogram(): void {
    if (!this.selected) return;
    // A newer load (channel switch, new image) supersedes a pending retry.
    clearTimeout(this.histRetryTimer);
    this.histSub?.unsubscribe();
    this.histSub = this.api.getHistogram$(this.selected.index, 256).subscribe((h) => {
      if (!h) {
        // Not ready (async sampling / file still caching) — retry a few times.
        if (this.visible && this.histRetries < HIST_MAX_RETRIES) {
          this.histRetries++;
          this.histRetryTimer = setTimeout(() => this.loadHistogram(), HIST_RETRY_MS);
        } else {
          this.hist = null;
          this.renderHistogram();
          this.cdr.markForCheck();
        }
        return;
      }
      this.histRetries = 0;
      this.hist = h;
      this.renderHistogram();
      this.cdr.markForCheck();
    });
  }

  private renderHistogram(): void {
    const el = document.getElementById(this.histogramDiv);
    if (!el || !this.selected) return;
    const h = this.hist;
    if (!h) {
      try {
        Plotly.purge(el);
      } catch {
        /* ignore */
      }
      el.setAttribute('data-empty', 'true');
      return;
    }
    el.removeAttribute('data-empty');
    const y = this.logScale ? h.counts.map((c) => (c > 0 ? Math.log10(c) : 0)) : h.counts;
    const trace = {
      x: h.bins,
      y,
      type: 'bar',
      marker: { color: this.selected.color || '#4fa3ff' },
      hoverinfo: 'x+y',
    };
    Plotly.react(el, [trace] as any, this.histogramLayout(), {
      displayModeBar: false,
      responsive: true,
    } as any);
  }

  /** Move only the min/max marker lines (cheap) without recomputing counts. */
  private updateMarkers(): void {
    const el = document.getElementById(this.histogramDiv);
    if (!el || !this.selected || el.getAttribute('data-empty') === 'true') return;
    try {
      Plotly.relayout(el, { shapes: this.markerShapes() } as any);
    } catch {
      /* not rendered yet */
    }
  }

  private markerShapes(): any[] {
    const c = this.selected;
    if (!c) return [];
    // Markers sit in the same (native) coordinate space as the histogram axis.
    const line = (x: number, color: string) => ({
      type: 'line',
      x0: x,
      x1: x,
      yref: 'paper',
      y0: 0,
      y1: 1,
      line: { color, width: 1, dash: 'dot' },
    });
    return [line(this.toNative(c.min), '#00e0ff'), line(this.toNative(c.max), '#ff7a7a')];
  }

  private histogramLayout(): any {
    return {
      margin: { t: 6, r: 8, b: 24, l: 44 },
      bargap: 0,
      xaxis: { range: [this.sliderMin, this.sliderMax], zeroline: false, color: '#ccc', fixedrange: true },
      yaxis: {
        title: this.logScale ? 'log₁₀ count' : 'count',
        zeroline: false,
        color: '#ccc',
        fixedrange: true,
      },
      paper_bgcolor: 'rgba(30,30,30,0.95)',
      plot_bgcolor: 'rgba(30,30,30,0.95)',
      font: { color: '#ddd', size: 10 },
      shapes: this.markerShapes(),
      showlegend: false,
    };
  }
}
