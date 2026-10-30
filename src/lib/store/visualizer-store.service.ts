import { Injectable, Optional, Inject } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { debounceTime } from 'rxjs/operators';

import { ClassPreset, PresetSet, defaultPresetSet } from '../models/class-preset';
import { findPreset, presetKey } from './class-color.util';
import { PREFERENCES_PORT, PreferencesPort } from '../contracts/ports/preferences.port';

import { IChannelInfo, IImageMetadata } from '../contracts/image.contract';
import { defaultChannelVisible, IChannelState } from '../contracts/channel-histogram-api.contract';
import { DEFAULT_SPATIAL_VIEW, SpatialViewState } from '../contracts/display-types';
import { COLORMAP_OPTIONS } from '../plot.utilities';

/**
 * Backend-neutral store for the **visualization session** — the state that
 * describes *how* the current image is being viewed, independent of which
 * rendering backend (Plotly, OpenSeadragon or napari-js) is on screen:
 *
 *  - the active colormap / LUT and its reverse-scale toggle,
 *  - the current image's physical metadata (µm/pixel etc.) and its per-channel
 *    display state (window, gamma, tint, visibility; grayscale / invert),
 *  - the annotation-class presets (the classification label → colour map),
 *  - the spatial-omics view state,
 *  - which on-canvas tool is currently active.
 *
 * Every backend reads and writes this single instance (one per visualizer chain),
 * so they stay in lock-step regardless of which one is rendering; none of them
 * owns the session state. Region geometry lives in the sibling `RegionStore`.
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
  /** Index of the channel selected in the Channels pane — the ONE band a
   *  single-scalar 3D view (the napari Surface) follows for a multichannel image. */
  private readonly selectedChannel$ = new BehaviorSubject<number>(0);
  // The derived defaults (full window, gamma 1, default tint) for the current
  // image, kept so "Reset" can restore a channel's window/gamma/colour.
  private defaultChannelStates: IChannelState[] = [];
  /** The image the current channel states were derived for (see setImageMeta). */
  private channelImageKey: string | undefined;
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
  /** Session-only class colours from imported files (see PresetSet.importedColors). */
  private importedColors: Record<string, string> = {};
  private readonly presetSet$ = new BehaviorSubject<PresetSet>(this.presetSet);
  private readonly savePresets$ = new Subject<void>();
  private presetsLoaded = false;

  // ── Active on-canvas tool ────────────────────────────────────────────
  // Which tool the user has armed (pan, zoom, drawrect, wand, eraser, …) or
  // null when none is active. The single source of truth for tool state across
  // the toolbar and whichever backend's overlay handles the pointer.
  private readonly activeTool$ = new BehaviorSubject<string | null>(null);

  /** Spatial-omics display state (colour source, point size, alpha, scaling).
   *  Held here, next to the colormap/channel state, so the active backend reacts
   *  to an edit exactly as it does for an image. */
  private readonly spatialView$ = new BehaviorSubject<SpatialViewState>({ ...DEFAULT_SPATIAL_VIEW });

  // Optional + null default so the store can be constructed both via DI and
  // directly (`new VisualizerStore()` in unit tests); preset load/save no-op
  // when the port is absent.
  constructor(@Optional() @Inject(PREFERENCES_PORT) private readonly prefsPort: PreferencesPort | null = null) {
    this.initPresetPersistence();
  }

  // ── Preset persistence (jit-ui#70) ───────────────────────────────────
  private initPresetPersistence(): void {
    // Debounced write-back so a burst of edits collapses into one PUT.
    this.savePresets$.pipe(debounceTime(800)).subscribe(() => {
      this.prefsPort?.savePresetSet(this.presetSet).subscribe({
        error: () => {
          /* keep local copy */
        },
      });
    });
    // Load the user's saved set (if any); otherwise keep the seeded defaults.
    this.prefsPort?.loadPresetSet().subscribe({
      next: (set) => {
        if (set && Array.isArray(set.classes) && set.classes.length > 0) {
          this.presetSet = this.normalizePresetSet(set);
          this.emitPresetSet();
        }
        this.presetsLoaded = true;
      },
      error: () => {
        this.presetsLoaded = true;
      },
    });
  }

  /** Publish the preset set with this session's imported class colours. */
  private emitPresetSet(): void {
    this.presetSet$.next({ ...this.presetSet, importedColors: this.importedColors });
  }

  private normalizePresetSet(set: PresetSet): PresetSet {
    const defaults = defaultPresetSet();
    // Clone the nested arrays/objects so outside callers can't mutate the store's
    // internal state without going through setPresetSet()/upsertClass().
    return {
      classes: Array.isArray(set.classes) ? set.classes.map((c) => ({ ...c })) : [],
      fallbackPalette:
        Array.isArray(set.fallbackPalette) && set.fallbackPalette.length
          ? [...set.fallbackPalette]
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
      this.prefsPort?.savePresetSet(this.presetSet).subscribe({
        error: () => {
          /* keep local copy */
        },
      });
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
    const hasX = (mppX ?? 0) > 0,
      hasY = (mppY ?? 0) > 0;
    if (!hasX && !hasY) return;
    const cur = this.imageMeta$.value;
    const meta = (cur && cur.length ? cur : [{} as IImageMetadata]).map((e) => ({ ...e }));
    if (hasX) meta[0].mppX = mppX;
    if (hasY) meta[0].mppY = mppY;
    this.imageMeta$.next(meta);
  }
  /**
   * Fill in the channel names and tints the host's image meta left out, from the image's tile
   * descriptor: the server reads them from the file (an OME-TIFF's channel names, such as Cytos's
   * "Actin" or "Cell-Membrane"), where a host's metadata (jit-ui's `/metadata`) carries none, so
   * the Channels pane showed "Channel 1", "Channel 2"… The host's own names and tints win; only a
   * channel still showing its derived default takes the descriptor's, so an edit made in the pane
   * stays. A no-op when the channel counts differ, or for RGB.
   */
  adoptChannelInfo(
    info: ReadonlyArray<{ name?: string; color?: string; group?: string[] | null }> | null | undefined,
  ): void {
    const meta = this.imageMeta$.value;
    const m0 = meta?.[0];
    const current = this.channelStates$.value;
    if (!info?.length || !m0 || (m0.rgbChannels ?? 1) >= 3) return;
    if ((m0.channelCount ?? 1) !== info.length || current.length !== info.length) return;
    const host = m0.channelInfo ?? [];
    const merged: IChannelInfo[] = info.map((d, i) => ({
      ...(host[i] ?? {}),
      name: host[i]?.name || d.name || '',
      color: host[i]?.color || d.color || '',
      group: host[i]?.group?.length ? host[i].group : d.group,
    }));
    const before = this.defaultChannelStates;
    const nextMeta = meta.map((e, k) => (k === 0 ? { ...e, channelInfo: merged } : e));
    this.imageMeta$.next(nextMeta);
    const next = this.deriveChannels(nextMeta);
    this.defaultChannelStates = next.map((c) => ({ ...c }));
    let changed = false;
    const states = current.map((st, i) => {
      const was = before[i];
      const now = next[i];
      if (!was || !now) return st;
      const patch: Partial<IChannelState> = {};
      if (st.name === was.name && now.name !== was.name) patch.name = now.name;
      if (st.color === was.color && now.color !== was.color) patch.color = now.color;
      // The groups are the image's, never edited in the pane.
      if (!sameGroup(st.group, now.group)) patch.group = now.group;
      if (!Object.keys(patch).length) return st;
      changed = true;
      return { ...st, ...patch };
    });
    if (changed) this.channelStates$.next(states);
  }

  /**
   * Publish the current image's metadata and derive its channels.
   *
   * `imageKey` identifies the image (its file name). A re-plot of the SAME image
   * keeps the user's window/gamma/tint edits; a different image gets its own
   * derived channels even at the same channel count — keying on the count alone
   * left a DAPI/GFP/RFP stack's names, tints and windows on a following
   * CD3/CD8/PanCK one. Without a key, only a change of channel count re-derives.
   */
  setImageMeta(imageMeta: IImageMetadata[], imageKey?: string): void {
    this.imageMeta$.next(imageMeta);
    const next = this.deriveChannels(imageMeta);
    // Always refresh the reset baseline to the current image's derived defaults
    // (names/colours can differ even at the same channel count).
    this.defaultChannelStates = next.map((c) => ({ ...c }));
    const otherImage = imageKey !== undefined && imageKey !== this.channelImageKey;
    if (imageKey !== undefined) this.channelImageKey = imageKey;
    if (otherImage || next.length !== this.channelStates$.value.length) {
      this.channelStates$.next(next);
      this.selectedChannel$.next(0); // new image / channel structure → reset the selected band
    }
  }

  /** Channels for an image:
   *   - RGB (rgbChannels ≥ 3) → Red/Green/Blue;
   *   - multichannel fluorescence (channelCount > 1) → one channel per band,
   *     named/tinted from the server `channelInfo` when present, else a palette;
   *     only the first `DEFAULT_VISIBLE_CHANNELS` start visible (see `defaultChannelVisible`);
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
        visible: defaultChannelVisible(i, count, info?.[i]?.visible),
        ...(info?.[i]?.group?.length ? { group: [...(info[i].group as string[])] } : {}),
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
  /** The channel selected in the pane (drives a single-scalar 3D Surface). */
  getSelectedChannel(): Observable<number> {
    return this.selectedChannel$.asObservable();
  }
  currentSelectedChannel(): number {
    return this.selectedChannel$.value;
  }
  setSelectedChannel(index: number): void {
    if (this.selectedChannel$.value !== index) this.selectedChannel$.next(index);
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
    // Defensive copy: callers must not mutate the store's state in place —
    // all changes go through setPresetSet()/upsertClass()/removeClass() so
    // presetSet$ and persistence stay in sync.
    return {
      classes: this.presetSet.classes.map((c) => ({ ...c })),
      fallbackPalette: [...this.presetSet.fallbackPalette],
      autoPromote: this.presetSet.autoPromote,
      matchMode: this.presetSet.matchMode,
      importedColors: { ...this.importedColors },
    };
  }
  /**
   * Remember the class colours an imported file carried (label → colour), so its regions keep
   * them: a class with a preset keeps the preset's colour, and the latest import wins for the
   * rest. Not persisted.
   */
  rememberImportedClassColors(colors: ReadonlyMap<string, string>): void {
    let changed = false;
    for (const [label, color] of colors) {
      if (!label || findPreset(label, this.presetSet)) continue;
      const key = presetKey(this.presetSet, label);
      if (this.importedColors[key] === color) continue;
      this.importedColors = { ...this.importedColors, [key]: color };
      changed = true;
    }
    if (changed) this.emitPresetSet();
  }
  getPresetSet$(): Observable<PresetSet> {
    return this.presetSet$.asObservable();
  }
  setPresetSet(set: PresetSet): void {
    this.presetSet = this.normalizePresetSet(set);
    this.emitPresetSet();
    this.savePresetsNow(); // explicit bulk apply/import → persist immediately
  }
  /** Add or update a class (keyed by exact stored `name`). */
  upsertClass(preset: ClassPreset): void {
    const classes = [...this.presetSet.classes];
    const i = classes.findIndex((c) => c.name === preset.name);
    if (i >= 0) classes[i] = { ...classes[i], ...preset };
    else classes.push({ ...preset });
    this.presetSet = { ...this.presetSet, classes };
    this.emitPresetSet();
    this.queuePresetSave();
  }
  removeClass(name: string): void {
    this.presetSet = { ...this.presetSet, classes: this.presetSet.classes.filter((c) => c.name !== name) };
    this.emitPresetSet();
    this.queuePresetSave();
  }
  resetPresets(): void {
    this.presetSet = defaultPresetSet();
    this.emitPresetSet();
    this.savePresetsNow(); // explicit reset → persist immediately
  }

  // ── spatial-omics view state ──────────────────────────────────────────
  getSpatialView$(): Observable<SpatialViewState> {
    return this.spatialView$.asObservable();
  }

  /** Synchronous read, for a renderer building its first frame. */
  currentSpatialView(): SpatialViewState {
    return this.spatialView$.value;
  }

  /** Patch the spatial view state; emits once with the merged value. */
  setSpatialView(partial: Partial<SpatialViewState>): void {
    this.spatialView$.next({ ...this.spatialView$.value, ...partial });
  }

  getActiveTool$(): Observable<string | null> {
    return this.activeTool$.asObservable();
  }
  setActiveTool(tool: string | null): void {
    this.activeTool$.next(tool);
  }
}

/** Whether two group paths are the same (absent and empty alike). */
function sameGroup(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
