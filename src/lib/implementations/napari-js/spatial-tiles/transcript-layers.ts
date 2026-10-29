import { pointSymbolCode } from 'napari-js';
import type { PointSymbol, PointsLayer, RGBA } from 'napari-js';

import type { Rgb } from '../../../contracts/colormap-lut';
import { ALL_GENES } from '../../../contracts/ports/spatial-data.port';
import type { SpatialViewState } from '../../../contracts/display-types';
import {
  NO_CATEGORY,
  NO_OBSERVATION,
  SpatialDataset,
  SpatialTranscriptTile,
} from '../../../contracts/spatial-dataset.contract';
import { DEFAULT_CATEGORICAL_PALETTE, parseHex, resolveCategoryColors } from '../../../spatial/spatial-encoding';
import { DataRect, cellTypeColumnFor } from '../../../spatial/lod';
import { clusterColorMap } from '../../../spatial/transcript-grouping';
import { TranscriptGlyph, defaultGlyphFor } from '../../../spatial/glyphs';
import {
  filterTranscripts,
  hiddenAllGeneCodes,
  hiddenGeneSlots,
  median,
} from '../../../spatial/spatial-tile-merge';
import type { CategoricalLookup } from './categorical-lookup';
import type { OrderedLayerGroups, TileGroup } from './layer-groups';
import type { PlanContext } from './plan-context';
import type { TranscriptHover, TranscriptKind } from './transcript-hover';
import { type TranscriptJob, type TranscriptJobPlanner, groupSelection } from './transcript-jobs';

/** Icons get a dark rim only while there are at most this many, at least this big (px). */
const GLYPH_OUTLINE_MAX = 20_000;
const GLYPH_OUTLINE_MIN_PX = 8;

/** The dark rim of a marker. */
const RIM_COLOR: RGBA = [0.04, 0.04, 0.05, 0.9];

/**
 * The napari-js point symbol each transcript icon is drawn as. Every icon has a counterpart of
 * the same outline (`circle` is napari's `disc`); see {@link GLYPH_SIZE} for the one whose size
 * differs.
 */
export const GLYPH_SYMBOLS: Readonly<Record<TranscriptGlyph, PointSymbol>> = {
  circle: 'disc',
  star: 'star',
  triangle: 'triangle_up',
  square: 'square',
  diamond: 'diamond',
  cross: 'cross',
  hexagon: 'hexagon',
  'triangle-down': 'triangle_down',
  pentagon: 'pentagon',
  x: 'x',
};

/**
 * Marker diameter per icon, as a fraction of the entry's: napari's `square` fills the marker's
 * whole box, where the icon it replaces had a 0.8 half-side, as heavy as the other icons.
 */
const GLYPH_SIZE: Readonly<Partial<Record<TranscriptGlyph, number>>> = { square: 0.8 };

/**
 * What a transcript plan draws, as a key: an unchanged one is a no-op. Marker sizes follow the
 * zoom, so the zoom is part of it; a pan that keeps the same tiles on screen changes nothing.
 */
function transcriptPlanKey(
  dataset: SpatialDataset,
  view: SpatialViewState,
  job: TranscriptJob,
  pxPerUnit: number,
): string {
  return [
    dataset.id,
    view.transcriptMode,
    job.key,
    view.transcriptColorBy,
    cellTypeColumnFor(dataset, view),
    view.transcriptScale,
    view.transcriptOpacity,
    JSON.stringify(view.transcriptGlyphs),
    pxPerUnit.toPrecision(4),
    view.hiddenGroups.join('\u0001'),
    view.transcriptHiddenGenes.join(','),
    view.transcriptAllGenesHidden.join(','),
    JSON.stringify(view.transcriptGeneColors),
    JSON.stringify(view.transcriptGeneGroups),
  ].join('|');
}

/** The view the markers are coloured by, for what was loaded. */
export function colorViewFor(
  view: SpatialViewState,
  kind: TranscriptKind,
  clustered: boolean,
  hasCellTypes: boolean,
): SpatialViewState {
  // A bin of the all-gene pyramid mixes genes and carries none, so it cannot be coloured
  // by gene: colour it by its dominant cell's type until individual transcripts show (with
  // no cell types, that leaves every bin unassigned: one colour).
  if (kind === 'bins' && view.transcriptColorBy !== 'cellType') return { ...view, transcriptColorBy: 'cellType' };
  // Density-grid markers have no cell to take a type from: they take their cluster's colour.
  if (clustered && view.transcriptColorBy === 'cellType') return { ...view, transcriptColorBy: 'cluster' };
  // No cell types to colour by (the panel then does not offer it): by gene instead.
  if (!hasCellTypes && kind !== 'bins' && view.transcriptColorBy === 'cellType') {
    return { ...view, transcriptColorBy: 'gene' };
  }
  return view;
}

/** Where a layer sits in world space: the dataset's affine onto its tissue image. */
interface Placement {
  scale: [number, number];
  translate: [number, number];
}

const UNASSIGNED_RGBA: RGBA = [0.62, 0.62, 0.62, 0.55];

/**
 * The transcript markers of the 2D spatial view: runs the planner's job, drops hidden groups
 * and genes, groups a selection under the marker budget, colours the entries and draws them as
 * one points layer: sized circles, or gene icons as per-point symbols (with a dark rim while
 * there are few enough).
 *
 * Hands what it drew to the hover one way ({@link TranscriptHover.setDrawn}), and keeps the
 * loaded per-gene transcripts the in-view gene counts are taken from.
 */
export class TranscriptLayers {
  /** The loaded per-gene transcripts the in-view counts are taken from. */
  private countSource: { merged: SpatialTranscriptTile; genes: string[] } | null = null;

  constructor(
    private readonly groups: OrderedLayerGroups<TileGroup>,
    private readonly jobs: TranscriptJobPlanner,
    private readonly lookup: CategoricalLookup,
    private readonly hover: TranscriptHover,
  ) {}

  /**
   * Transcripts of each selected gene inside `rect`: each entry counts for the transcripts it
   * stands for (an aggregate at a coarse level holds several). Null without per-gene data.
   */
  geneCountsIn(rect: DataRect): Record<string, number> | null {
    const src = this.countSource;
    if (!src) return null;
    const out: Record<string, number> = {};
    for (const g of src.genes) out[g] = 0;
    const { x, y, weight, gene } = src.merged;
    for (let i = 0; i < src.merged.count; i++) {
      if (x[i] < rect.x0 || x[i] > rect.x1 || y[i] < rect.y0 || y[i] > rect.y1) continue;
      const name = src.genes[gene[i]];
      if (name !== undefined) out[name] += weight[i];
    }
    return out;
  }

  /** The viewer went away: no counts until the next plan. */
  detached(): void {
    this.countSource = null;
  }

  /** Draw the view's transcript markers (or drop them); an unchanged plan key is a no-op. */
  async plan(
    dataset: SpatialDataset,
    view: SpatialViewState,
    rect: DataRect,
    pxPerUnit: number,
    ctx: PlanContext,
  ): Promise<void> {
    const mode = view.transcriptMode;
    const job = this.jobs.jobFor(dataset, view, rect, pxPerUnit);
    if (!job) {
      this.groups.drop('transcripts');
      this.hover.clear();
      this.countSource = null;
      return;
    }
    const planKey = transcriptPlanKey(dataset, view, job, pxPerUnit);
    if (planKey === this.groups.key('transcripts') && this.groups.shown('transcripts')) {
      return;
    }
    const loaded = await ctx.track('Transcripts', job.load(ctx));
    if (ctx.stale()) return;
    // Per-gene counts in view come from what was loaded, before hidden genes are dropped:
    // a hidden gene still has transcripts there. Summed density grids (no per-gene levels,
    // zoomed out) hold clusters, not genes: no per-gene counts there, rather than a guess.
    // Every gene's individual transcripts are counted by the dataset's gene list, when it has one.
    const allGeneNames = dataset.transcriptTiles?.genes;
    const loadedKind = loaded.kind ?? job.kind;
    this.countSource =
      loadedKind === 'genes' && !loaded.clustered
        ? { merged: loaded.merged, genes: [...view.transcriptGenes] }
        : loadedKind === 'individual' && allGeneNames
          ? { merged: loaded.merged, genes: allGeneNames }
          : null;
    const hidden = await this.lookup.hiddenCodes(dataset, view);
    if (ctx.stale()) return;
    // Density-grid markers carry no cells and were built from the visible genes only.
    const filtered = loaded.clustered
      ? { merged: loaded.merged, px: loaded.px }
      : filterTranscripts(
          loaded.merged,
          loaded.px,
          hidden,
          loadedKind === 'genes'
            ? hiddenGeneSlots(view)
            : loadedKind === 'individual'
              ? hiddenAllGeneCodes(view, allGeneNames)
              : null,
        );
    let { merged, px } = filtered;
    let selectionBin: number | null = loaded.clustered?.bin ?? null;
    let entryGroup: Int32Array | null = loaded.clustered?.group ?? null;
    let groupNames: string[] | null = loaded.clustered?.names ?? null;
    if (loaded.ladder) {
      const g = groupSelection(merged, view, loaded.ladder, pxPerUnit);
      if (g) ({ merged, px, bin: selectionBin, group: entryGroup, names: groupNames } = g);
    }
    const kind = loadedKind;
    const colorView = colorViewFor(view, kind, !!loaded.clustered, cellTypeColumnFor(dataset, view) !== null);
    // Each entry's cluster: its marker's group, or the gene-tree group its gene is in.
    const geneCluster = view.transcriptGenes.map(
      (g) => view.transcriptGeneGroups.find((x) => x.genes.includes(g))?.name ?? g,
    );
    const clusterOf = (i: number): string | null =>
      entryGroup && groupNames ? (groupNames[entryGroup[i]] ?? null) : (geneCluster[merged.gene[i]] ?? null);
    const rgba = await this.transcriptColors(dataset, colorView, merged, kind === 'genes' ? clusterOf : undefined);
    const typeColumn = cellTypeColumnFor(dataset, view);
    const types = typeColumn ? await this.lookup.codes(typeColumn).catch(() => null) : null;
    // Nothing is recorded before the last await: a superseded plan that had already keyed the
    // group would make the newer plan of the same view take the old layer for its own.
    if (ctx.stale()) return;

    if (ctx.incomplete) this.groups.forgetKey('transcripts');
    else this.groups.setKey('transcripts', planKey);
    const diam = px.map((d) => d / pxPerUnit);
    const ref = dataset.imageRef;
    const place: Placement = { scale: ref?.scale ?? [1, 1], translate: ref?.translate ?? [0, 0] };
    const layer =
      mode === 'circles'
        ? // A dark rim: a transcript coloured by its cell's type is otherwise the same colour as
          // the cell fill it sits on, and vanishes into it.
          this.drawTranscripts(merged, diam, rgba, view, place, null, 0.18 * median(diam))
        : this.drawTranscriptGlyphs(merged, diam, rgba, view, place, pxPerUnit);
    this.hover.setDrawn(
      {
        kind: loaded.kind ?? job.kind,
        bin: selectionBin
          ? { size: selectionBin, origin: loaded.clustered?.origin ?? [0, 0] }
          : loaded.kind
            ? loaded.bin
            : job.bin,
        merged,
        layer,
        genes: loadedKind === 'individual' ? (allGeneNames ?? []) : [...view.transcriptGenes],
        ...(entryGroup && groupNames ? { entryGroup, groupNames } : {}),
        ...(loaded.clustered ? { groupGenes: loaded.clustered.genes } : {}),
      },
      dataset.micronsPerUnit ?? null,
    );
    this.hover.setTypes(types);
  }

  /**
   * Gene icons: each entry drawn as its gene's napari-js point symbol, in the same one points
   * layer as the circles. With every gene drawn there is one icon for all of them — 18,000
   * shapes would say nothing.
   */
  private drawTranscriptGlyphs(
    merged: SpatialTranscriptTile,
    diam: Float32Array,
    rgba: Float32Array,
    view: SpatialViewState,
    place: Placement,
    pxPerUnit: number,
  ): PointsLayer {
    const genes = view.transcriptGenes;
    const glyphFor = (slot: number): TranscriptGlyph =>
      (view.transcriptGlyphs[genes[slot]] as TranscriptGlyph | undefined) ?? defaultGlyphFor(slot);
    const single = view.transcriptAllGenes
      ? ((view.transcriptGlyphs[ALL_GENES] as TranscriptGlyph | undefined) ?? 'circle')
      : null;
    const slots = single ? [single] : genes.map((_g, slot) => glyphFor(slot));
    const codes = slots.map((g) => pointSymbolCode(GLYPH_SYMBOLS[g]));
    const sizes = slots.map((g) => GLYPH_SIZE[g] ?? 1);
    const symbols = new Uint8Array(merged.count);
    const size = new Float32Array(merged.count);
    for (let i = 0; i < merged.count; i++) {
      const slot = single ? 0 : merged.gene[i];
      symbols[i] = codes[slot];
      size[i] = diam[i] * sizes[slot];
    }
    // A dark rim, one screen pixel wide, keeps a few large icons readable over the tissue; on
    // many small ones the rims merge into a solid dark sheet that hides every colour, so they
    // are left off.
    const medianPx = median(diam) * pxPerUnit;
    const rim = merged.count > GLYPH_OUTLINE_MAX || medianPx < GLYPH_OUTLINE_MIN_PX ? 0 : 1 / pxPerUnit;
    return this.drawTranscripts(merged, size, rgba, view, place, symbols, rim);
  }

  /**
   * The one transcripts layer: a marker per entry, `size` saying how many transcripts it stands
   * for, drawn as the layer's disc or as each entry's `symbols` code.
   */
  private drawTranscripts(
    merged: SpatialTranscriptTile,
    size: Float32Array,
    rgba: Float32Array,
    view: SpatialViewState,
    { scale, translate }: Placement,
    symbols: Uint8Array | null,
    borderWidth: number,
  ): PointsLayer {
    const positions = new Float32Array(merged.count * 2);
    for (let i = 0; i < merged.count; i++) {
      positions[2 * i] = merged.x[i];
      positions[2 * i + 1] = merged.y[i];
    }
    const layer = this.groups.viewer!.addPoints(positions, {
      name: 'transcripts',
      size,
      faceColor: rgba,
      borderColor: RIM_COLOR,
      borderWidth,
      symbols,
      opacity: view.transcriptOpacity,
      scale,
      translate,
    });
    this.groups.replace('transcripts', layer);
    return layer;
  }

  /** Per-entry colours, as packed RGBA. */
  private async transcriptColors(
    dataset: SpatialDataset,
    view: SpatialViewState,
    t: SpatialTranscriptTile,
    clusterOf?: (i: number) => string | null,
  ): Promise<Float32Array> {
    let rgb: Rgb[];
    let codeOf: (i: number) => number;
    if (view.transcriptColorBy === 'cluster' && clusterOf) {
      // A cluster named like a group of the cells' grouping takes that group's colour, so a
      // cluster's transcripts and its cells agree; any other cluster takes a palette colour.
      const name = cellTypeColumnFor(dataset, view);
      const codes = name ? await this.lookup.codes(name).catch(() => null) : null;
      const cellColor = new Map<string, string>();
      if (codes?.meta.kind === 'categorical') {
        const colors = resolveCategoryColors(codes.meta);
        codes.meta.categories.forEach((c, k) => cellColor.set(c, colors[k]));
      }
      const colors = clusterColorMap(
        view.transcriptGenes,
        view.transcriptGeneGroups,
        cellColor,
        DEFAULT_CATEGORICAL_PALETTE,
      );
      const index = new Map<string, number>();
      const hex: string[] = [];
      const codeFor = (cluster: string) => {
        let k = index.get(cluster);
        if (k === undefined) {
          k = hex.length;
          index.set(cluster, k);
          hex.push(colors.get(cluster) ?? cellColor.get(cluster) ?? DEFAULT_CATEGORICAL_PALETTE[0]);
        }
        return k;
      };
      const code = new Int32Array(t.count);
      for (let i = 0; i < t.count; i++) {
        const c = clusterOf(i);
        code[i] = c === null ? -1 : codeFor(c);
      }
      rgb = hex.map(parseHex);
      codeOf = (i) => code[i];
    } else if (view.transcriptColorBy === 'gene' || view.transcriptColorBy === 'cluster') {
      // All genes: codes are the dataset's gene indices, coloured by name when the dataset
      // lists them (so a gene's chosen colour applies), else folded onto the palette.
      const names = view.transcriptAllGenes ? (dataset.transcriptTiles?.genes ?? null) : view.transcriptGenes;
      const n = names ? names.length : DEFAULT_CATEGORICAL_PALETTE.length;
      rgb = Array.from({ length: n }, (_g, i) =>
        parseHex(
          (names && view.transcriptGeneColors[names[i]]) ||
            DEFAULT_CATEGORICAL_PALETTE[i % DEFAULT_CATEGORICAL_PALETTE.length],
        ),
      );
      codeOf = names ? (i) => (t.gene[i] < n ? t.gene[i] : -1) : (i) => t.gene[i] % n;
    } else {
      const name = cellTypeColumnFor(dataset, view);
      const codes = name ? await this.lookup.codes(name) : null;
      rgb = codes?.meta.kind === 'categorical' ? resolveCategoryColors(codes.meta).map(parseHex) : [];
      codeOf = (i) => {
        const o = t.observation[i];
        if (!codes || o === NO_OBSERVATION) return -1;
        const c = codes.codes[o];
        return c === NO_CATEGORY ? -1 : c;
      };
    }
    const rgba = new Float32Array(t.count * 4);
    const tuples: RGBA[] = rgb.map(([r, g, b]) => [r / 255, g / 255, b / 255, 1]);
    for (let i = 0; i < t.count; i++) {
      const c = codeOf(i);
      rgba.set(c < 0 ? UNASSIGNED_RGBA : tuples[c], i * 4);
    }
    return rgba;
  }
}
