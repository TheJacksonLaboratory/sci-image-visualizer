import type { SpatialViewState } from '../contracts/display-types';

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
