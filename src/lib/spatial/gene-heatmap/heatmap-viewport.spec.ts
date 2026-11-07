import {
  HeatmapExtent,
  clampWindow,
  fitWindow,
  groupAt,
  levelFor,
  maxLevel,
  panWindow,
  revealRow,
  tileRect,
  tilesFor,
  zoomWindow,
} from './heatmap-viewport';

const extent: HeatmapExtent = { cols: 1000, rows: 200, minCols: 4, minRows: 3 };

describe('heatmap viewport', () => {
  it('fits the whole matrix', () => {
    expect(fitWindow(extent)).toEqual({ x0: 0, x1: 1000, y0: 0, y1: 200 });
  });

  it('zooms about the point under the pointer', () => {
    const w = zoomWindow(fitWindow(extent), extent, 0.5, { x: 250, y: 50 });
    expect(w).toEqual({ x0: 125, x1: 625, y0: 25, y1: 125 });
  });

  it('zooms one axis only when asked', () => {
    const genes = zoomWindow(fitWindow(extent), extent, 0.5, { x: 250, y: 50 }, 'y');
    expect(genes.x0).toBe(0);
    expect(genes.x1).toBe(1000);
    expect(genes.y1 - genes.y0).toBe(100);
    const cells = zoomWindow(fitWindow(extent), extent, 0.5, { x: 250, y: 50 }, 'x');
    expect(cells.y1 - cells.y0).toBe(200);
    expect(cells.x1 - cells.x0).toBe(500);
  });

  it('stops at the closest zoom and at the whole matrix, keeping the point in place', () => {
    const near = zoomWindow({ x0: 100, x1: 110, y0: 10, y1: 20 }, extent, 0.01, { x: 105, y: 15 });
    expect(near.x1 - near.x0).toBe(4);
    expect(near.y1 - near.y0).toBe(3);
    expect(near.x0).toBeCloseTo(103);
    const far = zoomWindow({ x0: 100, x1: 900, y0: 10, y1: 190 }, extent, 10, { x: 500, y: 100 });
    expect(far).toEqual(fitWindow(extent));
  });

  it('pans within the matrix', () => {
    const w = { x0: 100, x1: 200, y0: 0, y1: 50 };
    expect(panWindow(w, extent, 50, 10)).toEqual({ x0: 150, x1: 250, y0: 10, y1: 60 });
    expect(panWindow(w, extent, -500, -500)).toEqual({ x0: 0, x1: 100, y0: 0, y1: 50 });
    expect(panWindow(w, extent, 5000, 5000)).toEqual({ x0: 900, x1: 1000, y0: 150, y1: 200 });
  });

  it('clamps a window larger than the matrix to the matrix', () => {
    expect(clampWindow({ x0: -50, x1: 2000, y0: 0, y1: 10 }, extent)).toEqual({ x0: 0, x1: 1000, y0: 0, y1: 10 });
  });

  it('brings a row into view, centred', () => {
    const w = revealRow(fitWindow(extent), extent, 150, 20);
    expect(w.y0).toBeCloseTo(140.5);
    expect(w.y1).toBeCloseTo(160.5);
    expect(revealRow(fitWindow(extent), extent, 199, 20).y1).toBe(200);
  });

  it('picks the level whose pixels are just larger than a screen pixel', () => {
    expect(levelFor(1000, 1000, 0, 10)).toBe(0);
    expect(levelFor(100, 1000, 0, 10)).toBe(0);
    expect(levelFor(4000, 1000, 0, 10)).toBe(2);
    expect(levelFor(5000, 1000, 0, 10)).toBe(2);
    expect(levelFor(100, 1000, 3, 10)).toBe(3);
    expect(levelFor(1e9, 10, 0, 6)).toBe(6);
    expect(maxLevel(1)).toBe(0);
    expect(maxLevel(1000)).toBe(10);
  });

  it('lists the tiles a window touches, centre first', () => {
    // Level (1, 0), tiles of 4: each tile 8 columns by 4 rows.
    const tiles = tilesFor({ x0: 6, x1: 18, y0: 2, y1: 5 }, 1, 0, 4, 1000, 200);
    expect(tiles.map((t) => `${t.tx},${t.ty}`).sort()).toEqual(['0,0', '0,1', '1,0', '1,1', '2,0', '2,1']);
    expect(tiles[0]).toEqual({ cx: 1, gy: 0, tx: 1, ty: 0 });
    // Never past the level.
    const edge = tilesFor({ x0: 990, x1: 1000, y0: 195, y1: 200 }, 0, 0, 256, 1000, 200);
    expect(edge).toEqual([{ cx: 0, gy: 0, tx: 3, ty: 0 }]);
  });

  it('gives a tile its data rectangle, clipped', () => {
    expect(tileRect({ cx: 2, gy: 1, tx: 1, ty: 0 }, 4, 1000, 200)).toEqual({ x0: 16, x1: 32, y0: 0, y1: 8 });
    expect(tileRect({ cx: 8, gy: 6, tx: 0, ty: 0 }, 4, 1000, 200)).toEqual({ x0: 0, x1: 1000, y0: 0, y1: 200 });
  });

  it('finds the group of a column', () => {
    const starts = [0, 10, 10, 25];
    expect(groupAt(starts, 0)).toBe(0);
    expect(groupAt(starts, 9)).toBe(0);
    // An empty group (two equal starts) is skipped for the next one.
    expect(groupAt(starts, 10)).toBe(2);
    expect(groupAt(starts, 30)).toBe(3);
    expect(groupAt([], 3)).toBe(-1);
  });
});
