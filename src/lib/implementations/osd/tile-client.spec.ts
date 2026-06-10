import { of, throwError } from 'rxjs';

import { buildTileUrl, fetchTileBitmap, fetchTileRgba } from './tile-client';

describe('tile-client', () => {
  describe('buildTileUrl', () => {
    it('builds the composited-tile URL with the exact param order the server caches on', () => {
      expect(buildTileUrl('https://api/', 'B64', { res: 2, col: 3, row: 4, z: 5, tileSize: 512 }))
        .toBe('https://api/tile?info=B64&res=2&col=3&row=4&z=5&tileSize=512');
    });

    it('appends the channel param when set — including channel 0', () => {
      expect(buildTileUrl('a/', 'I', { res: 0, col: 0, row: 0, z: 0, tileSize: 256, channel: 0 }))
        .toBe('a/tile?info=I&res=0&col=0&row=0&z=0&tileSize=256&channel=0');
      expect(buildTileUrl('a/', 'I', { res: 0, col: 1, row: 2, z: 3, tileSize: 256, channel: 4 }))
        .toContain('&channel=4');
    });

    it('omits the channel param for null/undefined (server-composited tile)', () => {
      expect(buildTileUrl('a/', 'I', { res: 0, col: 0, row: 0, z: 0, tileSize: 256, channel: null }))
        .not.toContain('channel');
      expect(buildTileUrl('a/', 'I', { res: 0, col: 0, row: 0, z: 0, tileSize: 256 }))
        .not.toContain('channel');
    });
  });

  describe('fetch helpers', () => {
    const realCreateImageBitmap = (global as any).createImageBitmap;
    let bitmap: any;

    beforeEach(() => {
      // A real canvas is a valid drawImage source under jest-canvas-mock; we
      // bolt on close() to stand in for the ImageBitmap contract.
      const cv = document.createElement('canvas');
      cv.width = 2;
      cv.height = 2;
      bitmap = Object.assign(cv, { close: jest.fn() });
      (global as any).createImageBitmap = jest.fn().mockResolvedValue(bitmap);
    });
    afterEach(() => {
      (global as any).createImageBitmap = realCreateImageBitmap;
    });

    it('fetchTileBitmap requests a blob and decodes it (caller owns the bitmap)', async () => {
      const http: any = { get: jest.fn().mockReturnValue(of(new Blob())) };
      const bmp = await fetchTileBitmap(http, 'u', 20000);
      expect(http.get).toHaveBeenCalledWith('u', { responseType: 'blob' });
      expect(bmp).toBe(bitmap);
      expect(bitmap.close).not.toHaveBeenCalled();
    });

    it('fetchTileRgba returns the decoded pixels and closes the bitmap', async () => {
      const http: any = { get: jest.fn().mockReturnValue(of(new Blob())) };
      const img = await fetchTileRgba(http, 'u', 20000);
      expect(img).not.toBeNull();
      expect(img!.width).toBe(2);
      expect(img!.height).toBe(2);
      expect(img!.data.length).toBe(2 * 2 * 4);
      expect(bitmap.close).toHaveBeenCalled();
    });

    it('propagates fetch failures to the caller (tagged catches live at the call sites)', async () => {
      const http: any = { get: jest.fn().mockReturnValue(throwError(() => new Error('504'))) };
      await expect(fetchTileRgba(http, 'u', 20000)).rejects.toThrow('504');
      await expect(fetchTileBitmap(http, 'u', 20000)).rejects.toThrow('504');
    });
  });
});
