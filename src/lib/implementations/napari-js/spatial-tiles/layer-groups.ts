import type { Layer, ShapesLayer, Viewer } from 'napari-js';

import type { SpatialPolygons } from '../../../contracts/spatial-dataset.contract';

/** The layer groups of the 2D spatial tile view. */
export type TileGroup = 'density' | 'cellFill' | 'cellOutline' | 'nucleusOutline' | 'transcripts' | 'transcriptOutline';

/**
 * Bottom to top: cell fill, cell outline, nucleus outline, the transcript density, then the
 * transcripts. The density goes OVER the service's observation markers on purpose: under 10^5
 * dots it would only show in the gaps between cells.
 */
export const TILE_LAYER_ORDER: readonly TileGroup[] = [
  'cellFill', 'cellOutline', 'nucleusOutline', 'density', 'transcripts', 'transcriptOutline',
];

/**
 * One napari-js layer per named group, kept in a fixed bottom-to-top order, plus what each
 * group currently shows (its key), so an unchanged plan is a no-op.
 *
 * napari-js's layer list is append-only (add / remove / clear), so order is kept by
 * re-adding. Each removal disposes the layer's GPU visual (re-uploaded on the next frame), so
 * a plan restores the order once, after all its groups are in place, and moves only the
 * layers that are out of place ({@link restoreOrder}). `LayerList.move` in napari-js would
 * remove the re-upload (review NAPARI-BOUNDARY-11).
 */
export class OrderedLayerGroups<G extends string> {
  private current: Viewer | null = null;
  private readonly layers = new Map<G, Layer>();
  /** What each group currently shows, so an unchanged plan is a no-op. */
  private readonly keys = new Map<G, string>();

  constructor(private readonly order: readonly G[]) {}

  /** The viewer the groups are drawn into, while attached. */
  get viewer(): Viewer | null {
    return this.current;
  }

  attach(viewer: Viewer): void {
    this.current = viewer;
  }

  /** Remove every group's layer from the viewer and forget the layers, keys and viewer. */
  detach(): void {
    if (this.current) {
      for (const layer of this.layers.values()) {
        if (this.current.layers.items.includes(layer)) this.current.layers.remove(layer);
      }
    }
    this.layers.clear();
    this.keys.clear();
    this.current = null;
  }

  /** Whether `group` has a layer (on screen or not). */
  has(group: G): boolean {
    return this.layers.has(group);
  }

  /** Whether `group`'s layer is in the viewer now. */
  shown(group: G): boolean {
    const layer = this.layers.get(group);
    return !!layer && !!this.current?.layers.items.includes(layer);
  }

  /** What `group` currently shows, as its plan keyed it. */
  key(group: G): string | undefined {
    return this.keys.get(group);
  }

  setKey(group: G, key: string): void {
    this.keys.set(group, key);
  }

  /** Forget what `group` shows, so the next plan redraws it. */
  forgetKey(group: G): void {
    this.keys.delete(group);
  }

  /** Whether `layer` is one of the groups' layers. */
  owns(layer: Layer): boolean {
    for (const l of this.layers.values()) if (l === layer) return true;
    return false;
  }

  /**
   * Put a shapes layer in place for `group`: a geometry change builds a new layer, a
   * colour-only change mutates values/colormap on the existing one.
   */
  upsertShapes(
    group: G, wanted: boolean, geometryChanged: boolean, rings: SpatialPolygons,
    opts: Parameters<Viewer['addShapes']>[2] & object,
  ): void {
    if (!wanted) {
      this.drop(group);
      return;
    }
    const existing = this.layers.get(group) as ShapesLayer | undefined;
    if (existing && !geometryChanged && this.current!.layers.items.includes(existing)) {
      // Flat colour has no values; clearing them is what switches the layer to `color`.
      existing.values = opts.values ?? null;
      if (opts.colormap) existing.colormap = opts.colormap;
      if (opts.contrastLimits) existing.contrastLimits = opts.contrastLimits;
      if (opts.color) existing.color = opts.color;
      if (opts.opacity !== undefined) existing.opacity = opts.opacity;
      this.current!.requestRender();
      return;
    }
    const layer = this.current!.addShapes(rings.coords, rings.offsets, opts);
    this.replace(group, layer);
  }

  /**
   * Install `layer` as `group`'s layer. The layer was just added by the caller, so it is on
   * top: the plan puts the groups that belong above it back in place once it is done
   * ({@link restoreOrder}), rather than after every replaced group.
   */
  replace(group: G, layer: Layer): void {
    const v = this.current!;
    const old = this.layers.get(group);
    if (old && old !== layer && v.layers.items.includes(old)) v.layers.remove(old);
    this.layers.set(group, layer);
    v.requestRender();
  }

  /**
   * Put the groups' layers in order, re-adding only from the first one out of place (and,
   * with `aboveOthers`, the first one under a layer that is not ours — the service's
   * markers). Everything before that is already where it belongs and keeps its GPU visual.
   */
  restoreOrder(aboveOthers: boolean): void {
    const v = this.current;
    if (!v) return;
    const items = v.layers.items;
    const wanted = this.order.map((g) => this.layers.get(g)).filter((l): l is Layer => !!l && items.includes(l));
    const ours = new Set<Layer>(wanted);
    let lastOther = -1;
    if (aboveOthers) items.forEach((l, i) => { if (!ours.has(l)) lastOther = i; });
    const current = items.filter((l) => ours.has(l));
    let k = 0;
    while (k < wanted.length && current[k] === wanted[k] && items.indexOf(wanted[k]) > lastOther) k++;
    if (k === wanted.length) return;
    for (const layer of wanted.slice(k)) {
      v.layers.remove(layer);
      v.layers.add(layer);
    }
    v.requestRender();
  }

  /** Remove `group`'s layer and forget its key. */
  drop(group: G): void {
    const layer = this.layers.get(group);
    if (layer && this.current?.layers.items.includes(layer)) this.current.layers.remove(layer);
    this.layers.delete(group);
    this.keys.delete(group);
  }

  /** Drop every group. */
  dropAll(): void {
    for (const g of this.order) this.drop(g);
  }
}
