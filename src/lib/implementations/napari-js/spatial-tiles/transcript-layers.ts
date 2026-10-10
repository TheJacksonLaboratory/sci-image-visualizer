import { Colormap } from 'napari-js';
import type { RGBA } from 'napari-js';

import type { Rgb } from '../../../contracts/colormap-lut';
import { ALL_GENES } from '../../../contracts/ports/spatial-data.port';
import type { SpatialViewState } from '../../../contracts/display-types';
import {
  NO_CATEGORY, NO_OBSERVATION, SpatialDataset, SpatialTranscriptTile,
} from '../../../contracts/spatial-dataset.contract';
import {
  DEFAULT_CATEGORICAL_PALETTE, MISSING_COLOR, parseHex, resolveCategoryColors,
} from '../../../spatial/spatial-encoding';
import { DataRect, cellTypeColumnFor } from '../../../spatial/lod';
import { clusterColorMap } from '../../../spatial/transcript-grouping';
import { TranscriptGlyph, defaultGlyphFor, glyphOutline, glyphRings } from '../../../spatial/glyphs';
import { discreteColormapStops } from '../../../spatial/density-raster';
import { filterTranscripts, hiddenGeneSlots, median } from '../../../spatial/spatial-tile-merge';
import type { CategoricalLookup } from './categorical-lookup';
import type { OrderedLayerGroups, TileGroup } from './layer-groups';
import type { PlanContext } from './plan-context';
import type { TranscriptHover } from './transcript-hover';
import { type TranscriptJobPlanner, groupSelection } from './transcript-jobs';

/** Icons get a dark rim only while there are at most this many, at least this big (px). */
const GLYPH_OUTLINE_MAX = 20_000;
const GLYPH_OUTLINE_MIN_PX = 8;

/** Where a layer sits in world space: the dataset's affine onto its tissue image. */
interface Placement { scale: [number, number]; translate: [number, number] }

/** Transcript colours: per-entry RGBA for points, values + colormap for shapes. */
interface TranscriptFaces { rgba: RGBA[]; values: Float32Array; colormap: Colormap }

const UNASSIGNED_RGBA: RGBA = [0.62, 0.62, 0.62, 0.55];

/**
 * The transcript markers of the 2D spatial view: runs the planner's job, drops hidden groups
 * and genes, groups a selection under the marker budget, colours the entries and draws them as
 * sized circles or gene icons (with a dark rim while there are few enough).
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
    dataset: SpatialDataset, view: SpatialViewState, rect: DataRect, pxPerUnit: number,
    ctx: PlanContext,
  ): Promise<void> {
    const mode = view.transcriptMode;
    const job = this.jobs.jobFor(dataset, view, rect, pxPerUnit);
    if (!job) {
      this.groups.drop('transcripts');
      this.groups.drop('transcriptOutline');
      this.hover.clear();
      this.countSource = null;
      return;
    }
    // Marker sizes follow the zoom, so the zoom is part of the key; a pan that keeps
    // the same tiles on screen changes nothing.
    const planKey = [
      dataset.id, mode, job.key, view.transcriptColorBy, cellTypeColumnFor(dataset, view),
      view.transcriptScale, view.transcriptOpacity, JSON.stringify(view.transcriptGlyphs),
      pxPerUnit.toPrecision(4), view.hiddenGroups.join('\u0001'), view.transcriptHiddenGenes.join(','),
      JSON.stringify(view.transcriptGeneColors), JSON.stringify(view.transcriptGeneGroups),
    ].join('|');
    if (planKey === this.groups.key('transcripts') && this.groups.shown('transcripts')) {
      return;
    }
    const loaded = await ctx.track('Transcripts', job.load(ctx));
    if (ctx.stale()) return;
    // Per-gene counts in view come from what was loaded, before hidden genes are dropped:
    // a hidden gene still has transcripts there. Summed density grids (no per-gene levels,
    // zoomed out) hold clusters, not genes: no per-gene counts there, rather than a guess.
    this.countSource = (loaded.kind ?? job.kind) === 'genes' && !loaded.clustered
      ? { merged: loaded.merged, genes: [...view.transcriptGenes] } : null;
    const hidden = await this.lookup.hiddenCodes(dataset, view);
    if (ctx.stale()) return;
    // Density-grid markers carry no cells and were built from the visible genes only.
    const filtered = loaded.clustered ? { merged: loaded.merged, px: loaded.px }
      : filterTranscripts(loaded.merged, loaded.px, hidden,
        (loaded.kind ?? job.kind) === 'genes' ? hiddenGeneSlots(view) : null);
    let { merged, px } = filtered;
    let selectionBin: number | null = loaded.clustered?.bin ?? null;
    let entryGroup: Int32Array | null = loaded.clustered?.group ?? null;
    let groupNames: string[] | null = loaded.clustered?.names ?? null;
    if (loaded.ladder) {
      const g = groupSelection(merged, view, loaded.ladder, pxPerUnit);
      if (g) ({ merged, px, bin: selectionBin, group: entryGroup, names: groupNames } = g);
    }
    // A bin of the all-gene pyramid mixes genes and carries none, so it cannot be coloured
    // by gene: colour it by its dominant cell's type until individual transcripts show.
    const kind = loaded.kind ?? job.kind;
    const colorView = kind === 'bins' && view.transcriptColorBy !== 'cellType'
      ? { ...view, transcriptColorBy: 'cellType' as const }
      // Density-grid markers have no cell to take a type from: they take their cluster's colour.
      : loaded.clustered && view.transcriptColorBy === 'cellType'
        ? { ...view, transcriptColorBy: 'cluster' as const } : view;
    // Each entry's cluster: its marker's group, or the gene-tree group its gene is in.
    const geneCluster = view.transcriptGenes.map((g) =>
      view.transcriptGeneGroups.find((x) => x.genes.includes(g))?.name ?? g);
    const clusterOf = (i: number): string | null => (entryGroup && groupNames
      ? groupNames[entryGroup[i]] ?? null
      : geneCluster[merged.gene[i]] ?? null);
    const faces = await this.transcriptColors(dataset, colorView, merged, kind === 'genes' ? clusterOf : undefined);
    if (ctx.stale()) return;

    if (ctx.incomplete) this.groups.forgetKey('transcripts');
    else this.groups.setKey('transcripts', planKey);
    const diam = px.map((d) => d / pxPerUnit);
    this.hover.setDrawn({
      kind: loaded.kind ?? job.kind,
      bin: selectionBin ? { size: selectionBin, origin: loaded.clustered?.origin ?? [0, 0] }
        : (loaded.kind ? loaded.bin : job.bin),
      merged, radius: diam.map((d) => d / 2),
      genes: [...view.transcriptGenes], ref: dataset.imageRef ?? null, grid: null,
      ...(entryGroup && groupNames ? { entryGroup, groupNames } : {}),
      ...(loaded.clustered ? { groupGenes: loaded.clustered.genes } : {}),
    }, dataset.micronsPerUnit ?? null);
    const typeColumn = cellTypeColumnFor(dataset, view);
    this.hover.setTypes(typeColumn ? await this.lookup.codes(typeColumn).catch(() => null) : null);
    if (ctx.stale()) return;
    const ref = dataset.imageRef;
    const place: Placement = { scale: ref?.scale ?? [1, 1], translate: ref?.translate ?? [0, 0] };
    if (mode === 'circles') {
      this.groups.drop('transcriptOutline');
      this.drawTranscriptCircles(merged, diam, faces.rgba, view, place);
    } else {
      this.drawTranscriptGlyphs(merged, diam, faces, view, place, pxPerUnit);
    }
  }

  /** One sized circle per entry, the size saying how many transcripts it stands for. */
  private drawTranscriptCircles(
    merged: SpatialTranscriptTile, diam: Float32Array, rgba: RGBA[], view: SpatialViewState,
    { scale, translate }: Placement,
  ): void {
    const positions = new Float32Array(merged.count * 2);
    for (let i = 0; i < merged.count; i++) {
      positions[2 * i] = merged.x[i];
      positions[2 * i + 1] = merged.y[i];
    }
    const layer = this.groups.viewer!.addPoints(positions, {
      name: 'transcripts',
      size: diam,
      faceColor: rgba,
      // A dark rim: a transcript coloured by its cell's type is otherwise the same
      // colour as the cell fill it sits on, and vanishes into it.
      borderColor: [0.04, 0.04, 0.05, 0.9],
      borderWidth: 0.18 * median(diam),
      opacity: view.transcriptOpacity,
      scale,
      translate,
    });
    this.groups.replace('transcripts', layer);
  }

  private drawTranscriptGlyphs(
    merged: SpatialTranscriptTile, diam: Float32Array, faces: TranscriptFaces, view: SpatialViewState,
    { scale, translate }: Placement, pxPerUnit: number,
  ): void {
    // Glyphs: each entry becomes its gene's icon polygon, filled through a discrete
    // colormap and outlined dark so small icons stay readable over the tissue. With every
    // gene drawn there is one icon for all of them — 18,000 shapes would say nothing.
    const genes = view.transcriptGenes;
    const glyphFor = (slot: number): TranscriptGlyph =>
      (view.transcriptGlyphs[genes[slot]] as TranscriptGlyph | undefined) ?? defaultGlyphFor(slot);
    const single = view.transcriptAllGenes
      ? glyphOutline((view.transcriptGlyphs[ALL_GENES] as TranscriptGlyph | undefined) ?? 'circle')
      : null;
    const outlines = single ? [] : genes.map((_g, slot) => glyphOutline(glyphFor(slot)));
    const radius = diam.map((d) => d / 2);
    const { coords, offsets } = glyphRings(
      merged.x, merged.y, radius, (i) => single ?? outlines[merged.gene[i]],
    );
    const fill = this.groups.viewer!.addShapes(coords, offsets, {
      name: 'transcripts',
      draw: 'fill',
      values: faces.values,
      colormap: faces.colormap,
      contrastLimits: [0, 1],
      opacity: view.transcriptOpacity,
      scale,
      translate,
    });
    this.groups.replace('transcripts', fill);
    // A dark rim keeps a few large icons readable over the tissue; on many small ones the
    // rims merge into a solid dark sheet that hides every colour, so they are left off.
    const medianPx = median(diam) * pxPerUnit;
    if (merged.count > GLYPH_OUTLINE_MAX || medianPx < GLYPH_OUTLINE_MIN_PX) {
      this.groups.drop('transcriptOutline');
      return;
    }
    const edge = this.groups.viewer!.addShapes(coords, offsets, {
      name: 'transcript outlines',
      draw: 'outline',
      color: [0.05, 0.05, 0.05, 1],
      opacity: Math.min(1, view.transcriptOpacity + 0.1),
      scale,
      translate,
    });
    this.groups.replace('transcriptOutline', edge);
  }

  /** Per-entry colours both as RGBA (points) and as colormap values (glyph shapes). */
  private async transcriptColors(
    dataset: SpatialDataset, view: SpatialViewState, t: SpatialTranscriptTile,
    clusterOf?: (i: number) => string | null,
  ): Promise<TranscriptFaces> {
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
      const colors = clusterColorMap(view.transcriptGenes, view.transcriptGeneGroups, cellColor,
        DEFAULT_CATEGORICAL_PALETTE);
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
      // All genes: codes are the dataset's gene indices, folded onto the palette.
      const n = view.transcriptAllGenes ? DEFAULT_CATEGORICAL_PALETTE.length : view.transcriptGenes.length;
      rgb = Array.from({ length: n }, (_g, i) => parseHex(
        (!view.transcriptAllGenes && view.transcriptGeneColors[view.transcriptGenes[i]])
        || DEFAULT_CATEGORICAL_PALETTE[i % DEFAULT_CATEGORICAL_PALETTE.length]));
      codeOf = view.transcriptAllGenes ? (i) => t.gene[i] % n : (i) => t.gene[i];
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
    const { stops, valueOf } = discreteColormapStops(rgb, MISSING_COLOR);
    const rgba: RGBA[] = new Array(t.count);
    const values = new Float32Array(t.count);
    const tuples: RGBA[] = rgb.map(([r, g, b]) => [r / 255, g / 255, b / 255, 1]);
    for (let i = 0; i < t.count; i++) {
      const c = codeOf(i);
      rgba[i] = c < 0 ? UNASSIGNED_RGBA : tuples[c];
      values[i] = valueOf(c);
    }
    return { rgba, values, colormap: new Colormap('transcript-categories', stops) };
  }
}
