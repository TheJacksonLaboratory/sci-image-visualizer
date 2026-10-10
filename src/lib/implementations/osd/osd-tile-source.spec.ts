import { buildOsdTileSource, planTiledMount } from './osd-tile-source';
import { TileDescriptor } from '../tile-server';

const desc = (over: Partial<TileDescriptor> = {}): TileDescriptor =>
  ({
    width: 1000,
    height: 700,
    tileSize: 256,
    z: 1,
    channels: 1,
    realLevels: 2,
    // Two real Bio-Formats levels, then one synthetic overview.
    levels: [
      { res: 0, width: 1000, height: 700 },
      { res: 1, width: 500, height: 351 },
      { res: 2, width: 125, height: 88 },
    ],
    ...over,
  }) as TileDescriptor;

describe('planTiledMount', () => {
  it("counts the coarsest REAL level's tiles, ignoring synthetic overviews", () => {
    expect(planTiledMount(desc())).toEqual({ realLevels: 2, multiChannel: false, coarseTiles: 2 * 2 });
  });

  it('keeps a small multichannel image per-channel', () => {
    expect(planTiledMount(desc({ multichannel: true, channels: 4 })).multiChannel).toBe(true);
  });

  it('falls back to the server composite when the fit view needs too many tiles', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // 4 tiles x 4 channels = 16 > 10
    expect(planTiledMount(desc({ multichannel: true, channels: 4 }), 10).multiChannel).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('treats every level as real when the descriptor does not say', () => {
    expect(planTiledMount(desc({ realLevels: undefined })).realLevels).toBe(3);
  });
});

describe('buildOsdTileSource', () => {
  type Ts = {
    getLevelScale(l: number): number;
    getNumTiles(l: number): { x: number; y: number };
    getTileUrl(l: number, x: number, y: number): string;
  };
  const build = (spec: Partial<Parameters<typeof buildOsdTileSource>[1]> = {}) =>
    buildOsdTileSource(desc(), { api: '/api', infoB64: 'INFO', z: 2, ...spec }) as unknown as Ts;

  it('maps OSD levels (coarsest first) onto backend resolutions (full-res first)', () => {
    const ts = build();
    expect(ts.getLevelScale(2)).toBe(1); // res 0
    expect(ts.getLevelScale(0)).toBe(0.125); // res 2
    expect(ts.getTileUrl(2, 3, 1)).toContain('res=0');
    expect(ts.getTileUrl(0, 0, 0)).toContain('res=2');
  });

  it("counts tiles from each level's own size, so it never requests out-of-range tiles", () => {
    const ts = build();
    expect(ts.getNumTiles(1)).toMatchObject({ x: 2, y: 2 }); // 500x351 at 256
    expect(ts.getNumTiles(9)).toMatchObject({ x: 0, y: 0 });
  });

  it('draws off the real levels only, for one channel, when asked', () => {
    const ts = build({ realLevelsOnly: 2, channel: 1 });
    expect(ts.getLevelScale(0)).toBe(0.5); // the coarsest REAL level
    expect(ts.getTileUrl(0, 0, 0)).toMatch(/res=1.*channel=1|channel=1.*res=1/);
    expect(ts.getTileUrl(1, 0, 0)).toContain('z=2');
  });
});
