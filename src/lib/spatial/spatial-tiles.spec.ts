import * as densityRaster from './density-raster';
import * as glyphs from './glyphs';
import * as lod from './lod';
import * as spatialTiles from './spatial-tiles';
import * as transcriptGrouping from './transcript-grouping';

/**
 * `spatial-tiles` is a deprecated barrel kept for one release: every helper it used to define
 * now lives in one of four modules, and old imports must keep resolving to the same functions.
 */
describe('spatial-tiles (deprecated re-exports)', () => {
  it.each([
    ['lod', lod], ['transcript-grouping', transcriptGrouping], ['glyphs', glyphs], ['density-raster', densityRaster],
  ] as const)('re-exports everything from %s', (_name, mod) => {
    for (const [key, value] of Object.entries(mod)) {
      expect((spatialTiles as Record<string, unknown>)[key]).toBe(value);
    }
  });
});
