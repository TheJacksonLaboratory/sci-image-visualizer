import { Injectable, Optional } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable } from 'rxjs';

import { IImageMetadata } from './contracts/image.contract';
import { COLORMAP_OPTIONS } from './plot.utilities';

/**
 * Backend-neutral store for the **visualization session** — the state that
 * describes *how* the current image is being viewed, independent of which
 * rendering backend (Plotly or OpenSeadragon) is on screen:
 *
 *  - the active colormap / LUT and its reverse-scale toggle,
 *  - the current image's physical metadata (µm/pixel etc.),
 *  - the classification label → colour map,
 *  - which on-canvas tool is currently active.
 *
 * Both backends read and write this single instance, so they stay in lock-step
 * regardless of which one is rendering. Previously this state lived inside
 * `PlotlyService`, which forced the OpenSeadragon backend to depend on the
 * Plotly service purely to read the shared colormap; this store removes that
 * coupling — neither backend owns the session state.
 *
 * NOTE: region *geometry* (the drawn shapes / per-image region cache) still
 * lives in `PlotlyService` for now; extracting it into a sibling region store
 * is a separate follow-up.
 */
@Injectable({ providedIn: 'root' })
export class VisualizerStore {
  // ── Colormap / LUT ───────────────────────────────────────────────────
  // Default to inverted greys (dark background → bright signal), which reads as
  // the natural grayscale for these microscopy images.
  private readonly colormap$ = new BehaviorSubject<any>(
    COLORMAP_OPTIONS[0].children.find((c: any) => c.label === 'Greys Inv') ?? COLORMAP_OPTIONS[0].children[0],
  );
  private readonly reverseScale$ = new BehaviorSubject<boolean>(false);

  // ── Image metadata (physical pixel size, channels, …) ────────────────
  private readonly imageMeta$ = new BehaviorSubject<IImageMetadata[]>([]);

  // ── Classification colours (class label → colour) ────────────────────
  // Defaults shared by every backend's region renderer.
  private readonly classificationColors = new Map<string, string>([
    ['Fragmented-embryo', '#FF8C00'],
    ['Dying-embryo', '#FF3333'],
    ['Two-cell-embryo', '#33CC66'],
    ['One-cell-embryo', '#3399FF'],
    ['Unknown', '#888888'],
    ['Tumor', '#FF4444'],
    ['Stroma', '#44AAFF'],
    ['Immune cells', '#FFDD00'],
    ['Necrosis', '#AA6633'],
    ['Region', '#00FFFF'],
    ['Ignore', '#AAAAAA'],
    ['Positive', '#00CC44'],
    ['Negative', '#CC0000'],
  ]);

  // ── Active on-canvas tool ────────────────────────────────────────────
  // Which tool the user has armed (pan, zoom, drawrect, wand, eraser, …) or
  // null when none is active. The single source of truth for tool state across
  // the toolbar and whichever backend's overlay handles the pointer.
  private readonly activeTool$ = new BehaviorSubject<string | null>(null);

  // Optional + a null default so the store can be constructed both via DI and
  // directly (`new VisualizerStore()` in unit tests); the LUT fetch no-ops when
  // there's no HttpClient.
  constructor(@Optional() private readonly http: HttpClient | null = null) {
    this.loadColormapLuts();
  }

  /**
   * Resolve the colormap tree's LUT keys (e.g. "GREYS_LUT") to their colour
   * arrays from a served JSON asset. The ~630 KB of LUT data lives outside the
   * bundle (as `/assets/plotting/colormap-luts.json`) so it never enters the TS
   * / webpack module graph — that data-in-source was the main driver of the
   * build's >2 GB heap. Named Plotly scales (e.g. "Viridis") aren't keys in the
   * JSON, so they're left untouched. The default LUT ("Greys Inv" → the Plotly
   * "Greys" scale) needs no JSON, so the first render works before this resolves.
   */
  private loadColormapLuts(): void {
    if (!this.http) return;
    this.http.get<Record<string, [number, string][]>>('assets/plotting/colormap-luts.json').subscribe({
      next: (luts) => {
        for (const group of COLORMAP_OPTIONS as any[]) {
          for (const child of group.children ?? []) {
            const key = child?.data?.value;
            if (typeof key === 'string' && luts[key]) child.data.value = luts[key];
          }
        }
      },
      error: () => { /* leave keys unresolved; named scales still work */ },
    });
  }

  /** The available colormap options (tree for the LUT dropdown). */
  getColormapOptions(): any {
    return COLORMAP_OPTIONS;
  }

  getColormap(): Observable<any> {
    return this.colormap$.asObservable();
  }
  /** Synchronous current value — for render paths that read it while building
   *  a frame (e.g. Plotly's colorscale) rather than subscribing. */
  currentColormap(): any {
    return this.colormap$.value;
  }
  setColormap(colormap: any): void {
    this.colormap$.next(colormap);
  }

  getReverseScale(): Observable<boolean> {
    return this.reverseScale$.asObservable();
  }
  currentReverseScale(): boolean {
    return this.reverseScale$.value;
  }
  setReverseScale(reverse: boolean): void {
    this.reverseScale$.next(reverse);
  }

  getImageMeta(): Observable<IImageMetadata[]> {
    return this.imageMeta$.asObservable();
  }
  setImageMeta(imageMeta: IImageMetadata[]): void {
    this.imageMeta$.next(imageMeta);
  }

  getClassificationColors(): Map<string, string> {
    return this.classificationColors;
  }
  setClassificationColor(label: string, color: string): void {
    this.classificationColors.set(label, color);
  }

  getActiveTool$(): Observable<string | null> {
    return this.activeTool$.asObservable();
  }
  getActiveTool(): string | null {
    return this.activeTool$.value;
  }
  setActiveTool(tool: string | null): void {
    this.activeTool$.next(tool);
  }
}
