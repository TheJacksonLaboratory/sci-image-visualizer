import { chartKindOptions, embeddingHelp, embeddingNote, heatmapNote, kindHelp } from './chart-help';

describe('chart-help', () => {
  it('offers the kinds the subject can be drawn as, the embedding only when published', () => {
    expect(chartKindOptions(false, false).map((o) => o.value)).toEqual(['histogram', 'violin', 'box', 'heatmap']);
    expect(chartKindOptions(true, true).map((o) => o.value)).toEqual(['counts', 'heatmap', 'embedding']);
  });

  it('explains each kind, and the embedding by its method', () => {
    for (const kind of ['counts', 'histogram', 'violin', 'box', 'heatmap'] as const) {
      expect(kindHelp(kind, null)).toMatch(/^<b>/);
    }
    expect(kindHelp('embedding', { name: 'X_pca', label: 'PCA' })).toContain('<b>PCA</b>');
    expect(embeddingHelp({ name: 'local:tsne', label: 't-SNE' })).toContain('<b>t-SNE</b>');
    expect(embeddingHelp({ name: 'X_umap' })).toContain('<b>UMAP</b>');
    expect(embeddingHelp(null)).toContain('<b>UMAP</b>');
  });

  it('says what the embedding shows, how it was derived, and what is selected', () => {
    expect(embeddingNote(null, false, 0)).toBe('This dataset publishes no embedding.');
    expect(embeddingNote({ name: 'X_umap', label: 'UMAP' }, true, 0)).toBe('UMAP. Coloured to match the map.');
    expect(embeddingNote({ name: 't', label: 't-SNE', derived: true, params: 'perplexity 30' }, false, 1200))
      .toBe('t-SNE. Colour the map by a categorical column to colour these points. 1,200 selected are '
        + 'highlighted. Computed here (perplexity 30), not published with the dataset.');
  });

  it('says what the heatmap shows: rows, columns, scaling and the cap', () => {
    const base = {
      geneCount: 2, selectionCount: 0, zScore: true, hidden: 0, groupBy: 'class', maxColumns: 40, cellColumns: 200,
    };
    expect(heatmapNote({ ...base, geneCount: 0 })).toBe('Pick one or more genes for the rows.');
    expect(heatmapNote({ ...base, selectionCount: 12 })).toMatch(/^One column per selected cell \(12\)/);
    expect(heatmapNote(base)).toMatch(/within each class, over all cells\. Each gene is z-scored/);
    expect(heatmapNote({ ...base, zScore: false, selectionCount: 500 })).toMatch(/over the selected cells\. Raw means/);
    expect(heatmapNote({ ...base, hidden: 298 })).toContain('Showing the 40 strongest of 338');
    expect(heatmapNote({ ...base, groupBy: null })).toContain('within each group');
  });
});
