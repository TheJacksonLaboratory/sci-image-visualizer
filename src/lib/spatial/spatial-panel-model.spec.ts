import { SpatialDataset } from '../contracts/spatial-dataset.contract';
import { DEFAULT_SPATIAL_VIEW } from '../contracts/display-types';
import {
  CLIP_OPTIONS,
  GLYPH_OPTIONS,
  allGenesPreparingNote,
  buildGeneTree,
  columnLabel,
  columnOptions,
  continuousColorBarCss,
  countGroupRows,
  densityColorBarCss,
  familyMembers,
  geneOption,
  glyphPoints,
  gradientCss,
  groupEntryFor,
  groupOptions,
  groupVariantOptions,
  importGeneGroupsPatch,
  markerColumnOptions,
  markerGeneGroups,
  markerGenesPatch,
  middleSection,
  parseGeneGroups,
  sectionLabel,
  tileOptions,
  toggleHidden,
} from './spatial-panel-model';

const ds = (partial: Partial<SpatialDataset>): SpatialDataset =>
  ({
    id: 'd',
    name: 'd',
    observations: { count: 0, x: new Float32Array(0), y: new Float32Array(0) },
    columns: [],
    ...partial,
  }) as SpatialDataset;

const kmeans = (k: number) => ({
  kind: 'categorical' as const,
  name: `kmeans_${k}`,
  categories: [],
  section: 'Clusters',
  family: { id: 'kmeans', label: 'K-means', variant: `k = ${k}` },
});

describe('spatial-panel-model', () => {
  describe('options', () => {
    it('labels a gene option by its name, filterable by `label`', () => {
      expect(geneOption('Ttr')).toEqual({ label: 'Ttr', value: 'Ttr' });
    });

    it('labels columns by kind: categories, unit, or continuous', () => {
      expect(columnLabel({ kind: 'categorical', name: 'region', categories: ['a', 'b'] })).toBe(
        'region — 2 categories',
      );
      expect(columnLabel({ kind: 'continuous', name: 'area', unit: 'µm²' })).toBe('area — µm²');
      expect(columnLabel({ kind: 'continuous', name: 'x' })).toBe('x — continuous');
      expect(columnOptions(null)).toEqual([{ label: 'None (flat colour)', value: null }]);
    });

    it('builds the tile options from what the dataset serves', () => {
      const none = tileOptions(null);
      expect(none.cellSetOptions).toEqual([]);
      expect(none.transcriptModeOptions).toEqual([]);
      expect(none.cellColorOptions.map((o) => o.value)).toEqual(['group', 'single']);

      const full = tileOptions(
        ds({
          columns: [
            { kind: 'continuous', name: 'transcript_density' },
            { kind: 'categorical', name: 'segmentation_method', categories: [] },
          ],
          features: { count: 1 },
          polygonTiles: {
            bounds: [0, 0, 1, 1],
            levels: [],
            sets: [
              { name: 'nucleus', label: 'Nucleus boundaries' },
              { name: 'cell', label: 'Cell boundaries' },
            ],
          },
          transcriptTiles: { bounds: [0, 0, 1, 1], geneCount: 1, hasZ: false, levels: [] },
          density: { gridSize: [1, 1], origin: [0, 0], rows: 1, cols: 1 },
        } as Partial<SpatialDataset>),
      );
      expect(full.cellSetOptions).toEqual([
        { label: 'Cell', value: 'cell' },
        { label: 'Nucleus', value: 'nucleus' },
        { label: 'Both', value: 'both' },
      ]);
      expect(full.transcriptModeOptions.map((o) => o.value)).toEqual(['circles', 'glyphs', 'density']);
      expect(full.cellColorOptions.map((o) => o.value)).toEqual([
        'group',
        'gene',
        'transcriptDensity',
        'single',
        'segmentation',
      ]);
    });

    it('offers glyphs with a preview outline, and the clip presets', () => {
      expect(GLYPH_OPTIONS.length).toBeGreaterThan(3);
      expect(glyphPoints(GLYPH_OPTIONS[1].value)).toBe(GLYPH_OPTIONS[1].points);
      expect(glyphPoints('nope' as never)).toBe('');
      expect(CLIP_OPTIONS[0].value).toEqual([0, 1]);
    });
  });

  describe('groups', () => {
    const dataset = ds({
      columns: [
        { kind: 'categorical', name: 'graphclust', categories: [] },
        { kind: 'categorical', name: 'segmentation_method', categories: [] },
        kmeans(2),
        kmeans(3),
        { kind: 'categorical', name: 'leiden', categories: [], section: 'Clusters', description: 'Leiden (r=1)' },
        { kind: 'continuous', name: 'area' },
      ],
    });

    it('lists groupings under their section, a family once, and never the segmentation method', () => {
      expect(groupOptions(dataset)).toEqual([
        { label: 'Groups', items: [{ label: 'graphclust — 0 categories', value: 'graphclust' }] },
        {
          label: 'Clusters',
          items: [
            { label: 'K-means', value: 'family:kmeans' },
            { label: 'Leiden (r=1)', value: 'leiden' },
          ],
        },
      ]);
      expect(groupOptions(null)).toEqual([]);
    });

    it('maps a family column to its entry, and lists its variants', () => {
      expect(groupEntryFor(dataset, 'kmeans_3')).toBe('family:kmeans');
      expect(groupEntryFor(dataset, 'graphclust')).toBe('graphclust');
      expect(groupEntryFor(dataset, null)).toBeNull();
      expect(familyMembers(dataset, 'kmeans').map((c) => c.name)).toEqual(['kmeans_2', 'kmeans_3']);
      expect(groupVariantOptions(dataset, 'kmeans_2')).toEqual([
        { label: 'k = 2', value: 'kmeans_2' },
        { label: 'k = 3', value: 'kmeans_3' },
      ]);
      expect(groupVariantOptions(dataset, 'graphclust')).toEqual([]);
    });

    it('counts cells per category, largest first, ignoring missing codes', () => {
      const { rows, total } = countGroupRows({
        categories: ['A', 'B', 'C'],
        colors: ['#a', '#b'],
        codes: new Uint16Array([1, 1, 0, 2, 0xffff, 1]),
      });
      expect(rows).toEqual([
        { label: 'B', color: '#b', count: 3 },
        { label: 'A', color: '#a', count: 1 },
        { label: 'C', color: '#999', count: 1 },
      ]);
      expect(total).toBe(5);
    });

    it('toggles a hidden set without duplicates', () => {
      expect(toggleHidden(['a'], ['a', 'b'], false)).toEqual(['a', 'b']);
      expect(toggleHidden(['a', 'b'], ['a'], true)).toEqual(['b']);
    });
  });

  describe('genes', () => {
    it('builds the selected-genes tree: groups of selected genes first, then the rest', () => {
      expect(
        buildGeneTree(
          ['A', 'B', 'C', 'D'],
          [
            { name: 'g1', genes: ['B', 'X'] },
            { name: 'empty', genes: ['X'] },
            { name: 'g2', genes: ['D', 'B'] },
          ],
        ),
      ).toEqual([
        { name: 'g1', genes: ['B'] },
        // A gene in two groups is listed under each, as Explorer does.
        { name: 'g2', genes: ['D', 'B'] },
        { name: null, genes: ['A', 'C'] },
      ]);
      expect(buildGeneTree([], [{ name: 'g', genes: ['A'] }])).toEqual([]);
    });

    it('parses gene groups from a group,gene table, header optional, CSV or TSV', () => {
      expect(parseGeneGroups('group,gene\nT,Cd3e\nT,Cd3e\nB,"Cd19"\r\nT\tCd8a\n\nbad')).toEqual([
        { name: 'T', genes: ['Cd3e', 'Cd8a'] },
        { name: 'B', genes: ['Cd19'] },
      ]);
    });

    it('offers every categorical column but the segmentation method for markers', () => {
      expect(
        markerColumnOptions([
          { kind: 'categorical', name: 'segmentation_method', categories: [] },
          { kind: 'categorical', name: 'class', categories: ['a'] },
          { kind: 'continuous', name: 'area' },
        ]),
      ).toEqual([{ label: 'class — 1 categories', value: 'class' }]);
      expect(markerColumnOptions(undefined)).toEqual([]);
    });

    it('assigns a marker gene to the picked cluster it scores highest in', () => {
      const result = {
        groups: [
          {
            name: 'A',
            genes: [
              { name: 'g1', score: 3 },
              { name: 'g2', score: 1 },
            ],
          },
          {
            name: 'B',
            genes: [
              { name: 'g2', score: 2 },
              { name: 'g3', score: 9 },
            ],
          },
          { name: 'C', genes: [{ name: 'g1', score: 5 }] },
        ],
      } as never;
      expect(markerGeneGroups(result, new Set(['A', 'B']))).toEqual([
        { name: 'A', genes: ['g1'] },
        { name: 'B', genes: ['g2', 'g3'] },
      ]);
      // C is not picked, so its higher score for g1 does not count; picked alone it takes g1
      // and A, left empty, is dropped.
      expect(markerGeneGroups(result, new Set(['A', 'C']))).toEqual([
        { name: 'A', genes: ['g2'] },
        { name: 'C', genes: ['g1'] },
      ]);
    });

    it('patches marker groups in: replaced by name, genes appended once, cluster colours, on', () => {
      const view = {
        ...DEFAULT_SPATIAL_VIEW,
        transcriptGenes: ['g1', 'x'],
        transcriptGeneGroups: [
          { name: 'A', genes: ['old'] },
          { name: 'K', genes: ['x'] },
        ],
      };
      expect(markerGenesPatch(view, [{ name: 'A', genes: ['g1', 'g2'] }])).toEqual({
        transcriptGeneGroups: [
          { name: 'K', genes: ['x'] },
          { name: 'A', genes: ['g1', 'g2'] },
        ],
        transcriptGenes: ['g1', 'x', 'g2'],
        transcriptColorBy: 'cluster',
        transcriptMode: 'circles',
      });
      expect(markerGenesPatch({ ...view, transcriptMode: 'glyphs' }, []).transcriptMode).toBeUndefined();
      expect(importGeneGroupsPatch(view, [{ name: 'K', genes: ['y', 'x'] }])).toEqual({
        transcriptGeneGroups: [
          { name: 'A', genes: ['old'] },
          { name: 'K', genes: ['y', 'x'] },
        ],
        transcriptGenes: ['g1', 'x', 'y'],
        transcriptAllGenes: false,
      });
    });
  });

  describe('colour bars and sections', () => {
    it('samples a LUT at 17 stops into a gradient', () => {
      const lut = Array.from({ length: 256 }, (_, i) => [i, i, i] as [number, number, number]);
      const css = gradientCss(lut);
      expect(css.startsWith('linear-gradient(to right, rgb(0,0,0) 0%')).toBe(true);
      expect(css.endsWith('rgb(255,255,255) 100%)')).toBe(true);
      expect(css.split('rgb(').length - 1).toBe(17);
    });

    it('builds the continuous bar the renderer would use, and the density bar from its own map', () => {
      // A grey display colormap falls back to Viridis for the data; an override wins.
      expect(continuousColorBarCss('Greys', false, null)).toBe(continuousColorBarCss('Viridis', false, null));
      expect(continuousColorBarCss('Greys', false, 'Reds')).not.toBe(
        continuousColorBarCss('Viridis', false, null),
      );
      expect(densityColorBarCss(null)).not.toBe(densityColorBarCss('Viridis'));
    });

    it('opens a section picker mid-stack and labels sections 1-based', () => {
      const three = Float32Array.from([0, 1, 2]);
      expect(middleSection(three)).toBe(1);
      expect(middleSection(null)).toBe(0);
      expect(sectionLabel(three, 0)).toBe('1 of 3');
      expect(sectionLabel(three, 9)).toBe('3 of 3');
      expect(sectionLabel(three, null)).toBe('1 of 3');
      expect(sectionLabel(null, 1)).toBe('');
    });

    it('says why "All genes" is not offered yet, and nothing once it is', () => {
      expect(allGenesPreparingNote(null)).toBeNull();
      expect(
        allGenesPreparingNote(ds({ transcriptBinsStatus: { state: 'building', done: 1, total: 4 } } as never)),
      ).toContain('25%');
      expect(
        allGenesPreparingNote(ds({ transcriptBinsStatus: { state: 'failed', message: 'disk' } } as never)),
      ).toContain('failed (disk)');
      expect(
        allGenesPreparingNote(
          ds({
            transcriptBinsStatus: { state: 'ready' },
            transcriptBins: {},
          } as never),
        ),
      ).toBeNull();
    });
  });
});
