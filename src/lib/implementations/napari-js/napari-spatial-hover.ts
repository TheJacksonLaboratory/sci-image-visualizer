import type { Viewer } from 'napari-js';

import { SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import { NO_CATEGORY, SpatialDataset, isCategoricalColumn } from '../../contracts/spatial-dataset.contract';
import { SpatialViewState } from '../../contracts/display-types';
import { sameSelection, selectByCategory, selectByIndices } from '../../spatial/spatial-selection';
import { type CellInfo, type HoverSource, cellText, cellTypeText, hoverText } from '../../spatial/spatial-hover';
import { cellTypeColumnFor } from '../../spatial/lod';
import { SpatialSelectionStore } from '../../store/spatial-selection.service';
import { Supersede } from '../../util/supersede';
import { NapariSpatialTooltip } from './napari-spatial-tooltip';
import { NapariSpatialTileLayers } from './napari-spatial-tiles';

/** Movement, in screen pixels, under which a press-release is a CLICK and not a
 *  drag. An orbit or a pan starts the same way, so the two have to be told
 *  apart by how far the pointer travelled. */
const CLICK_SLOP_PX = 4;
/** Longest press-release still treated as a click. A long press with the mouse
 *  held still is more likely an interrupted drag than a selection. */
const CLICK_MAX_MS = 600;
/** Pointer distance, in screen pixels, that still counts as "on" a marker.
 *  Generous relative to a 1.5px disc: the cursor is a blunt instrument, and a
 *  tooltip you have to hunt for is worse than none. */
export const HOVER_RADIUS_PX = 10;

/** What the hover reads from the spatial scene it serves. */
export interface SpatialHoverHost {
  /** The orbit view rather than the 2D view (no transcript markers to ask first). */
  readonly is3d: boolean;
  readonly viewer: Viewer;
  readonly port: SpatialDataPort | null;
  readonly selection: SpatialSelectionStore | null;
  /** The dataset on screen, as the spatial subscription last saw it. */
  dataset(): SpatialDataset | null;
  /**
   * The OBSERVATION drawn under a client position, or -1 — `slackPx` screen pixels of slack
   * around the pointer. The scene owns the pick (napari-js's, on the layer it drew) and maps the
   * drawn index back to the observation.
   */
  pick(clientX: number, clientY: number, slackPx: number): number;
  /**
   * The observation of an individual cell's surface under a client position (spatial 3D's cells),
   * or -1: a click on one selects that cell rather than its class. Optional.
   */
  pickCell?(clientX: number, clientY: number): number;
  /** The region surface (a class: a cell type's, in spatial 3D) under a client position, or null. Optional. */
  pickRegion?(clientX: number, clientY: number): { key: string; label?: string } | null;
  /** The 2D transcript markers, which sit on top of everything and are asked first. */
  tiles(): NapariSpatialTileLayers | null;
  /** A region tool owns the pointer (placing a polygon vertex is also a still click). */
  toolActive(): boolean;
  outsideZone<T>(fn: () => T): T;
  inZone<T>(fn: () => T): T;
}

/**
 * Cursor tooltip and click-to-select for the spatial views (review Appendix B, cluster L): hover a
 * marker, read its class; click it, select the class — the canvas equivalent of the panel's
 * legend. The tooltip and the click share ONE hit-test, so a click selects the class the tooltip
 * names (NAPARI-SVC-5).
 *
 * A 34-entry legend cannot be read back from a dot — several classes get similar colours, and
 * matching one to a swatch by eye is exactly the task this removes. It reports whatever the cloud
 * is CURRENTLY coloured by ({@link resolveSource}), so it and the legend can never say different
 * things.
 */
export class SpatialHover {
  private tooltip: NapariSpatialTooltip | null = null;
  /** What the markers are coloured by, resolved once per colour source rather than per hover. */
  private hoverSource: HoverSource | null = null;
  private hoverSourceKey: string | null = null;
  /** In 3D: what a cell's tooltip says of it (its type, id, measurements), resolved once per dataset. */
  private cellInfo: CellInfo | null = null;
  private cellInfoKey: string | null = null;
  private readonly cellInfoLoads = new Supersede();
  /** Latest wins within the scene: the KEY is only committed once a resolution lands, so a
   *  superseded fetch cannot leave the cache claiming to hold a source it never stored. */
  private readonly resolutions = new Supersede();
  private pointer: { clientX: number; clientY: number } | null = null;
  private frame = 0;
  private off: (() => void)[] = [];

  constructor(private readonly host: SpatialHoverHost) {}

  /**
   * Listen on `el` (the plot host) rather than the canvas, so it keeps working over the region
   * overlay (an SVG covering the canvas, which would otherwise swallow every move), and throttle
   * to one hit-test per animation frame: a pointermove can fire far more often than that, and
   * the first test after an orbit re-projects the cloud. None while a button is held: that is an
   * orbit or a pan moving the camera every frame, and a test per frame re-projected all of a 3.7M
   * cloud each time (≈150 ms a frame); the first move after the drag pays for one.
   */
  install(el: HTMLElement): void {
    this.dispose();
    this.tooltip = new NapariSpatialTooltip(el);

    const onMove = (e: PointerEvent) => {
      if (e.buttons) {
        this.pointer = null;
        this.tooltip?.hide();
        return;
      }
      this.pointer = { clientX: e.clientX, clientY: e.clientY };
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.update(el);
      });
    };
    const onLeave = () => {
      this.pointer = null;
      this.tooltip?.hide();
    };

    // A click on a marker selects its class, exactly as clicking that class in the
    // panel's legend does — including clicking again to clear, so a click is
    // always reversible. Tracked as down/up rather than bound to `click` so a DRAG
    // (an orbit in 3D, a pan in 2D) can be told apart from a click: the gesture
    // has to move less than a few pixels and be over quickly.
    let down: { x: number; y: number; t: number } | null = null;
    const onDown = (e: MouseEvent) => {
      down = { x: e.clientX, y: e.clientY, t: Date.now() };
    };
    const onUp = (e: MouseEvent) => {
      const start = down;
      down = null;
      if (!start) return;
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      if (moved > CLICK_SLOP_PX) return;
      if (Date.now() - start.t > CLICK_MAX_MS) return;
      // A region tool owns the pointer while it is active, and placing a polygon
      // vertex is also a click that does not move.
      if (this.host.toolActive()) return;
      this.host.inZone(() => this.selectClassAt(e.clientX, e.clientY));
    };

    // Outside the zone: a pointermove fires far more often than anything here changes what
    // Angular renders (the tooltip is plain DOM); a selecting click re-enters it.
    this.host.outsideZone(() => {
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerleave', onLeave);
      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointerup', onUp);
    });
    this.off.push(() => el.removeEventListener('pointermove', onMove));
    this.off.push(() => el.removeEventListener('pointerleave', onLeave));
    this.off.push(() => el.removeEventListener('pointerdown', onDown));
    this.off.push(() => el.removeEventListener('pointerup', onUp));
  }

  /** Hide the tooltip (the navigator is being dragged, say). */
  hide(): void {
    this.tooltip?.hide();
  }

  /** Remove the listeners and the tooltip, and drop the colour source. */
  dispose(): void {
    for (const off of this.off) off();
    this.off = [];
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pointer = null;
    this.tooltip?.dispose();
    this.tooltip = null;
    this.resolutions.cancel();
    this.hoverSource = null;
    this.hoverSourceKey = null;
  }

  /**
   * What the tooltip says, resolved once per colour source rather than per hover.
   *
   * Fetched separately from the colouring on purpose: the reference port caches
   * columns, but a host's need not, and re-fetching a 3.7M-element vector because
   * the pointer moved would be indefensible either way.
   */
  async resolveSource(dataset: SpatialDataset | null, view: SpatialViewState): Promise<void> {
    if (this.host.is3d) void this.resolveCellInfo(dataset, view);
    const port = this.host.port;
    const colorBy = view.colorBy;
    const key = dataset && colorBy ? `${dataset.id}|${colorBy.kind}:${colorBy.name}` : null;
    if (key === this.hoverSourceKey) return;
    // The key is committed only where a value is actually stored. Setting it up
    // front would mean a resolution that loses the race leaves the key claiming a
    // source that was never stored — and since every later emission carries the
    // same key, it would short-circuit here forever and the tooltip would stay
    // silent for the rest of the session.
    const task = this.resolutions.next();
    // No colour source means nothing is being said about the cells, so there is no
    // cluster to name and the tooltip stays silent.
    if (!key || !dataset || !colorBy || !port) {
      this.hoverSource = null;
      this.hoverSourceKey = key;
      return;
    }
    try {
      if (colorBy.kind === 'column') {
        const column = await port.getColumn(colorBy.name);
        if (!task()) return;
        this.hoverSource = isCategoricalColumn(column)
          ? {
              kind: 'categorical',
              name: colorBy.name,
              categories: column.meta.categories,
              codes: column.codes,
            }
          : {
              kind: 'continuous',
              name: colorBy.name,
              values: column.values,
              ...(column.meta.unit ? { unit: column.meta.unit } : {}),
            };
        this.hoverSourceKey = key;
        return;
      }
      const values = await port.getFeatureVector(colorBy.name);
      if (!task()) return;
      this.hoverSource = {
        kind: 'continuous',
        name: colorBy.name,
        values,
        ...(dataset.features?.unit ? { unit: dataset.features.unit } : {}),
      };
      this.hoverSourceKey = key;
    } catch {
      if (!task()) return;
      // The tooltip is an extra; a failed fetch must not disturb the render. The
      // key is left unset so a later emission retries rather than inheriting a
      // permanent silence.
      this.hoverSource = null;
      this.hoverSourceKey = null;
    }
  }

  /**
   * What a 3D cell's tooltip says (see `cellText`): the cell-type column's codes, the ids, and the
   * dataset's first few continuous columns. Resolved once per dataset and type column; a failure
   * leaves the tooltip with what the colouring says.
   */
  private async resolveCellInfo(dataset: SpatialDataset | null, view: SpatialViewState): Promise<void> {
    const port = this.host.port;
    const typeName = dataset ? cellTypeColumnFor(dataset, view) : null;
    const key = dataset ? `${dataset.id}|${typeName ?? ''}` : null;
    if (key === this.cellInfoKey) return;
    this.cellInfoKey = key;
    const task = this.cellInfoLoads.next();
    if (!dataset || !port) {
      this.cellInfo = null;
      return;
    }
    try {
      const type = typeName ? await port.getColumn(typeName) : null;
      const measureNames = dataset.columns
        .filter((c) => c.kind === 'continuous')
        .map((c) => c.name)
        .slice(0, 4);
      const measures = (await Promise.all(measureNames.map((n) => port.getColumn(n).catch(() => null)))).flatMap(
        (c) =>
          c && !isCategoricalColumn(c)
            ? [{ name: c.meta.name, values: c.values, ...(c.meta.unit ? { unit: c.meta.unit } : {}) }]
            : [],
      );
      if (!task()) return;
      const categorical = type && isCategoricalColumn(type) ? type : null;
      let counts: Uint32Array | null = null;
      if (categorical) {
        counts = new Uint32Array(categorical.meta.categories.length);
        for (const c of categorical.codes) if (c !== NO_CATEGORY && c < counts.length) counts[c]++;
      }
      this.cellInfo = {
        typeName: categorical ? typeName : null,
        categories: categorical?.meta.categories ?? [],
        codes: categorical?.codes ?? null,
        counts,
        ...(dataset.observations.ids ? { ids: dataset.observations.ids } : {}),
        measures,
      };
    } catch {
      if (!task()) return;
      this.cellInfo = null;
      this.cellInfoKey = null;
    }
  }

  /** In 3D: the tooltip of the cell, or of the cell type's surface, under a client position. */
  private cell3dText(clientX: number, clientY: number): string[] | null {
    if (!this.host.is3d) return null;
    const cell = this.host.pickCell?.(clientX, clientY) ?? -1;
    if (cell >= 0) return cellText(this.cellInfo, cell, this.hoverSource);
    return null;
  }

  /** Hit-test the last pointer position and show or hide the tooltip. */
  private update(el: HTMLElement): void {
    const tip = this.tooltip;
    const pointer = this.pointer;
    const dataset = this.host.dataset();
    if (!tip || !pointer || !dataset) return;

    // Transcript markers sit on top of everything, so they are asked first.
    const tiles = this.host.tiles();
    if (!this.host.is3d && tiles) {
      const viewer = this.host.viewer;
      const world = viewer.canvasToWorld(pointer.clientX, pointer.clientY);
      const zoom = viewer.camera.zoom;
      const radius = HOVER_RADIUS_PX / (zoom > 0 ? zoom : 1);
      const lines = world
        ? tiles.hoverAt(world[0], world[1], radius, (details) => {
            const p = this.pointer;
            if (!p || !this.tooltip) return;
            const r = el.getBoundingClientRect();
            this.tooltip.show(details, p.clientX - r.left, p.clientY - r.top);
          })
        : null;
      if (lines) {
        const rect = el.getBoundingClientRect();
        tip.show(lines, pointer.clientX - rect.left, pointer.clientY - rect.top);
        return;
      }
    }

    // A cell drawn by itself names itself; a marker, its colouring; else a cell type's surface.
    let lines = this.cell3dText(pointer.clientX, pointer.clientY);
    if (!lines) {
      const hit = this.host.pick(pointer.clientX, pointer.clientY, HOVER_RADIUS_PX);
      lines =
        hit >= 0 && this.host.is3d && this.cellInfo
          ? cellText(this.cellInfo, hit, this.hoverSource)
          : hoverText(this.hoverSource, hit);
      if (!lines && this.host.is3d) {
        const region = this.host.pickRegion?.(pointer.clientX, pointer.clientY);
        if (region) lines = cellTypeText(this.cellInfo, region.key, region.label);
      }
    }
    if (!lines) {
      tip.hide();
      return;
    }
    const rect = el.getBoundingClientRect();
    tip.show(lines, pointer.clientX - rect.left, pointer.clientY - rect.top);
  }

  /**
   * Select the class of the marker at a client position — the canvas equivalent of
   * clicking that class in the panel's legend, and the same selection object, so
   * the two controls cannot produce different results.
   *
   * Clicking a class that is already the whole selection CLEARS it, which is what
   * the legend does. Compared against the selection itself rather than against a
   * remembered click, so selecting from the legend and then clicking the same
   * class on the canvas still toggles.
   */
  private selectClassAt(clientX: number, clientY: number): void {
    const source = this.hoverSource;
    const store = this.host.selection;
    const dataset = this.host.dataset();
    // A cell drawn by itself: the click selects that cell (again: clears it), whatever colours it.
    const cell = this.host.pickCell?.(clientX, clientY) ?? -1;
    if (cell >= 0 && store && dataset) {
      const next = selectByIndices([cell], dataset.observations.count);
      if (sameSelection(store.current(), next)) store.clear();
      else store.set(next);
      return;
    }
    // Only a categorical source has classes to select. A gene is continuous:
    // there is no set of cells that "is" a value.
    if (!store || !dataset || source?.kind !== 'categorical') return;

    // The same pick the tooltip makes — depth-aware in 3D — so a click selects the class the
    // tooltip names, not an occluded marker's.
    const hit = this.host.pick(clientX, clientY, HOVER_RADIUS_PX);
    if (hit < 0) return;
    const code = source.codes[hit];
    // A cell the annotation does not cover has no class to select.
    if (code === undefined || code === NO_CATEGORY) return;

    const next = selectByCategory(source.codes, code);
    const current = store.current();
    if (sameSelection(current, next)) {
      store.clear();
      return;
    }
    store.set(next);
  }
}
