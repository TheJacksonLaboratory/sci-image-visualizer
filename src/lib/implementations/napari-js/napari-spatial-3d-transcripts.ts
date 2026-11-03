import type { Points3DLayer, Viewer } from 'napari-js';

import { ALL_GENES, type SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import type { SpatialViewState } from '../../contracts/display-types';
import {
  NO_CATEGORY,
  NO_OBSERVATION,
  isCategoricalColumn,
  type SpatialDataset,
  type SpatialTranscriptTile,
} from '../../contracts/spatial-dataset.contract';
import { DEFAULT_CATEGORICAL_PALETTE, categoryColorsFor, parseHex } from '../../spatial/spatial-encoding';
import { allGeneShownBy, allGenesHidden } from '../../spatial/spatial-tile-merge';
import { cellTypeColumnFor } from '../../spatial/spatial-tiles';
import { clusterColorMap, clusterOfGene } from '../../spatial/transcript-grouping';
import { tilesInRect } from '../../spatial/lod';
import { Supersede } from '../../util/supersede';

/** Most transcripts drawn in the 3D view: past it, every k-th one is drawn (and the console says so). */
export const TRANSCRIPTS_3D_MAX = 2_000_000;
/** Most level-0 tiles read for the 3D view: a dataset needing more is too large to draw whole. */
export const TRANSCRIPTS_3D_MAX_TILES = 4096;
/** Tile reads in flight at once. */
const CONCURRENCY = 8;
/** A transcript's marker in the 3D view, in screen pixels at a transcript scale of 1. */
export const TRANSCRIPT_3D_BASE_SIZE = 2;
/** A transcript with no colour by cell type (in no cell, or a cell in no group), as the 2D markers. */
const UNASSIGNED_RGBA = [0.62, 0.62, 0.62, 0.55] as const;

/** What the 3D transcripts need of the scene: where the cloud sits and how Z is stretched. */
export interface Transcripts3dFrame {
  /** Offset applied to observation coordinates to sit them in the scene's box. */
  origin: readonly [number, number, number];
  zScale: number;
}

/** The genes a view draws in 3D, as the tile query takes them, or null when it draws none. */
export function transcripts3dGenes(
  dataset: SpatialDataset,
  view: SpatialViewState,
): { query: string[]; allGenes: boolean } | null {
  if (view.transcriptMode === 'off') return null;
  if (view.transcriptAllGenes) {
    if (allGenesHidden(view)) return null;
    return { query: [ALL_GENES], allGenes: true };
  }
  const hidden = new Set(view.transcriptHiddenGenes);
  const genes = view.transcriptGenes.filter((g) => !hidden.has(g));
  return genes.length ? { query: genes, allGenes: false } : null;
}

/**
 * Each loaded transcript's colour, packed RGBA, as the 2D markers colour them by gene: a gene's
 * chosen colour, else the palette's by its slot (the selection's order, or with "All genes" the
 * dataset's gene code).
 */
export function transcripts3dColors(
  view: SpatialViewState,
  names: readonly string[] | null,
  gene: Uint16Array,
  count: number,
): Float32Array {
  const n = names ? names.length : DEFAULT_CATEGORICAL_PALETTE.length;
  const table = Array.from({ length: n }, (_g, i) =>
    rgba01(
      (names && view.transcriptGeneColors[names[i]]) ||
        DEFAULT_CATEGORICAL_PALETTE[i % DEFAULT_CATEGORICAL_PALETTE.length],
    ),
  );
  return packed(count, (i) => table[names ? gene[i] : gene[i] % n]);
}

/**
 * How the panel's "Colour by" applies in 3D, as it does to the 2D markers (`colorViewFor`): by
 * cell type when the dataset has one (else by gene), by cluster for the selected genes (with "All
 * genes" a cluster is its gene), by gene otherwise.
 */
export function transcripts3dColorBy(
  dataset: SpatialDataset,
  view: SpatialViewState,
  allGenes: boolean,
): 'cellType' | 'cluster' | 'gene' {
  const by = view.transcriptColorBy;
  if (by === 'cellType') return cellTypeColumnFor(dataset, view) ? 'cellType' : 'gene';
  if (by === 'cluster' && !allGenes) return 'cluster';
  return 'gene';
}

/** The colours the cells' grouping gives its groups, by name (none without a grouping). */
async function cellGroupColors(
  dataset: SpatialDataset,
  view: SpatialViewState,
  port: SpatialDataPort,
): Promise<{ codes: Uint16Array; colors: (readonly number[])[]; byName: Map<string, string> } | null> {
  const name = cellTypeColumnFor(dataset, view);
  if (!name) return null;
  const column = await port.getColumn(name);
  if (!isCategoricalColumn(column)) return null;
  const hex = categoryColorsFor(name, column.meta, view.groupColors);
  const byName = new Map(column.meta.categories.map((c, k) => [c, hex[k]] as const));
  return { codes: column.codes, colors: hex.map(rgba01), byName };
}

/** `#rrggbb` as an opaque 0..1 RGBA. */
function rgba01(hex: string): readonly number[] {
  const [r, g, b] = parseHex(hex);
  return [r / 255, g / 255, b / 255, 1];
}

/** `count` colours packed RGBA, unassigned where `at` has none. */
function packed(count: number, at: (i: number) => readonly number[] | undefined): Float32Array {
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) out.set(at(i) ?? UNASSIGNED_RGBA, i * 4);
  return out;
}

/**
 * The transcripts of the 3D spatial view: every molecule of the genes the Transcripts panel draws
 * (its selected genes, or "All genes"), at its own x, y and z, in the cloud's box and Z stretch.
 *
 * The 2D view reads transcripts by level of detail for the camera; a 3D orbit has no such window,
 * so this reads the whole level 0 once per gene selection (a few hundred thousand molecules for a
 * MERFISH section) and only restyles after that. Drawn only for a dataset whose transcripts carry z.
 */
export class Spatial3dTranscripts {
  private layer: Points3DLayer | null = null;
  /** What {@link layer} was loaded from (dataset, genes, quality), and styled with. */
  private loadKey: string | null = null;
  private styleKey: string | null = null;
  private loaded: { tiles: SpatialTranscriptTile[]; names: readonly string[] | null } | null = null;
  private readonly loads = new Supersede();

  constructor(
    private readonly viewer: Viewer,
    private readonly begin: (label: 'Transcripts') => () => void,
  ) {}

  /** The layer drawn, if any (for tests and the scene's Z stretch). */
  get drawn(): Points3DLayer | null {
    return this.layer;
  }

  /** Draw what `view` asks for, loading the molecules when the genes changed. */
  async sync(
    dataset: SpatialDataset,
    view: SpatialViewState,
    port: SpatialDataPort | null,
    frame: Transcripts3dFrame,
  ): Promise<void> {
    const meta = dataset.transcriptTiles;
    const genes = meta?.hasZ && port?.getTranscriptTile ? transcripts3dGenes(dataset, view) : null;
    if (!meta || !genes || !port) {
      this.remove();
      return;
    }
    if (genes.allGenes && (meta.count ?? 0) > TRANSCRIPTS_3D_MAX) {
      console.warn(`[napari-js] ${meta.count} transcripts are too many to draw in 3D: select genes to see theirs`);
      this.remove();
      return;
    }
    const quality = view.transcriptQuality === 'all' ? 'all' : 'high';
    const loadKey = `${dataset.id}|${genes.query.join('\u0001')}|${quality}`;
    if (loadKey !== this.loadKey) {
      const task = this.loads.next();
      const [x0, y0, x1, y1] = meta.bounds;
      const keys = tilesInRect({ x0, y0, x1: x1 + 1e-6, y1: y1 + 1e-6 }, 0, meta.levels, meta.bounds);
      if (keys.length > TRANSCRIPTS_3D_MAX_TILES) {
        console.warn(`[napari-js] ${keys.length} transcript tiles are too many to read for the 3D view`);
        this.remove();
        return;
      }
      const end = this.begin('Transcripts');
      let tiles: SpatialTranscriptTile[];
      try {
        tiles = await pooled(keys, CONCURRENCY, (k) =>
          port.getTranscriptTile!(0, k.gx, k.gy, { genes: genes.query, quality }),
        );
      } catch (err) {
        console.warn('[napari-js] transcripts for the 3D view could not be read', err);
        // The panel asked for other transcripts than those drawn: take them down rather than leave
        // the old selection up as if it were the new one; the next change reads again. Only the
        // current load may: a superseded one must not tear down what a newer one drew.
        if (task()) this.clearLayer();
        return;
      } finally {
        end();
      }
      if (!task()) return;
      this.loadKey = loadKey;
      this.styleKey = null;
      this.loaded = { tiles, names: genes.allGenes ? (meta.genes ?? null) : genes.query };
    }
    await this.draw(dataset, view, port, frame, genes.allGenes);
  }

  /** Follow the scene's Z stretch (nothing is re-uploaded). */
  setZScale(s: number): void {
    if (this.layer) this.layer.scale3d = [1, 1, s];
  }

  /** Take the layer down and forget what it showed. */
  remove(): void {
    this.loads.cancel();
    this.clearLayer();
  }

  private clearLayer(): void {
    if (this.layer) this.viewer.layers.remove(this.layer);
    this.layer = null;
    this.loadKey = null;
    this.styleKey = null;
    this.loaded = null;
  }

  private async draw(
    dataset: SpatialDataset,
    view: SpatialViewState,
    port: SpatialDataPort,
    frame: Transcripts3dFrame,
    allGenes: boolean,
  ): Promise<void> {
    const loaded = this.loaded;
    if (!loaded) return;
    const by = transcripts3dColorBy(dataset, view, allGenes);
    const styleKey = [
      frame.origin.join(','),
      by,
      by === 'gene' ? JSON.stringify(view.transcriptGeneColors) : '',
      by !== 'gene' ? `${cellTypeColumnFor(dataset, view)}|${JSON.stringify(view.groupColors)}` : '',
      by === 'cluster' ? JSON.stringify(view.transcriptGeneGroups) : '',
      allGenes ? view.transcriptAllGenesHidden.join(',') : '',
    ].join('|');
    const size = TRANSCRIPT_3D_BASE_SIZE * (view.transcriptScale > 0 ? view.transcriptScale : 1);
    if (this.layer && styleKey === this.styleKey) {
      this.layer.size = size;
      this.layer.opacity = view.transcriptOpacity;
      this.layer.scale3d = [1, 1, frame.zScale];
      return;
    }
    const { names } = loaded;
    const shown = allGenes && names ? allGeneShownBy(view.transcriptAllGenesHidden) : null;
    const keep = shown && names ? (g: number) => !!names[g] && shown(names[g]) : () => true;
    const total = loaded.tiles.reduce((n, t) => n + t.count, 0);
    const stride = Math.max(1, Math.ceil(total / TRANSCRIPTS_3D_MAX));
    if (stride > 1) console.warn(`[napari-js] drawing every ${stride}th of ${total} transcripts in 3D`);

    const [ox, oy, oz] = frame.origin;
    const positions: number[] = [];
    const genes: number[] = [];
    const cells: number[] = [];
    let seen = 0;
    for (const t of loaded.tiles) {
      for (let i = 0; i < t.count; i++) {
        if (!keep(t.gene[i]) || seen++ % stride) continue;
        positions.push(t.x[i] + ox, t.y[i] + oy, t.z[i] + oz);
        genes.push(t.gene[i]);
        cells.push(t.observation[i]);
      }
    }
    const count = genes.length;
    let colors: Float32Array;
    if (by === 'gene') {
      colors = transcripts3dColors(view, names, Uint16Array.from(genes), count);
    } else {
      const groups = await cellGroupColors(dataset, view, port).catch((err) => {
        console.warn('[napari-js] the cells grouping for the 3D transcripts could not be read', err);
        return null;
      });
      // A newer draw (another style, or the layer taken down) won while the column loaded.
      if (this.loaded !== loaded) return;
      if (by === 'cellType') {
        colors = packed(count, (i) => {
          const o = cells[i];
          const code = !groups || o === NO_OBSERVATION ? NO_CATEGORY : groups.codes[o];
          return code === NO_CATEGORY ? undefined : groups!.colors[code];
        });
      } else {
        // A cluster named like a group of the cells' grouping takes that group's colour, as in 2D.
        const byCluster = clusterColorMap(
          view.transcriptGenes,
          view.transcriptGeneGroups,
          groups?.byName ?? new Map(),
          DEFAULT_CATEGORICAL_PALETTE,
        );
        const table = (names ?? []).map((gene) => {
          const hex = byCluster.get(clusterOfGene(gene, view.transcriptGeneGroups));
          return hex ? rgba01(hex) : undefined;
        });
        colors = packed(count, (i) => table[genes[i]]);
      }
    }
    if (this.layer) this.viewer.layers.remove(this.layer);
    this.layer = null;
    this.styleKey = styleKey;
    if (!count) return;
    this.layer = this.viewer.addPoints3D(Float32Array.from(positions), new Float32Array(count), {
      name: 'transcripts',
      size,
      opacity: view.transcriptOpacity,
      scale3d: [1, 1, frame.zScale],
      colors,
    });
  }
}

/** `work` over `items`, at most `limit` at once, results in order. */
async function pooled<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}
