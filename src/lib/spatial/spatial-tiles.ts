/**
 * Spatial tile helpers, re-exported from the modules they now live in.
 *
 * @deprecated Kept for one release so existing imports keep working. Import from
 * `./lod` (level of detail, tiles in view), `./transcript-grouping` (grouping, marker
 * sizing, cluster colours), `./glyphs` (transcript icons) or `./density-raster` (density
 * window, categorical colormap stops) instead.
 */

export * from './lod';
export * from './transcript-grouping';
export * from './glyphs';
export * from './density-raster';
