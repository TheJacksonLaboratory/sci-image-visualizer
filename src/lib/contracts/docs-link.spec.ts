import { SIV_DOCS_URL, sivDocsUrl } from './docs-link';

describe('sivDocsUrl', () => {
  it('defaults to the published guide', () => {
    expect(sivDocsUrl('home')).toBe(SIV_DOCS_URL);
    expect(sivDocsUrl('toolbar', null)).toBe(`${SIV_DOCS_URL}reference/toolbar/`);
    expect(sivDocsUrl('regionEditor', {})).toBe(`${SIV_DOCS_URL}reference/region-editor/`);
  });

  it("uses the host's docsUrl, with or without a trailing slash", () => {
    expect(sivDocsUrl('toolbar', { docsUrl: '/docs/visualization/' })).toBe(
      '/docs/visualization/reference/toolbar/',
    );
    expect(sivDocsUrl('toolbar', { docsUrl: 'https://x.org/viz' })).toBe('https://x.org/viz/reference/toolbar/');
  });

  it('falls back to the published guide for a blank docsUrl', () => {
    expect(sivDocsUrl('home', { docsUrl: '  ' })).toBe(SIV_DOCS_URL);
  });
});
