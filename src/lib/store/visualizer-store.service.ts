import { Injectable, Optional, Inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { debounceTime } from 'rxjs/operators';

import { ClassPreset, PresetSet, defaultPresetSet } from '../models/class-preset';
import { PREFERENCES_PORT, PreferencesPort } from '../contracts/ports/preferences.port';

import { IImageMetadata } from '../contracts/image.contract';
import { IChannelState } from '../contracts/channel-histogram-api.contract';
import { COLORMAP_OPTIONS } from '../plot.utilities';

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

  // ── Channels & histogram display state ───────────────────────────────
  // Per-channel display window/gamma/visibility/colour, derived from the image
  // metadata on load (1 "Intensity" channel for grayscale; R/G/B for RGB). The
  // Channels & Histogram pane edits these and both backends recolor live.
  private readonly channelStates$ = new BehaviorSubject<IChannelState[]>([]);
  // The derived defaults (full window, gamma 1, default tint) for the current
  // image, kept so "Reset" can restore a channel's window/gamma/colour.
  private defaultChannelStates: IChannelState[] = [];
  // Grayscale display (ignore the channel tints) and inverted background — both
  // global display flags, like the colormap.
  private readonly grayscale$ = new BehaviorSubject<boolean>(false);
  private readonly invert$ = new BehaviorSubject<boolean>(false);

  // ── Annotation class presets (jit-ui#70) ─────────────────────────────
  // The per-user, server-persisted source of truth for region colours, seeded
  // from the historical default classes. Loaded/saved via the optional
  // PreferencesPort (app-side adapter → jit-service). getClassificationColors()
  // below stays as a name→colour view for the backends' region renderers.
  private presetSet: PresetSet = defaultPresetSet();
  private readonly presetSet$ = new BehaviorSubject<PresetSet>(this.presetSet);
  private readonly savePresets$ = new Subject<void>();
  private presetsLoaded = false;

  // ── Active on-canvas tool ────────────────────────────────────────────
  // Which tool the user has armed (pan, zoom, drawrect, wand, eraser, …) or
  // null when none is active. The single source of truth for tool state across
  // the toolbar and whichever backend's overlay handles the pointer.
  private readonly activeTool$ = new BehaviorSubject<string | null>(null);

  // Optional + null defaults so the store can be constructed both via DI and
  // directly (`new VisualizerStore()` in unit tests); the LUT fetch and preset
  // load/save no-op when their dependency is absent.
  constructor(
    @Optional() private readonly http: HttpClient | null = null,
    @Optional() @Inject(PREFERENCES_PORT) private readonly prefsPort: PreferencesPort | null = null,
  ) {
    this.loadColormapLuts();
    this.initPresetPersistence();
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

  // ── Preset persistence (jit-ui#70) ───────────────────────────────────
  private initPresetPersistence(): void {
    // Debounced write-back so a burst of edits collapses into one PUT.
    this.savePresets$.pipe(debounceTime(800)).subscribe(() => {
      this.prefsPort?.savePresetSet(this.presetSet).subscribe({ error: () => { /* keep local copy */ } });
    });
    // Load the user's saved set (if any); otherwise keep the seeded defaults.
    this.prefsPort?.loadPresetSet().subscribe({
      next: (set) => {
        if (set && Array.isArray(set.classes) && set.classes.length > 0) {
          this.presetSet = this.normalizePresetSet(set);
          this.presetSet$.next(this.presetSet);
        }
        this.presetsLoaded = true;
      },
      error: () => { this.presetsLoaded = true; },
    });
  }

  private normalizePresetSet(set: PresetSet): PresetSet {
    const defaults = defaultPresetSet();
    return {
      classes: Array.isArray(set.classes) ? set.classes : [],
      fallbackPalette:
        Array.isArray(set.fallbackPalette) && set.fallbackPalette.length
          ? set.fallbackPalette
          : defaults.fallbackPalette,
      autoPromote: !!set.autoPromote,
      matchMode: set.matchMode === 'normalized' ? 'normalized' : 'exact',
    };
  }

  /** Queue a debounced save. No-ops until the initial load resolves (and when no port is bound). */
  private queuePresetSave(): void {
    if (this.presetsLoaded) this.savePresets$.next();
  }

  /** Persist the current preset set immediately, bypassing the incremental-edit
   *  debounce. Used for explicit bulk actions (Apply / Import / Reset). */
  private savePresetsNow(): void {
    if (this.presetsLoaded) {
      this.prefsPort?.savePresetSet(this.presetSet).subscribe({ error: () => { /* keep local copy */ } });
    }
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

  /**
   * Patch the physical pixel size (µm/pixel) onto the current image meta and
   * re-emit, without touching the derived channels. The OSD tile descriptor
   * (from the server's Bio-Formats `/tiles/info`) is authoritative for scaled
   * images — `imageInfo.imageMeta` often carries no mpp — so the renderer feeds
   * it here once the descriptor loads, letting area/scale consumers (the Region
   * Editor) show µm²/mm² instead of px². No-op when neither axis is positive.
   */
  setPhysicalPixelSize(mppX?: number, mppY?: number): void {
    const hasX = (mppX ?? 0) > 0, hasY = (mppY ?? 0) > 0;
    if (!hasX && !hasY) return;
    const cur = this.imageMeta$.value;
    const meta = (cur && cur.length ? cur : [{} as IImageMetadata]).map((e) => ({ ...e }));
    if (hasX) meta[0].mppX = mppX;
    if (hasY) meta[0].mppY = mppY;
    this.imageMeta$.next(meta);
  }
  setImageMeta(imageMeta: IImageMetadata[]): void {
    this.imageMeta$.next(imageMeta);
    // Re-derive channels only when their structure changes (count), so a re-plot
    // of the same image doesn't clobber the user's window/gamma edits.
    const next = this.deriveChannels(imageMeta);
    // Always refresh the reset baseline to the current image's derived defaults
    // (names/colours can differ even at the same channel count).
    this.defaultChannelStates = next.map((c) => ({ ...c }));
    if (next.length !== this.channelStates$.value.length) {
      this.channelStates$.next(next);
    }
  }

  /** Channels for an image:
   *   - RGB (rgbChannels ≥ 3) → Red/Green/Blue;
   *   - multichannel fluorescence (channelCount > 1) → one channel per band,
   *     named/tinted from the server `channelInfo` when present, else a palette;
   *   - otherwise a single grayscale "Intensity" channel. */
  private deriveChannels(meta: IImageMetadata[]): IChannelState[] {
    const base = { min: 0, max: 255, gamma: 1, visible: true };
    const m = meta?.[0];
    if ((m?.rgbChannels ?? 1) >= 3) {
      return [
        { index: 0, name: 'Red', color: '#ff0000', ...base },
        { index: 1, name: 'Green', color: '#00ff00', ...base },
        { index: 2, name: 'Blue', color: '#0000ff', ...base },
      ];
    }
    const count = m?.channelCount ?? 1;
    if (count > 1) {
      const info = m?.channelInfo;
      // Fallback tints (Fiji-ish) when the server doesn't supply a color.
      const palette = ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#00ffff', '#ff00ff', '#ffff00'];
      return Array.from({ length: count }, (_, i) => ({
        index: i,
        name: info?.[i]?.name || `Channel ${i + 1}`,
        color: info?.[i]?.color || palette[i % palette.length],
        ...base,
      }));
    }
    return [{ index: 0, name: 'Intensity', color: '#ffffff', ...base }];
  }

  // ── Channels & histogram state ───────────────────────────────────────
  getChannelStates(): Observable<IChannelState[]> {
    return this.channelStates$.asObservable();
  }
  currentChannelStates(): IChannelState[] {
    return this.channelStates$.value;
  }
  /** Patch one channel by index (immutable update). */
  setChannelState(index: number, partial: Partial<IChannelState>): void {
    const next = this.channelStates$.value.map((c) =>
      c.index === index ? { ...c, ...partial, index: c.index } : c,
    );
    this.channelStates$.next(next);
  }
  /** Replace all channel states (used by auto/reset). */
  setChannelStates(states: IChannelState[]): void {
    this.channelStates$.next(states);
  }
  /** Reset one channel's display window, gamma AND colour to the values derived
   *  for the current image (full 0..255 range, gamma 1, the channel's default
   *  tint). Falls back to neutral defaults if no baseline was captured. */
  resetChannelState(index: number): void {
    const def = this.defaultChannelStates.find((c) => c.index === index);
    this.setChannelState(index, {
      min: def?.min ?? 0,
      max: def?.max ?? 255,
      gamma: def?.gamma ?? 1,
      color: def?.color ?? '#ffffff',
    });
  }

  getGrayscale(): Observable<boolean> {
    return this.grayscale$.asObservable();
  }
  currentGrayscale(): boolean {
    return this.grayscale$.value;
  }
  setGrayscale(on: boolean): void {
    this.grayscale$.next(on);
  }

  getInvert(): Observable<boolean> {
    return this.invert$.asObservable();
  }
  currentInvert(): boolean {
    return this.invert$.value;
  }
  setInvert(on: boolean): void {
    this.invert$.next(on);
  }

  /** Name→colour view of the current preset set (compat for backend renderers
   *  that still read a Map). */
  getClassificationColors(): Map<string, string> {
    return new Map(this.presetSet.classes.map((c) => [c.name, c.color]));
  }
  /** Upsert a single class colour (used by the editor's per-class colour picker). */
  setClassificationColor(label: string, color: string): void {
    this.upsertClass({ name: label, color });
  }

  // ── Annotation-class preset set accessors (jit-ui#70) ────────────────
  getPresetSet(): PresetSet {
    return this.presetSet;
  }
  getPresetSet$(): Observable<PresetSet> {
    return this.presetSet$.asObservable();
  }
  setPresetSet(set: PresetSet): void {
    this.presetSet = this.normalizePresetSet(set);
    this.presetSet$.next(this.presetSet);
    this.savePresetsNow(); // explicit bulk apply/import → persist immediately
  }
  /** Add or update a class (keyed by exact stored `name`). */
  upsertClass(preset: ClassPreset): void {
    const classes = [...this.presetSet.classes];
    const i = classes.findIndex((c) => c.name === preset.name);
    if (i >= 0) classes[i] = { ...classes[i], ...preset };
    else classes.push({ ...preset });
    this.presetSet = { ...this.presetSet, classes };
    this.presetSet$.next(this.presetSet);
    this.queuePresetSave();
  }
  removeClass(name: string): void {
    this.presetSet = { ...this.presetSet, classes: this.presetSet.classes.filter((c) => c.name !== name) };
    this.presetSet$.next(this.presetSet);
    this.queuePresetSave();
  }
  resetPresets(): void {
    this.presetSet = defaultPresetSet();
    this.presetSet$.next(this.presetSet);
    this.savePresetsNow(); // explicit reset → persist immediately
  }
  /** Force a (debounced) write-back of the current preset set. */
  persistPresets(): void {
    this.queuePresetSave();
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
