import { SpatialDataset } from '../contracts/spatial-dataset.contract';
import {
  POLYGON_LEVEL_MIN_CELL_PX,
  cellTypeColumnFor,
  cellsShown,
  pixelsPerDataUnit,
  polygonLevelFor,
  tileId,
  tilesInRect,
  transcriptLevelFor,
  typicalCellDiameter,
  visibleDataRect,
} from './lod';

/**
 * Level-of-detail planning. The numbers are a real Xenium bundle's: 250 µm tiles doubling
 * per level, 0.2125 µm pixels (so `imageRef.scale` is 1/0.2125 ≈ 4.706), ~12 µm cells.
 */
const XENIUM_SCALE = 1 / 0.2125;
const ref = { scale: [XENIUM_SCALE, XENIUM_SCALE] as [number, number], translate: [0, 0] as [number, number] };
const levels = (n: number, base = 250) => Array.from({ length: n }, (_v, l) => ({ tileSize: base * 2 ** l }));

describe('visibleDataRect', () => {
  it('maps the camera box back through the data→world affine', () => {
    // Centre at world (4706, 4706) = data (1000, 1000) µm; 1 canvas px per world px.
    const r = visibleDataRect([4706, 4706], 1, 941.2, 470.6, ref, 0)!;
    expect(r.x0).toBeCloseTo(900, 0);
    expect(r.x1).toBeCloseTo(1100, 0);
    expect(r.y0).toBeCloseTo(950, 0);
    expect(r.y1).toBeCloseTo(1050, 0);
  });

  it('pads by the margin so tiles just off screen are prefetched', () => {
    const tight = visibleDataRect([0, 0], 1, 100, 100, null, 0)!;
    const padded = visibleDataRect([0, 0], 1, 100, 100, null, 0.25)!;
    expect(padded.x1 - padded.x0).toBeCloseTo(1.5 * (tight.x1 - tight.x0), 6);
  });

  it('is null for a canvas with no area or a zero zoom', () => {
    expect(visibleDataRect([0, 0], 0, 100, 100)).toBeNull();
    expect(visibleDataRect([0, 0], 1, 0, 100)).toBeNull();
  });

  it('honours a translation', () => {
    const r = visibleDataRect([110, 10], 1, 20, 20, { scale: [1, 1], translate: [100, 0] }, 0)!;
    expect([r.x0, r.x1]).toEqual([0, 20]);
  });
});

describe('tilesInRect', () => {
  it('lists every tile the rectangle touches', () => {
    const keys = tilesInRect({ x0: 100, y0: 100, x1: 600, y1: 300 }, 0, levels(4));
    expect(keys.map((k) => `${k.gx},${k.gy}`).sort()).toEqual(['0,0', '0,1', '1,0', '1,1', '2,0', '2,1']);
  });

  it('clips to the dataset bounds, so empty canvas asks for nothing', () => {
    expect(tilesInRect({ x0: -5000, y0: -5000, x1: -10, y1: -10 }, 0, levels(4), [0, 0, 9000, 9000])).toEqual([]);
    const keys = tilesInRect({ x0: -5000, y0: -5000, x1: 100, y1: 100 }, 0, levels(4), [0, 0, 9000, 9000]);
    expect(keys).toEqual([{ level: 0, gx: 0, gy: 0 }]);
  });

  it('handles negative tile indices (a bundle keys `-1,0` for slightly negative coordinates)', () => {
    const keys = tilesInRect({ x0: -10, y0: 10, x1: 10, y1: 20 }, 0, levels(1));
    expect(keys.map((k) => k.gx).sort()).toEqual([-1, 0]);
  });

  it('orders from the centre outward and respects a limit', () => {
    const keys = tilesInRect({ x0: 0, y0: 0, x1: 1250, y1: 1250 }, 0, levels(1), null, 1);
    expect(keys).toEqual([{ level: 0, gx: 2, gy: 2 }]);
  });

  it("uses the level's own tile size", () => {
    const keys = tilesInRect({ x0: 0, y0: 0, x1: 999, y1: 999 }, 2, levels(4));
    expect(keys).toEqual([{ level: 2, gx: 0, gy: 0 }]);
    expect(tileId(keys[0])).toBe('2/0/0');
  });
});

describe('polygonLevelFor', () => {
  const cell = 12;

  it('draws every vertex when a cell is large on screen', () => {
    expect(polygonLevelFor(10, cell, 4)).toBe(0); // 120 px cells
  });

  it('coarsens one level each time the cell halves on screen', () => {
    const px = (cellPx: number) => cellPx / cell;
    expect(polygonLevelFor(px(POLYGON_LEVEL_MIN_CELL_PX[0]), cell, 4)).toBe(0);
    expect(polygonLevelFor(px(POLYGON_LEVEL_MIN_CELL_PX[1]), cell, 4)).toBe(1);
    expect(polygonLevelFor(px(POLYGON_LEVEL_MIN_CELL_PX[2]), cell, 4)).toBe(2);
  });

  it('never uses the 3-vertex level — below 8 px a cell is drawn as a dot', () => {
    expect(polygonLevelFor(7 / cell, cell, 4)).toBe(-1);
    expect(polygonLevelFor(2 / cell, cell, 4)).toBe(-1);
  });

  it('never returns a level the dataset does not have', () => {
    expect(polygonLevelFor(POLYGON_LEVEL_MIN_CELL_PX[2] / cell, cell, 2)).toBe(-1);
    expect(polygonLevelFor(100, cell, 1)).toBe(0);
  });
});

describe('transcriptLevelFor', () => {
  it('picks the level whose tiles land nearest the target on screen', () => {
    // 250 µm at 2 px/µm = 500 px ≈ 512: level 0.
    expect(transcriptLevelFor(2, levels(7), 512)).toBe(0);
    // Zoomed out 8×: 2000 µm tiles land at 500 px.
    expect(transcriptLevelFor(0.25, levels(7), 512)).toBe(3);
  });

  it('clamps to the coarsest level however far out the camera is', () => {
    expect(transcriptLevelFor(1e-4, levels(7))).toBe(6);
  });

  it('degrades to level 0 for bad input rather than throwing', () => {
    expect(transcriptLevelFor(0, levels(7))).toBe(0);
    expect(transcriptLevelFor(1, [])).toBe(0);
  });
});

describe('typicalCellDiameter', () => {
  it('is twice the median radius', () => {
    expect(typicalCellDiameter(Float32Array.from([4, 5, 6, 100]))).toBe(12);
  });
  it('accepts a uniform radius and falls back when there is none', () => {
    expect(typicalCellDiameter(3)).toBe(6);
    expect(typicalCellDiameter(undefined, 11)).toBe(11);
  });
});

describe('pixelsPerDataUnit', () => {
  it('combines the camera zoom with the data→world scale', () => {
    expect(pixelsPerDataUnit(0.5, ref)).toBeCloseTo(0.5 * XENIUM_SCALE, 9);
    expect(pixelsPerDataUnit(2)).toBe(2);
  });
});

describe('cellTypeColumnFor', () => {
  const ds = (names: [string, 'categorical' | 'continuous'][]) =>
    ({
      columns: names.map(([name, kind]) =>
        kind === 'categorical' ? { kind, name, categories: ['a'] } : { kind, name },
      ),
    }) as unknown as SpatialDataset;

  it('prefers the pipeline clustering over a curated annotation by default', () => {
    const d = ds([
      ['cell_area', 'continuous'],
      ['curated_cell_type', 'categorical'],
      ['graphclust', 'categorical'],
    ]);
    expect(cellTypeColumnFor(d, { cellTypeColumn: null })).toBe('graphclust');
  });

  it('honours an explicit choice, including the curated one', () => {
    const d = ds([
      ['graphclust', 'categorical'],
      ['curated_cell_type', 'categorical'],
    ]);
    expect(cellTypeColumnFor(d, { cellTypeColumn: 'curated_cell_type' })).toBe('curated_cell_type');
  });

  it('ignores a choice this dataset does not have, and a continuous column', () => {
    const d = ds([
      ['graphclust', 'categorical'],
      ['cell_area', 'continuous'],
    ]);
    expect(cellTypeColumnFor(d, { cellTypeColumn: 'nope' })).toBe('graphclust');
    expect(cellTypeColumnFor(d, { cellTypeColumn: 'cell_area' })).toBe('graphclust');
  });

  it('falls back to a curated column when it is the only categorical', () => {
    expect(cellTypeColumnFor(ds([['curated_cell_type', 'categorical']]), { cellTypeColumn: null })).toBe(
      'curated_cell_type',
    );
    expect(cellTypeColumnFor(ds([['cell_area', 'continuous']]), { cellTypeColumn: null })).toBeNull();
  });
});

describe('cellsShown', () => {
  const tiled = { polygonTiles: { bounds: [0, 0, 1, 1], sets: [], levels: [] } } as never;
  const whole = { polygons: { count: 3 } } as never;
  const none = {} as never;

  it('is on by default for any dataset with outlines', () => {
    expect(cellsShown(tiled, { showCells: null })).toBe(true);
    expect(cellsShown(whole, { showCells: null })).toBe(true);
  });

  it('honours an explicit choice', () => {
    expect(cellsShown(tiled, { showCells: false })).toBe(false);
    expect(cellsShown(tiled, { showCells: true })).toBe(true);
  });

  it('is off for a dataset with nothing to outline, whatever the setting', () => {
    expect(cellsShown(none, { showCells: true })).toBe(false);
    expect(cellsShown(null, { showCells: null })).toBe(false);
  });
});
