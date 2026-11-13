import { VizConfig } from './viz-config';

/**
 * The published SIV user guide (built from `docs/user-guide` by mkdocs and deployed
 * next to the live demo). The toolbar's and the Region Editor's Help buttons open it
 * unless the host points {@link VizConfig.docsUrl} at its own copy.
 */
export const SIV_DOCS_URL = 'https://thejacksonlaboratory.github.io/sci-image-visualizer/docs/';

/**
 * User-guide pages the library links to, as paths relative to the guide's root.
 * They follow mkdocs' directory URLs (`reference/toolbar.md` → `reference/toolbar/`),
 * so they stay valid when the guide is mounted under another site's prefix.
 */
export const SIV_DOCS_PAGES = {
  home: '',
  toolbar: 'reference/toolbar/',
  regionEditor: 'reference/region-editor/',
} as const;

export type SivDocsPage = keyof typeof SIV_DOCS_PAGES;

/**
 * The URL of a user-guide page: `config.docsUrl` (or {@link SIV_DOCS_URL}) joined
 * with the page's path. A base without a trailing slash is treated as a folder.
 */
export function sivDocsUrl(page: SivDocsPage, config?: Pick<VizConfig, 'docsUrl'> | null): string {
  const base = config?.docsUrl?.trim() || SIV_DOCS_URL;
  return (base.endsWith('/') ? base : `${base}/`) + SIV_DOCS_PAGES[page];
}
