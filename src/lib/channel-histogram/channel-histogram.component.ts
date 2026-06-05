import {
  Component, EventEmitter, Inject, Input, OnDestroy, OnInit, Output,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { TreeNode } from 'primeng/api';
import * as Plotly from 'plotly.js-dist-min';

import {
  CHANNEL_HISTOGRAM_API, IChannelHistogramApi, IChannelState,
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

  channels: IChannelState[] = [];
  selected: IChannelState | null = null;
  invert = false;
  logScale = false;
  /** Bounded retries while the (async) histogram sampling resolves. */
  private histRetries = 0;

  colormapOptions: any;
  selectedColormap: any;

  private subs = new Subscription();
  /** Keeps the Plotly histogram sized to the (resizable) dialog body. */
  private resizeObserver?: ResizeObserver;

  constructor(@Inject(CHANNEL_HISTOGRAM_API) private api: IChannelHistogramApi) {}

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
    // not with window edits — so refresh it when the image metadata changes.
    this.subs.add(this.api.getImageMeta().subscribe(() => { if (this.visible) this.renderHistogram(); }));
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
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
      this.renderHistogram();
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
    this.renderHistogram();
  }

  // ── per-channel edits (live) ─────────────────────────────────────────
  // PrimeNG slider/inputNumber events carry `number | string | null`, so the
  // handlers accept `any` and coerce.
  onMinChange(value: any): void {
    if (!this.selected) return;
    const min = this.clamp(value);
    const max = Math.max(min, this.selected.max);
    this.api.setChannelState(this.selected.index, { min, max });
    this.updateMarkers();
  }
  onMaxChange(value: any): void {
    if (!this.selected) return;
    const max = this.clamp(value);
    const min = Math.min(max, this.selected.min);
    this.api.setChannelState(this.selected.index, { min, max });
    this.updateMarkers();
  }
  onGammaChange(value: any): void {
    if (!this.selected) return;
    const g = Number(value);
    if (isNaN(g)) return;
    this.api.setChannelState(this.selected.index, { gamma: g });
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

  // ── auto / reset ─────────────────────────────────────────────────────
  auto(): void {
    if (this.selected) this.api.autoContrast([this.selected.index], 0.001);
  }
  reset(): void {
    if (this.selected) this.api.resetContrast([this.selected.index]);
  }

  // ── histogram rendering ──────────────────────────────────────────────
  private renderHistogram(): void {
    const el = document.getElementById(this.histogramDiv);
    if (!el || !this.selected) return;
    const h = this.api.getHistogram(this.selected.index, 256);
    if (!h) {
      // The histogram is sampled asynchronously on image load — retry a few
      // times before giving up so it appears once sampling resolves.
      if (this.visible && this.histRetries < 10) {
        this.histRetries++;
        setTimeout(() => this.renderHistogram(), 400);
        return;
      }
      try { Plotly.purge(el); } catch { /* ignore */ }
      el.setAttribute('data-empty', 'true');
      return;
    }
    this.histRetries = 0;
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
    const line = (x: number, color: string) => ({
      type: 'line', x0: x, x1: x, yref: 'paper', y0: 0, y1: 1,
      line: { color, width: 1, dash: 'dot' },
    });
    return [line(c.min, '#00e0ff'), line(c.max, '#ff7a7a')];
  }

  private histogramLayout(): any {
    return {
      margin: { t: 6, r: 8, b: 24, l: 44 },
      bargap: 0,
      xaxis: { range: [0, 255], zeroline: false, color: '#ccc', fixedrange: true },
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

  private clamp(value: any): number {
    const v = Number(value);
    if (v == null || isNaN(v)) return 0;
    return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
}
