import { GENE_OPTIONS_MAX, searchGeneNames } from './gene-search';

describe('searchGeneNames', () => {
  const panel = ['Mbp', 'Ambp', 'Ttr', 'Snap25', 'MBD2', 'Gfap', 'Camk2a'];

  it('opens on the head of the list rather than on nothing', () => {
    // The dropdown is open before anything is typed. An empty menu there reads as
    // "this dataset has no genes", which is the opposite of true.
    expect(searchGeneNames(panel, '', 3)).toEqual(['Mbp', 'Ambp', 'Ttr']);
  });

  it('ranks prefix matches above substring matches', () => {
    // Typing "mb" must surface Mbp above Ambp — the whole reason this is not `includes`.
    expect(searchGeneNames(panel, 'mb')).toEqual(['Mbp', 'MBD2', 'Ambp']);
  });

  it('matches case-insensitively, both ways', () => {
    // Symbols are capitalised by convention and nobody types them exactly. `Ambp`
    // rides along on the substring pass, below the exact prefix hit.
    expect(searchGeneNames(panel, 'MBP')).toEqual(['Mbp', 'Ambp']);
    expect(searchGeneNames(panel, 'mbd')).toEqual(['MBD2']);
  });

  it('ignores surrounding whitespace', () => {
    expect(searchGeneNames(panel, '  ttr ')).toEqual(['Ttr']);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchGeneNames(panel, 'zzz')).toEqual([]);
  });

  it('caps the result, and never pays for the rest of the corpus', () => {
    // 18,078 names is the real case. The cap is the point: what must not happen is the
    // caller receiving thousands of options to render.
    const many = Array.from({ length: 18078 }, (_, i) => `Gene${i}`);
    expect(searchGeneNames(many, 'gene', 500)).toHaveLength(500);
    expect(searchGeneNames(many, '')).toHaveLength(GENE_OPTIONS_MAX);
  });

  it('fills the cap with prefix matches before considering substrings', () => {
    // A corpus where substring matches come FIRST in order: they must not crowd out
    // prefix matches found later, or "ab" would rank `xab` above `abc`.
    const names = ['xab', 'yab', 'abc', 'abd'];
    expect(searchGeneNames(names, 'ab', 2)).toEqual(['abc', 'abd']);
  });

  it('takes no limit as no options', () => {
    expect(searchGeneNames(panel, 'mbp', 0)).toEqual([]);
  });
});
