/**
 * Narrowing a gene list to the handful a picker should actually render.
 *
 * A targeted panel has a few hundred genes and can simply be listed. A
 * whole-transcriptome assay has ~18k-31k, and handing that many options to a dropdown
 * costs a visible freeze on every keystroke — the control rebuilds and re-filters the
 * whole array, and the browser lays out what the virtual scroller has not yet clipped.
 * Measured on the Visium H&E bundle: 18,078 names.
 *
 * The names themselves are cheap to hold — strings already parsed from the manifest — so
 * this does not fetch anything. What it caps is how many OPTION OBJECTS are ever
 * materialised for the view. The rest of the corpus stays a plain array, searched per
 * keystroke, which is the work a dropdown was doing anyway; the saving is in not asking
 * a component to render, diff and re-filter thousands of rows it will never show.
 *
 * Ranking is PREFIX FIRST, then substring. Typing "Mb" should surface `Mbp` above
 * `Adam1b`, which a plain `includes` would not do. It deliberately mirrors the example
 * server's `/spatial/:id/features?q=` (see `lib/spatial.mjs`) so a dataset that inlines
 * its names and one that does not order their suggestions the same way — the picker must
 * not appear to rank differently depending on how the data happens to be served.
 *
 * Pure — no Angular, no port, no DOM — like `spatial-heatmap.ts`, and tested the same way.
 */

/**
 * How many options a picker will materialise at once.
 *
 * Above the virtual-scroll threshold, so a capped list is still scrolled rather than laid
 * out in full, and far below the point where rebuilding the array is perceptible.
 */
export const GENE_OPTIONS_MAX = 500;

/**
 * The best `limit` matches for `query`, prefix matches first.
 *
 * An empty query returns the head of the list rather than nothing: the dropdown opens
 * before anything is typed, and an empty menu reads as "no genes" rather than "start
 * typing". Matching is case-insensitive, because gene symbols are capitalised by
 * convention and nobody types `Slc17a7` exactly.
 */
export function searchGeneNames(
  names: readonly string[],
  query: string,
  limit = GENE_OPTIONS_MAX,
): string[] {
  if (limit <= 0) return [];
  const q = query.trim().toLowerCase();
  if (!q) return names.slice(0, limit);

  const prefix: string[] = [];
  const contains: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.startsWith(q)) {
      prefix.push(name);
      // Enough prefix matches to fill the list: nothing a substring match could add
      // would outrank them, so the rest of the corpus cannot change the answer.
      if (prefix.length >= limit) return prefix;
    } else if (lower.includes(q) && contains.length < limit) {
      contains.push(name);
    }
  }
  return [...prefix, ...contains].slice(0, limit);
}

/**
 * The options a picker should show: the best matches, plus anything already chosen.
 *
 * A multi-select whose option list is capped must still carry its SELECTED values, or the
 * control cannot resolve them — the chips lose their labels and, worse, a value absent
 * from the options can be dropped from the model on the next change. Selections come
 * first so they stay visible while a search narrows everything else.
 */
export function geneOptionsFor(
  names: readonly string[],
  query: string,
  selected: readonly string[] = [],
  limit = GENE_OPTIONS_MAX,
): string[] {
  const matches = searchGeneNames(names, query, limit);
  if (selected.length === 0) return matches;
  const seen = new Set(selected);
  return [...selected, ...matches.filter((n) => !seen.has(n))];
}
