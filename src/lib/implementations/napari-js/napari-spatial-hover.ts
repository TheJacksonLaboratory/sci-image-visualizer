import type { Viewer } from 'napari-js';

import { SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import { NO_CATEGORY, SpatialDataset, isCategoricalColumn } from '../../contracts/spatial-dataset.contract';
import { SpatialViewState } from '../../contracts/display-types';
import { sameSelection, selectByCategory } from '../../spatial/spatial-selection';
import { type HoverSource, hoverText } from '../../spatial/spatial-hover';
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
   * the first test after an orbit re-projects the cloud.
   */
  install(el: HTMLElement): void {
    this.dispose();
    this.tooltip = new NapariSpatialTooltip(el);

    const onMove = (e: PointerEvent) => {
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

    const hit = this.host.pick(pointer.clientX, pointer.clientY, HOVER_RADIUS_PX);
    const lines = hoverText(this.hoverSource, hit);
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
