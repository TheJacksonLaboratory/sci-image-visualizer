import type { SpatialViewState, TranscriptGlyphName } from '../contracts/display-types';
import { NO_CATEGORY } from '../contracts/spatial-dataset.contract';
import { DEFAULT_CATEGORICAL_PALETTE } from './spatial-encoding';

/** One gene's value for every observation: the port's `getFeatureVector`. */
export type FeatureVectorSource = (gene: string) => Promise<Float32Array>;

type GeneFilterView = Pick<SpatialViewState, 'observationGenes' | 'observationGenesMatch'>;

/** Whether the view draws only the observations expressing some genes. */
export function hasGeneFilter(view: Partial<GeneFilterView>): boolean {
  return !!view.observationGenes?.length;
}

/** What decides the gene filter, for the layers' cache keys: '' when there is none. */
export function geneFilterKey(view: Partial<GeneFilterView>): string {
  if (!hasGeneFilter(view)) return '';
  return `${view.observationGenesMatch ?? 'any'}:${view.observationGenes!.join('\u0001')}`;
}

/**
 * 1 for each of `count` observations that expresses the genes — a value above 0 in any of
 * `vectors`, or in all of them — else 0. A missing value (NaN) is not expressed.
 */
export function expressingMask(vectors: readonly Float32Array[], count: number, match: 'any' | 'all'): Uint8Array {
  const mask = new Uint8Array(count);
  if (!vectors.length) return mask;
  if (match === 'all') {
    mask.fill(1);
    for (const v of vectors) {
      for (let i = 0; i < count; i++) if (!(v[i] > 0)) mask[i] = 0;
    }
  } else {
    for (const v of vectors) {
      for (let i = 0; i < count; i++) if (v[i] > 0) mask[i] = 1;
    }
  }
  return mask;
}

/** The last mask built, reused while the same vectors (the port caches them) and rule ask again. */
let last: { vectors: readonly Float32Array[]; match: 'any' | 'all'; count: number; mask: Uint8Array } | null =
  null;

/**
 * The view's gene filter as a per-observation mask (1 = drawn), or null when it has none. Every
 * layer asks on every rebuild, so the mask of the same vectors is built once.
 */
export async function observationGeneMask(
  view: GeneFilterView,
  count: number,
  read: FeatureVectorSource,
): Promise<Uint8Array | null> {
  if (!hasGeneFilter(view)) return null;
  const vectors = await Promise.all(view.observationGenes.map((g) => read(g)));
  const match = view.observationGenesMatch ?? 'any';
  if (
    last &&
    last.match === match &&
    last.count === count &&
    last.vectors.length === vectors.length &&
    last.vectors.every((v, i) => v === vectors[i])
  ) {
    return last.mask;
  }
  const mask = expressingMask(vectors, count, match);
  last = { vectors, match, count, mask };
  return mask;
}

/** The colour a gene of the observation filter is drawn in: the view's own, else the palette's
 *  for its place in the list. */
export function observationGeneColor(
  view: Pick<SpatialViewState, 'observationGenes' | 'observationGeneColors'>,
  gene: string,
): string {
  const own = view.observationGeneColors?.[gene];
  if (own) return own;
  const at = Math.max(0, view.observationGenes.indexOf(gene));
  return DEFAULT_CATEGORICAL_PALETTE[at % DEFAULT_CATEGORICAL_PALETTE.length];
}

/** The icon a gene of the observation filter is drawn as (2D): the view's own, else a circle. */
export function observationGeneGlyph(
  view: Pick<SpatialViewState, 'observationGeneGlyphs'>,
  gene: string,
): TranscriptGlyphName {
  return view.observationGeneGlyphs?.[gene] ?? 'circle';
}

/** Whether the filtered observations are coloured by their gene (rather than by `colorBy`). */
export function colorsByObservationGene(
  view: Pick<SpatialViewState, 'observationGenes' | 'observationGenesColorBy'>,
): boolean {
  return hasGeneFilter(view) && view.observationGenesColorBy !== false;
}

/**
 * Each observation's gene among `vectors`: the index of the one it expresses most relative to
 * that gene's own highest value — so a gene expressed at low counts everywhere is not always
 * outvoted by a highly expressed one — or {@link NO_CATEGORY} where it expresses none.
 */
export function dominantGenes(vectors: readonly Float32Array[], count: number): Uint16Array {
  const out = new Uint16Array(count).fill(NO_CATEGORY);
  const best = new Float32Array(count);
  vectors.forEach((v, g) => {
    let max = 0;
    for (let i = 0; i < count; i++) if (v[i] > max) max = v[i];
    if (!(max > 0)) return;
    for (let i = 0; i < count; i++) {
      const r = v[i] / max;
      if (r > 0 && r > best[i]) {
        best[i] = r;
        out[i] = g;
      }
    }
  });
  return out;
}

/** The last codes built, reused while the same vectors ask again (as for the mask). */
let lastCodes: { vectors: readonly Float32Array[]; count: number; codes: Uint16Array } | null = null;

/**
 * How the filtered observations are drawn, by gene: each observation's gene (an index into the
 * view's genes, see {@link dominantGenes}) with the genes' colours and icons. Null when the view
 * does not colour by them.
 */
export async function observationGeneStyle(
  view: GeneFilterView &
    Pick<SpatialViewState, 'observationGenesColorBy' | 'observationGeneColors' | 'observationGeneGlyphs'>,
  count: number,
  read: FeatureVectorSource,
): Promise<{ codes: Uint16Array; colors: string[]; glyphs: TranscriptGlyphName[] } | null> {
  if (!colorsByObservationGene(view)) return null;
  const vectors = await Promise.all(view.observationGenes.map((g) => read(g)));
  let codes: Uint16Array;
  if (
    lastCodes &&
    lastCodes.count === count &&
    lastCodes.vectors.length === vectors.length &&
    lastCodes.vectors.every((v, i) => v === vectors[i])
  ) {
    codes = lastCodes.codes;
  } else {
    codes = dominantGenes(vectors, count);
    lastCodes = { vectors, count, codes };
  }
  return {
    codes,
    colors: view.observationGenes.map((g) => observationGeneColor(view, g)),
    glyphs: view.observationGenes.map((g) => observationGeneGlyph(view, g)),
  };
}

/** What decides how the filtered observations are drawn by gene, for cache keys. */
export function observationGeneStyleKey(
  view: Pick<
    SpatialViewState,
    'observationGenes' | 'observationGenesColorBy' | 'observationGeneColors' | 'observationGeneGlyphs'
  >,
): string {
  if (!colorsByObservationGene(view)) return '';
  return view.observationGenes
    .map((g) => `${g}=${observationGeneColor(view, g)}/${observationGeneGlyph(view, g)}`)
    .join('\u0001');
}
