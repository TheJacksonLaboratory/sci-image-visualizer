import type { Points3DLayer, Viewer } from 'napari-js';

import { ALL_GENES, type SpatialDataPort } from '../../contracts/ports/spatial-data.port';
import type { SpatialViewState } from '../../contracts/display-types';
import type { SpatialDataset, SpatialTranscriptTile } from '../../contracts/spatial-dataset.contract';
import { DEFAULT_CATEGORICAL_PALETTE, parseHex } from '../../spatial/spatial-encoding';
import { allGeneShownBy, allGenesHidden } from '../../spatial/spatial-tile-merge';
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
 * dataset's gene code); hidden genes of "All genes" get alpha 0 and are left out by the caller.
 */
export function transcripts3dColors(
  view: SpatialViewState,
  names: readonly string[] | null,
  gene: Uint16Array,
  count: number,
): Float32Array {
  const n = names ? names.length : DEFAULT_CATEGORICAL_PALETTE.length;
  const table = Array.from({ length: n }, (_g, i) => {
    const [r, g, b] = parseHex(
      (names && view.transcriptGeneColors[names[i]]) ||
        DEFAULT_CATEGORICAL_PALETTE[i % DEFAULT_CATEGORICAL_PALETTE.length],
    );
    return [r / 255, g / 255, b / 255, 1] as const;
  });
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const c = table[names ? gene[i] : gene[i] % n];
    if (c) out.set(c, i * 4);
  }
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
        return;
      } finally {
        end();
      }
      if (!task()) return;
      this.loadKey = loadKey;
      this.styleKey = null;
      this.loaded = { tiles, names: genes.allGenes ? (meta.genes ?? null) : genes.query };
    }
    this.draw(view, frame, genes.allGenes);
  }

  /** Follow the scene's Z stretch (nothing is re-uploaded). */
  setZScale(s: number): void {
    if (this.layer) this.layer.scale3d = [1, 1, s];
  }

  /** Take the layer down and forget what it showed. */
  remove(): void {
    this.loads.cancel();
    if (this.layer) this.viewer.layers.remove(this.layer);
    this.layer = null;
    this.loadKey = null;
    this.styleKey = null;
    this.loaded = null;
  }

  private draw(view: SpatialViewState, frame: Transcripts3dFrame, allGenes: boolean): void {
    const loaded = this.loaded;
    if (!loaded) return;
    const styleKey = [
      frame.origin.join(','),
      JSON.stringify(view.transcriptGeneColors),
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
    let seen = 0;
    for (const t of loaded.tiles) {
      for (let i = 0; i < t.count; i++) {
        if (!keep(t.gene[i]) || seen++ % stride) continue;
        positions.push(t.x[i] + ox, t.y[i] + oy, t.z[i] + oz);
        genes.push(t.gene[i]);
      }
    }
    if (this.layer) this.viewer.layers.remove(this.layer);
    this.layer = null;
    this.styleKey = styleKey;
    if (!genes.length) return;
    const count = genes.length;
    this.layer = this.viewer.addPoints3D(Float32Array.from(positions), new Float32Array(count), {
      name: 'transcripts',
      size,
      opacity: view.transcriptOpacity,
      scale3d: [1, 1, frame.zScale],
      colors: transcripts3dColors(view, names, Uint16Array.from(genes), count),
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
