/**
 * Draws a region source (see `region-source`) under the editable regions, at the level of detail
 * the zoom calls for, from the tiles in view only — the way the spatial views draw cell outlines.
 * Shared by the OpenSeadragon and napari overlays: both hand it their svg and their world → svg
 * camera affine, as they do their {@link SvgRegionRenderer}.
 *
 * One `<path>` per colour (every ring of every feature of that colour, even-odd), in world
 * coordinates inside one transformed group, so a camera move rewrites one attribute. The tiles in
 * view are re-planned once the camera settles; while a finer tile loads its coarser parent is
 * drawn instead, so zooming in sharpens the outlines rather than blanking them. Features taken
 * into the working set (selected, edited) or deleted are not drawn: the region renderer draws the
 * taken ones as ordinary regions.
 *
 * It also answers what is under a point, from the features drawn, for the overlays' selection.
 */
import type { Observable, Subscription } from 'rxjs';

import { RegionSourceView, isAbortError } from '../region-source/region-source';
import {
  Bbox,
  RegionTile,
  RegionTileKey,
  TileFeature,
  featureAt,
  featuresInRect,
  regionLevelFor,
  regionTileId,
  regionTilesInRect,
} from '../region-source/region-tiles';
import { Affine, IDENTITY_AFFINE, svgEl } from './svg-region-renderer';

/** Wait this long after the last camera change before planning tiles (ms). */
export const SOURCE_REPLAN_MS = 90;
/** The view is padded by this fraction on each side, so a short pan finds its tiles loaded. */
export const SOURCE_VIEW_MARGIN = 0.25;
/** At most this many tiles in view. */
export const SOURCE_MAX_TILES = 256;
/** A rubber band takes at most this many source features into the working set. */
export const SOURCE_MARQUEE_LIMIT = 2000;
/** Loaded tiles kept by the layer for drawing (the source caches more). */
const LAYER_TILE_LIMIT = 512;
/** Stroke width of a source outline, screen px (an unselected region's). */
const SOURCE_STROKE_PX = 2;

/** The svg size (local px), for the part of the world in view. */
export type SvgSize = () => { width: number; height: number };

export class RegionSourceLayer {
  private readonly group = svgEl('g');
  private camera: Affine = IDENTITY_AFFINE;
  private view: RegionSourceView | null = null;
  private visible = true;
  private readonly sub: Subscription;
  /** Loaded tiles of the current source and plane, by id, least recently used first. */
  private readonly tiles = new Map<string, RegionTile>();
  /** The tiles the view wants now. */
  private wanted: RegionTileKey[] = [];
  /** The features drawn, by id (each at the finest level loaded). */
  private drawn = new Map<string, TileFeature>();
  private loading: AbortController | null = null;
  private replanTimer: ReturnType<typeof setTimeout> | null = null;
  private drawFrame: number | null = null;

  constructor(
    private readonly svg: SVGSVGElement,
    view$: Observable<RegionSourceView | null>,
    private readonly size: SvgSize = () => svgSize(svg),
  ) {
    this.group.setAttribute('data-layer', 'region-source');
    this.group.setAttribute('pointer-events', 'none');
    this.sub = view$.subscribe((view) => this.setView(view));
  }

  /** Follow the camera: rewrite the transform now, re-plan the tiles once it settles. */
  setCamera(affine: Affine): void {
    if (!affine.every(Number.isFinite)) return;
    if (affine.every((v, i) => v === this.camera[i])) return;
    this.camera = affine;
    this.applyCamera();
    if (!this.view) return;
    if (this.replanTimer) clearTimeout(this.replanTimer);
    this.replanTimer = setTimeout(() => {
      this.replanTimer = null;
      this.replan();
    }, SOURCE_REPLAN_MS);
  }

  /** Show or hide the source with the regions. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.attach();
  }

  /**
   * The source feature under world point (x, y) — inside an area, or within `tolerancePx`
   * screen pixels of a polyline — from the features drawn; the innermost of nested ones.
   */
  featureAt(x: number, y: number, tolerancePx = 4): TileFeature | null {
    if (!this.view || !this.visible) return null;
    return featureAt(this.drawn.values(), x, y, tolerancePx / this.scale());
  }

  /** The drawn source features whose box meets the world box (the rubber band's rule). */
  featuresInRect(x0: number, y0: number, x1: number, y1: number): TileFeature[] {
    if (!this.view || !this.visible) return [];
    return featuresInRect(this.drawn.values(), [x0, y0, x1, y1]);
  }

  destroy(): void {
    this.sub.unsubscribe();
    this.loading?.abort();
    if (this.replanTimer) clearTimeout(this.replanTimer);
    if (this.drawFrame !== null) cancelFrame(this.drawFrame);
    this.group.parentNode?.removeChild(this.group);
  }

  private setView(view: RegionSourceView | null): void {
    const prev = this.view;
    this.view = view;
    if (!view || prev?.source !== view.source || prev.plane !== view.plane) {
      this.tiles.clear();
      this.loading?.abort();
      this.loading = null;
    }
    this.attach();
    if (view) this.replan();
    else this.draw();
  }

  /** The layer is the svg's first child (under the regions) while it shows a source. */
  private attach(): void {
    const show = !!this.view && this.visible;
    if (!show) {
      this.group.parentNode?.removeChild(this.group);
      return;
    }
    if (this.svg.firstChild !== this.group) this.svg.insertBefore(this.group, this.svg.firstChild);
  }

  private applyCamera(): void {
    this.group.setAttribute('transform', `matrix(${this.camera.join(' ')})`);
  }

  /** Screen px per world unit. */
  private scale(): number {
    const [a, b, c, d] = this.camera;
    return Math.sqrt(Math.abs(a * d - b * c)) || 1;
  }

  /** The world box in view, padded by the margin; null when the svg has no size yet. */
  private viewRect(): Bbox | null {
    const { width, height } = this.size();
    if (!(width > 0) || !(height > 0)) return null;
    const [a, b, c, d, e, f] = this.camera;
    const det = a * d - b * c;
    if (!det) return null;
    const toWorld = (sx: number, sy: number): [number, number] => {
      const x = sx - e,
        y = sy - f;
      return [(d * x - c * y) / det, (a * y - b * x) / det];
    };
    const mx = width * SOURCE_VIEW_MARGIN,
      my = height * SOURCE_VIEW_MARGIN;
    const corners = [
      toWorld(-mx, -my),
      toWorld(width + mx, -my),
      toWorld(-mx, height + my),
      toWorld(width + mx, height + my),
    ];
    const xs = corners.map((p) => p[0]),
      ys = corners.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  /** Work out the tiles the view needs, draw what is loaded, and load the rest. */
  private replan(): void {
    const view = this.view;
    if (!view) return;
    const rect = this.viewRect();
    if (!rect) {
      this.wanted = [];
      this.draw();
      return;
    }
    const info = view.source.info;
    const level = regionLevelFor(this.scale(), info.levels);
    this.wanted = regionTilesInRect(rect, level, info.tileSize, info.bounds, SOURCE_MAX_TILES);
    this.scheduleDraw();
    const missing = this.wanted.filter((k) => !this.tiles.has(regionTileId(k)));
    this.loading?.abort();
    this.loading = null;
    if (!missing.length) return;
    const loading = new AbortController();
    this.loading = loading;
    for (const key of missing) {
      view.source.getTile(view.plane, key, loading.signal).then(
        (tile) => {
          if (this.view?.source !== view.source || this.view.plane !== view.plane) return;
          this.keep(tile);
          this.scheduleDraw();
        },
        (err) => {
          if (!isAbortError(err)) console.warn('[regions] region tile failed', err);
        },
      );
    }
  }

  private keep(tile: RegionTile): void {
    const id = regionTileId(tile);
    this.tiles.delete(id);
    this.tiles.set(id, tile);
    while (this.tiles.size > LAYER_TILE_LIMIT) this.tiles.delete(this.tiles.keys().next().value as string);
  }

  private scheduleDraw(): void {
    if (this.drawFrame !== null) return;
    this.drawFrame = requestFrame(() => {
      this.drawFrame = null;
      this.draw();
    });
  }

  /**
   * Rebuild the paths from the wanted tiles that are loaded, a missing tile's nearest loaded
   * ancestor standing in for it; each feature once, at the finest level loaded.
   */
  private draw(): void {
    const view = this.view;
    const drawn = new Map<string, TileFeature>();
    const level = new Map<string, number>();
    if (view) {
      const used = new Set<string>();
      for (const key of this.wanted) {
        const tile = this.loadedOrAncestor(key);
        if (!tile || used.has(regionTileId(tile))) continue;
        used.add(regionTileId(tile));
        for (const f of tile.features) {
          if (view.taken.has(f.id)) continue;
          const had = level.get(f.id);
          if (had !== undefined && had <= tile.level) continue;
          drawn.set(f.id, f);
          level.set(f.id, tile.level);
        }
      }
    }
    this.drawn = drawn;
    const byColor = new Map<string, string[]>();
    for (const f of drawn.values()) {
      const color = view?.colorOf(f) ?? '#00FFFF';
      let parts = byColor.get(color);
      if (!parts) byColor.set(color, (parts = []));
      for (const ring of f.rings) parts.push(ringD(ring, !f.open));
    }
    const frag = document.createDocumentFragment();
    for (const [color, parts] of byColor) {
      const path = svgEl('path');
      path.setAttribute('d', parts.join(''));
      path.setAttribute('fill', 'none');
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', `${SOURCE_STROKE_PX}`);
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      frag.appendChild(path);
    }
    while (this.group.firstChild) this.group.removeChild(this.group.firstChild);
    this.group.appendChild(frag);
    this.applyCamera();
  }

  /** The loaded tile for `key`, else its nearest loaded coarser ancestor. */
  private loadedOrAncestor(key: RegionTileKey): RegionTile | null {
    const levels = this.view?.source.info.levels ?? 0;
    let { gx, gy } = key;
    for (let level = key.level; level < levels; level++) {
      const tile = this.tiles.get(regionTileId({ level, gx, gy }));
      if (tile) return tile;
      gx = Math.floor(gx / 2);
      gy = Math.floor(gy / 2);
    }
    return null;
  }
}

/** Path data of one ring (`closed`) or polyline, in world units to 1/100. */
function ringD(ring: Float32Array, closed: boolean): string {
  const n = ring.length >> 1;
  if (n < 2) return '';
  let d = `M${r2(ring[0])} ${r2(ring[1])}`;
  for (let i = 1; i < n; i++) d += `L${r2(ring[2 * i])} ${r2(ring[2 * i + 1])}`;
  return closed ? `${d}Z` : d;
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

function svgSize(svg: SVGSVGElement): { width: number; height: number } {
  const width = svg.clientWidth || svg.getBoundingClientRect().width;
  const height = svg.clientHeight || svg.getBoundingClientRect().height;
  return { width, height };
}

const requestFrame = (fn: () => void): number =>
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(fn)
    : (setTimeout(fn, 16) as unknown as number);

const cancelFrame = (id: number): void =>
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id);
