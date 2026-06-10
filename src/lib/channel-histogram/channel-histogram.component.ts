import {
  Component, EventEmitter, Inject, Input, OnDestroy, OnInit, Output,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { TreeNode } from 'primeng/api';
import * as Plotly from 'plotly.js-dist-min';

import {
  CHANNEL_HISTOGRAM_API, IChannelHistogramApi, IChannelState, IHistogram, LUT_COLORS,
} from '../contracts/channel-histogram-api.contract';

/**
 * Channels & Histogram pane: a non-modal, resizable, draggable dialog for
 * brightness/contrast (per-channel display window), gamma, channel
 * visibility/colour, the intensity histogram, and the colormap/reverse/invert
 * controls (moved here from the toolbar). Every edit flows through
 * {@link CHANNEL_HISTOGRAM_API} into the shared store, and both rendering
 * backends recolor the displayed image live. The pane depends only on the
 * contract, never the concrete visualizer.
 */
@Component({
  selector: 'channel-histogram',
  templateUrl: './channel-histogram.component.html',
  styleUrls: ['./channel-histogram.component.scss'],
})
export class ChannelHistogramComponent implements OnInit, OnDestroy {
  /** Dialog visibility, two-way bound so the host (toolbar button) can open it. */
  @Input() visible = false;
  @Output() visibleChange = new EventEmitter<boolean>();

  readonly histogramDiv = 'channel-histogram-plot';
  readonly lutColors = LUT_COLORS;

  channels: IChannelState[] = [];
  selected: IChannelState | null = null;
  invert = false;
  logScale = false;
  /** Bounded retries while the (async) histogram sampling resolves. */
  private histRetries = 0;
  /** The selected channel's current histogram. Native bit depth (with
   *  observed/range fields) for >8-bit images, else the 8-bit client histogram.
   *  Drives the plot, the native window labels, and the export-button gate. */
  hist: IHistogram | null = null;
  private histSub?: Subscription;
  /** Which window control is being adjusted right now — drives a small
   *  non-blocking activity spinner next to that slider, since the image recolor
   *  isn't instant on large stacks. Cleared a short moment after movement stops
   *  (the recolor isn't directly observable, so this is a trailing heuristic). */
  activeAdjust: 'min' | 'max' | 'gamma' | null = null;
  private adjustTimer?: ReturnType<typeof setTimeout>;

  colormapOptions: any;
  selectedColormap: any;

  private subs = new Subscription();
  /** Keeps the Plotly histogram sized to the (resizable) dialog body. */
  private resizeObserver?: ResizeObserver;

  constructor(@Inject(CHANNEL_HISTOGRAM_API) private api: IChannelHistogramApi) {}

  /** Per-channel pseudo-colour only applies when there's more than one channel
   *  (RGB / fluorescence). A single grayscale channel uses the colormap instead. */
  get multichannel(): boolean {
    return this.channels.length > 1;
  }

  ngOnInit(): void {
    this.colormapOptions = this.api.getColormapOptions();
    this.subs.add(this.api.getColormap().subscribe((cm) => (this.selectedColormap = cm)));
    this.subs.add(this.api.getInvert$().subscribe((i) => (this.invert = !!i)));
    this.subs.add(
      this.api.getChannels$().subscribe((channels) => {
        this.channels = channels ?? [];
        // Keep the selected row (by index) or default to the first channel.
        const keepIdx = this.selected?.index ?? 0;
        this.selected = this.channels.find((c) => c.index === keepIdx) ?? this.channels[0] ?? null;
        if (this.visible) this.updateMarkers();
      }),
    );
    // The histogram is of the source pixels — it changes with the image/slice,
    // not with window edits — so reload it when the image metadata changes.
    this.subs.add(this.api.getImageMeta().subscribe(() => { if (this.visible) this.loadHistogram(); }));
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.histSub?.unsubscribe();
    clearTimeout(this.adjustTimer);
    this.teardownResize();
    try { Plotly.purge(this.histogramDiv); } catch { /* never rendered */ }
  }

  onVisibleChange(v: boolean): void {
    this.visible = v;
    this.visibleChange.emit(v);
    if (!v) this.teardownResize();
  }

  /** p-dialog (onShow): the plot div now exists, so draw the histogram and keep
   *  it sized to the dialog (which is resizable) via a ResizeObserver. */
  onShow(): void {
    this.histRetries = 0;
    requestAnimationFrame(() => {
      this.loadHistogram();
      const el = document.getElementById(this.histogramDiv);
      if (el && !this.resizeObserver && typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => {
          try { (Plotly as any).Plots.resize(el); } catch { /* not rendered */ }
        });
        this.resizeObserver.observe(el);
      }
    });
  }

  private teardownResize(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
  }

  selectChannel(ch: IChannelState): void {
    this.selected = ch;
    this.histRetries = 0;
    this.loadHistogram();
  }

  // ── per-channel edits (live) ─────────────────────────────────────────
  // PrimeNG slider/inputNumber events carry `number | string | null`, so the
  // handlers accept `any` and coerce. Values arrive in NATIVE units (the slider
  // is labelled natively for 16-bit); we map them back to the store's 8-bit
  // display window via the channel's observed range (identity for 8-bit images,
  // so their behaviour is unchanged).
  onMinChange(value: any): void {
    if (!this.selected) return;
    const min = this.toDisp(value);
    const max = Math.max(min, this.selected.max);
    this.api.setChannelState(this.selected.index, { min, max });
    this.markBusy('min');
    this.updateMarkers();
  }
  onMaxChange(value: any): void {
    if (!this.selected) return;
    const max = this.toDisp(value);
    const min = Math.min(max, this.selected.min);
    this.api.setChannelState(this.selected.index, { min, max });
    this.markBusy('max');
    this.updateMarkers();
  }
  onGammaChange(value: any): void {
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
    this.adjustTimer = setTimeout(() => { this.activeAdjust = null; }, 500);
  }
  onVisibleToggle(ch: IChannelState, value: boolean): void {
    this.api.setChannelState(ch.index, { visible: value });
  }
  onColorChange(ch: IChannelState, color: string): void {
    this.api.setChannelState(ch.index, { color });
    // The histogram bars are drawn in the selected channel's colour — redraw
    // when that channel's colour changes.
    if (this.selected && ch.index === this.selected.index) {
      this.selected.color = color;
      this.renderHistogram();
    }
  }

  // ── display options ──────────────────────────────────────────────────
  onColormap(node: TreeNode): void {
    if (node && !node.children) this.api.setColormap(node);
  }
  onInvert(value: boolean): void {
    this.invert = value;
    this.api.setInvert(value);
  }
  toggleLog(value: boolean): void {
    this.logScale = value;
    this.renderHistogram();
  }

  /** Quick-assign a preset LUT colour to a channel (Fiji palette). */
  setPreset(ch: IChannelState, color: string): void {
    this.onColorChange(ch, color);
  }

  /** Export the displayed composite as a publication-ready PNG (8-bit figure). */
  exportComposite(): void {
    this.api.exportComposite();
  }

  /** Export the underlying data as a true-16-bit multi-band TIFF (server-side). */
  exportData(): void {
    this.api.exportData();
  }

  // ── native bit-depth helpers ─────────────────────────────────────────
  /** True when the current channel histogram is native >8-bit (16-bit etc.):
   *  gates the native slider labelling and the 16-bit TIFF export button. */
  get is16bit(): boolean {
    return (this.hist?.bitDepth ?? 8) > 8;
  }
  /** The native value range the 8-bit display window maps onto — the observed
   *  pixel extremes for a native histogram, else plain 0..255 (so 8-bit images
   *  pass through unchanged). The 8-bit tile is server-stretched across this
   *  range, so it's the best client-side native↔display mapping. */
  private obsRange(): { min: number; max: number } {
    const h = this.hist;
    if (h && (h.bitDepth ?? 8) > 8 && (h.observedMax ?? 0) > (h.observedMin ?? 0)) {
      return { min: h.observedMin as number, max: h.observedMax as number };
    }
    return { min: 0, max: 255 };
  }
  /** 8-bit display value (0..255) → native units. */
  private toNative(disp: number): number {
    const o = this.obsRange();
    return Math.round(o.min + (disp / 255) * (o.max - o.min));
  }
  /** Native units → clamped 8-bit display value (0..255). */
  private toDisp(value: any): number {
    const v = Number(value);
    if (v == null || isNaN(v)) return 0;
    const o = this.obsRange();
    const span = o.max - o.min || 1;
    const d = Math.round(255 * (v - o.min) / span);
    return d < 0 ? 0 : d > 255 ? 255 : d;
  }
  /** Selected channel window endpoints in native units (for the sliders). */
  get minNative(): number { return this.selected ? this.toNative(this.selected.min) : 0; }
  get maxNative(): number { return this.selected ? this.toNative(this.selected.max) : 0; }
  /** Native slider bounds + step (256 display steps across the native range). */
  get sliderMin(): number { return this.obsRange().min; }
  get sliderMax(): number { return this.obsRange().max; }
  get sliderStep(): number {
    const r = this.obsRange();
    return this.is16bit ? Math.max(1, Math.round((r.max - r.min) / 255)) : 1;
  }

  // ── auto / reset ─────────────────────────────────────────────────────
  auto(): void {
    if (!this.selected) return;
    // Native path: saturate the true distribution, then map the native window
    // back to the 8-bit store. 8-bit path keeps the existing client auto-window.
    if (this.is16bit && this.hist) {
      const [nmin, nmax] = this.autoWindow(this.hist, 0.001);
      if (nmax > nmin) {
        this.api.setChannelState(this.selected.index, { min: this.toDisp(nmin), max: this.toDisp(nmax) });
        this.updateMarkers();
      }
      return;
    }
    this.api.autoContrast([this.selected.index], 0.001);
  }
  reset(): void {
    if (this.selected) this.api.resetContrast([this.selected.index]);
  }

  /** Saturation-based auto-window over a (native or 8-bit) histogram: pick
   *  [min,max] so ~`saturation` of pixels clip at each end, dropping a dominant
   *  first/last bin (background/padding). Returns native bin values. */
  private autoWindow(h: IHistogram, saturation: number): [number, number] {
    const counts = h.counts.slice();
    const n = counts.length;
    if (n === 0) return [this.sliderMin, this.sliderMax];
    if (n > 2 && counts[0] > counts[1]) counts[0] = 0;
    if (n > 2 && counts[n - 1] > counts[n - 2]) counts[n - 1] = 0;
    let total = 0;
    for (const c of counts) total += c;
    if (total <= 0) return [this.sliderMin, this.sliderMax];
    const target = total * Math.max(0, Math.min(0.5, saturation));
    let acc = 0;
    let min = h.bins[0];
    for (let i = 0; i < n; i++) { acc += counts[i]; if (acc > target) { min = h.bins[i]; break; } }
    acc = 0;
    let max = h.bins[n - 1];
    for (let i = n - 1; i >= 0; i--) { acc += counts[i]; if (acc > target) { max = h.bins[i]; break; } }
    return [min, max];
  }

  // ── histogram rendering ──────────────────────────────────────────────
  /** Fetch the selected channel's histogram (native for 16-bit, else 8-bit) and
   *  (re)draw it. Async — the native path hits the server; the 8-bit path may be
   *  null until tile sampling resolves, so we retry a few times. */
  private loadHistogram(): void {
    if (!this.selected) return;
    this.histSub?.unsubscribe();
    this.histSub = this.api.getHistogram$(this.selected.index, 256).subscribe((h) => {
      if (!h) {
        // Not ready (async sampling / file still caching) — retry a few times.
        if (this.visible && this.histRetries < 10) {
          this.histRetries++;
          setTimeout(() => this.loadHistogram(), 400);
        } else {
          this.hist = null;
          this.renderHistogram();
        }
        return;
      }
      this.histRetries = 0;
      this.hist = h;
      this.renderHistogram();
    });
  }

  private renderHistogram(): void {
    const el = document.getElementById(this.histogramDiv);
    if (!el || !this.selected) return;
    const h = this.hist;
    if (!h) {
      try { Plotly.purge(el); } catch { /* ignore */ }
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
      displayModeBar: false, responsive: true,
    } as any);
  }

  /** Move only the min/max marker lines (cheap) without recomputing counts. */
  private updateMarkers(): void {
    const el = document.getElementById(this.histogramDiv);
    if (!el || !this.selected || el.getAttribute('data-empty') === 'true') return;
    try {
      Plotly.relayout(el, { shapes: this.markerShapes() } as any);
    } catch { /* not rendered yet */ }
  }

  private markerShapes(): any[] {
    const c = this.selected;
    if (!c) return [];
    // Markers sit in the same (native) coordinate space as the histogram axis.
    const line = (x: number, color: string) => ({
      type: 'line', x0: x, x1: x, yref: 'paper', y0: 0, y1: 1,
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
        zeroline: false, color: '#ccc', fixedrange: true,
      },
      paper_bgcolor: 'rgba(30,30,30,0.95)',
      plot_bgcolor: 'rgba(30,30,30,0.95)',
      font: { color: '#ddd', size: 10 },
      shapes: this.markerShapes(),
      showlegend: false,
    };
  }
}
