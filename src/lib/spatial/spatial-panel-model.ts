import type {
  CategoricalColumnMeta,
  SpatialColumnMeta,
  SpatialDataset,
  SpatialMarkerGenes,
} from '../contracts/spatial-dataset.contract';
import type { SpatialCategoricalView } from '../contracts/visualizer.contract';
import type { ColormapValue, SpatialViewState, TranscriptGlyphName } from '../contracts/display-types';
import type { Rgb } from '../contracts/colormap-lut';
import { lutFor, spatialContinuousLut } from './spatial-encoding';
import { INFERNO_SCALE, TRANSCRIPT_GLYPHS, glyphOutline } from './spatial-tiles';

/**
 * Pure model of the spatial-omics panel: the option lists, rows and patches its controls
 * show and write, as functions of the dataset and the view. No Angular and no state, so
 * every rule here is unit-tested without a TestBed and shared by whichever panel shows it.
 */

/** A labelled dropdown option. */
export interface PanelOption<T> {
  label: string;
  value: T;
}

/** A gene name as a dropdown option. Objects rather than bare strings because the
 *  dropdown filters on a named field (`filterBy="label"`), which a string has not. */
export function geneOption(name: string): PanelOption<string> {
  return { label: name, value: name };
}

/** A transcript glyph choice, with an SVG `points` string for its preview. */
export interface GlyphOption extends PanelOption<TranscriptGlyphName> {
  points: string;
}

/** Glyph choices with an SVG `points` string for the preview. */
export const GLYPH_OPTIONS: GlyphOption[] = TRANSCRIPT_GLYPHS.map((g) => {
  const o = glyphOutline(g);
  const pts: string[] = [];
  for (let i = 0; i < o.length; i += 2) pts.push(`${o[i].toFixed(3)},${o[i + 1].toFixed(3)}`);
  return { label: g.replace('-', ' '), value: g as TranscriptGlyphName, points: pts.join(' ') };
});

/** The preview outline of `glyph`, or `''` for an unknown one. */
export function glyphPoints(glyph: TranscriptGlyphName): string {
  return GLYPH_OPTIONS.find((o) => o.value === glyph)?.points ?? '';
}

/** Outlier clipping presets, as `[lo, hi]` percentile fractions. */
export const CLIP_OPTIONS: PanelOption<[number, number]>[] = [
  { label: 'None', value: [0, 1] },
  { label: '1%', value: [0.01, 0.99] },
  { label: '2%', value: [0.02, 0.98] },
  { label: '5%', value: [0.05, 0.95] },
];

/**
 * `group,gene` rows (CSV or TSV, header optional) → gene groups, in file order.
 */
export function parseGeneGroups(text: string): { name: string; genes: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const [a, b] = line.split(/,|\t/).map((f) => f.trim().replace(/^"|"$/g, ''));
    if (!a || !b || (/^(group|cell_?type|name)$/i.test(a) && /^(gene|genes|feature)$/i.test(b))) continue;
    const list = groups.get(a) ?? [];
    if (!list.includes(b)) list.push(b);
    groups.set(a, list);
  }
  return [...groups].map(([name, genes]) => ({ name, genes }));
}

/** `name — 2 categories` / `name — counts`: a column as the pickers list it. */
export function columnLabel(c: SpatialColumnMeta): string {
  const kind =
    c.kind === 'categorical'
      ? `${(c as CategoricalColumnMeta).categories.length} categories`
      : (c.unit ?? 'continuous');
  return `${c.name} — ${kind}`;
}

/** A categorical column's label in the group pickers: its description where it is a
 *  sectioned (derived) grouping, its name and size otherwise. */
function groupLabel(c: CategoricalColumnMeta): string {
  return c.description && c.section ? c.description : columnLabel(c);
}

/** Colour-by column choices — "None" plus every column the dataset declares. */
export function columnOptions(ds: SpatialDataset | null): PanelOption<string | null>[] {
  return [
    { label: 'None (flat colour)', value: null },
    ...(ds?.columns ?? []).map((c) => ({ label: columnLabel(c), value: c.name })),
  ];
}

/** The option lists of the cell and transcript controls, which depend on the dataset only. */
export interface TileOptions {
  cellSetOptions: PanelOption<string>[];
  transcriptModeOptions: PanelOption<SpatialViewState['transcriptMode']>[];
  cellColorOptions: PanelOption<SpatialViewState['cellColorMode']>[];
}

/** {@link TileOptions} for `ds`: short labels, cell set first, "Both" when there are two —
 *  as Xenium Explorer. */
export function tileOptions(ds: SpatialDataset | null): TileOptions {
  const sets = [...(ds?.polygonTiles?.sets ?? [])].sort((a, b) =>
    a.name === 'cell' ? -1 : b.name === 'cell' ? 1 : 0,
  );
  const has = (name: string) => !!ds?.columns.some((c) => c.name === name);
  return {
    cellSetOptions: [
      ...sets.map((s) => ({ label: s.label.replace(/\s*boundar(y|ies)$/i, ''), value: s.name })),
      ...(sets.length > 1 ? [{ label: 'Both', value: 'both' }] : []),
    ],
    transcriptModeOptions: [
      ...(ds?.transcriptTiles
        ? [
            { label: 'Points', value: 'circles' as const },
            { label: 'Icons', value: 'glyphs' as const },
          ]
        : []),
      ...(ds?.density ? [{ label: 'Density Map', value: 'density' as const }] : []),
    ],
    cellColorOptions: [
      { label: 'Group Affiliation', value: 'group' },
      ...(ds?.features ? [{ label: 'Gene Expression', value: 'gene' as const }] : []),
      ...(has('transcript_density')
        ? [{ label: 'Transcript Density Map', value: 'transcriptDensity' as const }]
        : []),
      { label: 'Single Color', value: 'single' },
      ...(has('segmentation_method') ? [{ label: 'Segmentation Method', value: 'segmentation' as const }] : []),
    ],
  };
}

/** A section of the group picker. */
export interface GroupOptionSection {
  label: string;
  items: PanelOption<string>[];
}

/** The value the group picker uses for a family of columns. */
export const FAMILY_PREFIX = 'family:';

/**
 * The group picker: categorical columns under their section heading, a family of
 * variants (k-means at k = 2…10) listed once. Values are a column name, or
 * `family:<id>` for a family. The segmentation method is not a grouping of cells.
 */
export function groupOptions(ds: SpatialDataset | null): GroupOptionSection[] {
  const sections = new Map<string, PanelOption<string>[]>();
  const seenFamilies = new Set<string>();
  for (const c of ds?.columns ?? []) {
    if (c.kind !== 'categorical' || c.name === 'segmentation_method') continue;
    const section = c.section ?? 'Groups';
    const list = sections.get(section) ?? [];
    if (c.family) {
      if (seenFamilies.has(c.family.id)) continue;
      seenFamilies.add(c.family.id);
      list.push({ label: c.family.label, value: `${FAMILY_PREFIX}${c.family.id}` });
    } else {
      list.push({ label: groupLabel(c), value: c.name });
    }
    sections.set(section, list);
  }
  return [...sections].map(([label, items]) => ({ label, items }));
}

function categoricalMeta(ds: SpatialDataset | null, name: string | null): CategoricalColumnMeta | undefined {
  const meta = name ? ds?.columns.find((c) => c.name === name) : undefined;
  return meta?.kind === 'categorical' ? meta : undefined;
}

/** The group picker's value for the active group column: its family's entry, or itself. */
export function groupEntryFor(ds: SpatialDataset | null, column: string | null): string | null {
  const family = categoricalMeta(ds, column)?.family;
  return family ? `${FAMILY_PREFIX}${family.id}` : column;
}

/** The columns of family `id`, in dataset order. */
export function familyMembers(ds: SpatialDataset | null, id: string): CategoricalColumnMeta[] {
  return (ds?.columns ?? []).filter(
    (c): c is CategoricalColumnMeta => c.kind === 'categorical' && c.family?.id === id,
  );
}

/** Variants of the active column's family (k = 2…10), or none when it has no family. */
export function groupVariantOptions(ds: SpatialDataset | null, column: string | null): PanelOption<string>[] {
  const family = categoricalMeta(ds, column)?.family;
  return family ? familyMembers(ds, family.id).map((c) => ({ label: c.family!.variant, value: c.name })) : [];
}

/** One row of the groups list: a category with its colour and cell count. */
export interface GroupRow {
  label: string;
  color: string;
  count: number;
}

/** A grouping's categories with colours and cell counts, largest first, and their total. */
export function countGroupRows(v: Pick<SpatialCategoricalView, 'categories' | 'colors' | 'codes'>): {
  rows: GroupRow[];
  total: number;
} {
  const counts = new Uint32Array(v.categories.length);
  for (const c of v.codes) if (c < counts.length) counts[c]++;
  const rows = v.categories
    .map((label, i) => ({ label, color: v.colors[i] ?? '#999', count: counts[i] }))
    .sort((a, b) => b.count - a.count);
  return { rows, total: rows.reduce((n, r) => n + r.count, 0) };
}

/** `list` with `items` removed (`on`) or added (`!on`) — a hidden-set toggle. */
export function toggleHidden(list: readonly string[], items: readonly string[], on: boolean): string[] {
  const hidden = new Set(list);
  for (const item of items) {
    if (on) hidden.delete(item);
    else hidden.add(item);
  }
  return [...hidden];
}

/** One node of the selected-genes tree: a named gene group, or the ungrouped rest (`null`). */
export interface GeneTreeNode {
  name: string | null;
  genes: string[];
}

/** The selected genes as Explorer's tree: named groups, then the ungrouped ones. */
export function buildGeneTree(
  selected: readonly string[],
  groups: readonly { name: string; genes: readonly string[] }[],
): GeneTreeNode[] {
  const chosen = new Set(selected);
  const grouped = new Set<string>();
  const out: GeneTreeNode[] = [];
  for (const g of groups) {
    const genes = g.genes.filter((x) => chosen.has(x));
    if (!genes.length) continue;
    genes.forEach((x) => grouped.add(x));
    out.push({ name: g.name, genes });
  }
  const rest = selected.filter((x) => !grouped.has(x));
  if (rest.length) out.push({ name: null, genes: rest });
  return out;
}

/** Every categorical column but the segmentation method, which says nothing about genes. */
export function markerColumnOptions(columns: readonly SpatialColumnMeta[] | undefined): PanelOption<string>[] {
  return (columns ?? [])
    .filter((c): c is CategoricalColumnMeta => c.kind === 'categorical' && c.name !== 'segmentation_method')
    .map((c) => ({ label: groupLabel(c), value: c.name }));
}

/**
 * Each picked cluster's marker genes as a gene group named after it. A gene that marks
 * several clusters goes to the one it scores highest in, so the tree lists it once;
 * clusters left with no gene are dropped.
 */
export function markerGeneGroups(
  result: Pick<SpatialMarkerGenes, 'groups'>,
  picked: ReadonlySet<string>,
): { name: string; genes: string[] }[] {
  const best = new Map<string, { group: string; score: number }>();
  for (const g of result.groups) {
    if (!picked.has(g.name)) continue;
    for (const gene of g.genes) {
      const prev = best.get(gene.name);
      if (!prev || gene.score > prev.score) best.set(gene.name, { group: g.name, score: gene.score });
    }
  }
  return result.groups
    .filter((g) => picked.has(g.name))
    .map((g) => ({
      name: g.name,
      genes: g.genes.map((x) => x.name).filter((n) => best.get(n)?.group === g.name),
    }))
    .filter((g) => g.genes.length);
}

/** `groups` merged into the view's gene groups (replacing any of the same name). */
export function withGeneGroups(
  view: Pick<SpatialViewState, 'transcriptGeneGroups'>,
  groups: { name: string; genes: string[] }[],
): SpatialViewState['transcriptGeneGroups'] {
  const names = new Set(groups.map((g) => g.name));
  return [...view.transcriptGeneGroups.filter((g) => !names.has(g.name)), ...groups];
}

/**
 * The patch that adds marker groups: the groups, their genes appended to the selection,
 * transcripts coloured by cluster (as their cells are), and switched on when off.
 */
export function markerGenesPatch(
  view: Pick<SpatialViewState, 'transcriptGeneGroups' | 'transcriptGenes' | 'transcriptMode'>,
  groups: { name: string; genes: string[] }[],
): Partial<SpatialViewState> {
  const genes = [...view.transcriptGenes];
  for (const g of groups) for (const n of g.genes) if (!genes.includes(n)) genes.push(n);
  return {
    transcriptGeneGroups: withGeneGroups(view, groups),
    transcriptGenes: genes,
    transcriptColorBy: 'cluster',
    ...(view.transcriptMode === 'off' ? { transcriptMode: 'circles' as const } : {}),
  };
}

/** The patch that imports gene groups: the groups, and their genes added to the selection. */
export function importGeneGroupsPatch(
  view: Pick<SpatialViewState, 'transcriptGeneGroups' | 'transcriptGenes'>,
  groups: { name: string; genes: string[] }[],
): Partial<SpatialViewState> {
  return {
    transcriptGeneGroups: withGeneGroups(view, groups),
    transcriptGenes: [...new Set([...view.transcriptGenes, ...groups.flatMap((g) => g.genes)])],
    transcriptAllGenes: false,
  };
}

/** `linear-gradient(...)` sampling `lut` at `steps + 1` evenly spaced stops. */
export function gradientCss(lut: readonly Rgb[], steps = 16): string {
  const stops: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const [r, g, b] = lut[Math.round((i / steps) * (lut.length - 1))];
    stops.push(`rgb(${r},${g},${b}) ${((i / steps) * 100).toFixed(0)}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/**
 * The continuous colour bar, resolved exactly the way the renderer resolves its colours —
 * the same override, the same grey fallback. Built from `lutFor` alone, this bar showed a
 * black-to-white ramp while the canvas drew Viridis, which makes the key worse than none.
 */
export function continuousColorBarCss(
  colormap: unknown,
  reverse: boolean,
  override: ColormapValue | null,
): string {
  return gradientCss(spatialContinuousLut(colormap, reverse, override));
}

/** The density map's colour bar: its own colormap, Inferno by default. */
export function densityColorBarCss(colormap: SpatialViewState['densityColormap']): string {
  return gradientCss(lutFor(colormap ?? INFERNO_SCALE));
}

/** The middle of a section stack: where a "one section" picker opens, rather than on the
 *  first section, which for a brain is a nearly empty olfactory-bulb slide. */
export function middleSection(sections: ArrayLike<number> | null): number {
  return sections ? Math.floor((sections.length - 1) / 2) : 0;
}

/** "12 of 53" — 1-based, because the sections are slides, not array slots; `''` with none. */
export function sectionLabel(sections: ArrayLike<number> | null, at: number | null): string {
  const total = sections?.length ?? 0;
  if (!total) return '';
  const i = Math.max(0, Math.min(total - 1, at ?? 0));
  return `${i + 1} of ${total}`;
}

/** Why "All genes" is not offered yet, while the server builds its pyramid; null otherwise. */
export function allGenesPreparingNote(ds: SpatialDataset | null): string | null {
  const st = ds?.transcriptBinsStatus;
  if (!st || ds?.transcriptBins) return null;
  if (st.state === 'failed')
    return `"All genes" is unavailable: preparing it failed (${st.message ?? 'unknown error'}).`;
  const pct = st.total ? ` — ${Math.floor((100 * (st.done ?? 0)) / st.total)}% when this dataset was opened` : '';
  return `"All genes" is being prepared on the server${pct}; reopen the dataset once it is done.`;
}
