import { SpatialDataset, SpatialTranscriptTile } from '../contracts/spatial-dataset.contract';
import { lutFor } from './spatial-encoding';
import { geneBinSize, groupTranscriptsByGene } from './spatial-tiles';
import {
  POLYGON_LEVEL_MIN_CELL_PX, TRANSCRIPT_GLYPHS, TRANSCRIPT_MAX_PX, TRANSCRIPT_MIN_PX,
  INFERNO_SCALE, TRANSCRIPT_PHYSICAL_UM,
  allGenesPlan, cellTypeColumnFor, cellsShown, colorDensity, groupedMarkerPx, quantileOf, tilesInRectFrom,
  visibleArea, discreteColormapStops, glyphOutline, glyphRings, pixelsPerDataUnit,
  smoothRaster,
  polygonLevelFor, tileId, tilesInRect, transcriptLevelFor, transcriptMarkerPx,
  typicalCellDiameter, visibleDataRect,
} from './spatial-tiles';

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

  it('uses the level\'s own tile size', () => {
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

describe('transcriptMarkerPx', () => {
  it('draws a single transcript at the minimum size', () => {
    expect(transcriptMarkerPx(1)).toBe(TRANSCRIPT_MIN_PX);
  });

  it('grows with the count, but sub-linearly', () => {
    const a = transcriptMarkerPx(10);
    const b = transcriptMarkerPx(1000);
    expect(b).toBeGreaterThan(a);
    expect(b / a).toBeLessThan(100 / 1); // far less than linear-in-count
  });

  it('is capped, so one dense aggregate cannot cover the tile', () => {
    expect(transcriptMarkerPx(1e9)).toBe(TRANSCRIPT_MAX_PX);
  });

  it('scales with the size control', () => {
    expect(transcriptMarkerPx(1, 2)).toBe(2 * TRANSCRIPT_MIN_PX);
  });

  it('grows with the tissue when zoomed in, instead of shrinking to a speck', () => {
    // Zoomed out (0.5 px/µm): the physical size is sub-pixel, so the floor holds.
    expect(transcriptMarkerPx(1, 1, 0.5)).toBe(TRANSCRIPT_MIN_PX);
    // Pixel-level zoom (20 px/µm): drawn at its physical size.
    expect(transcriptMarkerPx(1, 1, 20)).toBeCloseTo(TRANSCRIPT_PHYSICAL_UM * 20, 6);
    // Extreme zoom: capped.
    expect(transcriptMarkerPx(1, 1, 1000)).toBe(TRANSCRIPT_MAX_PX);
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

describe('glyphs', () => {
  it('every glyph is a closed ring of at least three vertices within the unit disc (ish)', () => {
    for (const g of TRANSCRIPT_GLYPHS) {
      const o = glyphOutline(g);
      expect(o.length / 2).toBeGreaterThanOrEqual(3);
      for (let i = 0; i < o.length; i += 2) {
        expect(Math.hypot(o[i], o[i + 1])).toBeLessThanOrEqual(1.2);
      }
    }
  });

  it('expands entries into scaled, translated rings', () => {
    const tri = glyphOutline('triangle');
    const { coords, offsets } = glyphRings(
      Float32Array.from([10, 20]), Float32Array.from([0, 5]), Float32Array.from([1, 2]), () => tri,
    );
    expect(Array.from(offsets)).toEqual([0, 3, 6]);
    expect(coords[0]).toBeCloseTo(10 + tri[0], 6);
    expect(coords[7]).toBeCloseTo(5 + tri[1] * 2, 6);
  });
});

describe('discreteColormapStops', () => {
  const rgb: [number, number, number][] = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];

  it('gives each category a band and samples at its centre', () => {
    const { valueOf } = discreteColormapStops(rgb, [128, 128, 128]);
    // 3 categories + 1 missing band = 4 bands.
    expect(valueOf(0)).toBeCloseTo(0.125, 9);
    expect(valueOf(2)).toBeCloseTo(0.625, 9);
  });

  it('routes a missing or out-of-range code to the grey band', () => {
    const { valueOf } = discreteColormapStops(rgb, [128, 128, 128]);
    expect(valueOf(-1)).toBeCloseTo(0.875, 9);
    expect(valueOf(99)).toBeCloseTo(0.875, 9);
  });

  it('stops are piecewise constant — a band never blends into its neighbour', () => {
    const { stops, valueOf } = discreteColormapStops(rgb, [128, 128, 128]);
    const at = (t: number) => {
      // Linear interpolation between the bracketing stops, as the colormap does.
      const i = stops.findIndex((s) => s.t >= t);
      if (stops[i].t === t || i === 0) return stops[i].color;
      const [a, b] = [stops[i - 1], stops[i]];
      const f = (t - a.t) / (b.t - a.t);
      return a.color.map((c, k) => c + f * (b.color[k] - c));
    };
    expect(at(valueOf(1))).toEqual([0, 1, 0]);
    expect(at(valueOf(-1))).toEqual([128 / 255, 128 / 255, 128 / 255]);
  });
});

describe('cellTypeColumnFor', () => {
  const ds = (names: [string, 'categorical' | 'continuous'][]) => ({
    columns: names.map(([name, kind]) => kind === 'categorical'
      ? { kind, name, categories: ['a'] } : { kind, name }),
  }) as unknown as SpatialDataset;

  it('prefers the pipeline clustering over a curated annotation by default', () => {
    const d = ds([['cell_area', 'continuous'], ['curated_cell_type', 'categorical'], ['graphclust', 'categorical']]);
    expect(cellTypeColumnFor(d, { cellTypeColumn: null })).toBe('graphclust');
  });

  it('honours an explicit choice, including the curated one', () => {
    const d = ds([['graphclust', 'categorical'], ['curated_cell_type', 'categorical']]);
    expect(cellTypeColumnFor(d, { cellTypeColumn: 'curated_cell_type' })).toBe('curated_cell_type');
  });

  it('ignores a choice this dataset does not have, and a continuous column', () => {
    const d = ds([['graphclust', 'categorical'], ['cell_area', 'continuous']]);
    expect(cellTypeColumnFor(d, { cellTypeColumn: 'nope' })).toBe('graphclust');
    expect(cellTypeColumnFor(d, { cellTypeColumn: 'cell_area' })).toBe('graphclust');
  });

  it('falls back to a curated column when it is the only categorical', () => {
    expect(cellTypeColumnFor(ds([['curated_cell_type', 'categorical']]), { cellTypeColumn: null }))
      .toBe('curated_cell_type');
    expect(cellTypeColumnFor(ds([['cell_area', 'continuous']]), { cellTypeColumn: null })).toBeNull();
  });
});

describe('smoothRaster / colorDensity', () => {
  it('spreads a single count while conserving its mass (away from the edges)', () => {
    const v = new Float32Array(15 * 15);
    v[7 * 15 + 7] = 10;
    const s = smoothRaster(v, 15, 15, 1.5);
    const total = s.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(10, 3);
    expect(s[7 * 15 + 7]).toBeLessThan(10);
    expect(s[7 * 15 + 8]).toBeGreaterThan(0);
  });

  it('is the identity for sigma 0', () => {
    const v = Float32Array.from([1, 2, 3, 4]);
    expect(Array.from(smoothRaster(v, 2, 2, 0))).toEqual([1, 2, 3, 4]);
  });

  it('leaves empty cells transparent and saturates the top of the window', () => {
    const lut: [number, number, number][] = [[0, 0, 0], [255, 255, 255]];
    const rgba = colorDensity(Float32Array.from([0, 1, 100]), lut, 1, { percentile: 0.5 });
    expect(rgba[3]).toBe(0); // zero → transparent
    expect(rgba[8 + 3]).toBe(255); // top of window → opaque
    expect(rgba[8]).toBe(255);
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

describe('all-gene grouping', () => {
  // The cervical bundle: ~9 mm square, ~1.04 billion transcripts (~13 per µm²).
  const bounds: [number, number, number, number] = [0, 0, 9000, 9000];
  const total = 1.04e9;
  const levels = Array.from({ length: 7 }, (_v, m) => ({ binSize: (250 / 128) * 2 ** m }));
  const view = (w: number) => ({ x0: 4000, y0: 4000, x1: 4000 + w, y1: 4000 + w * 0.65 });
  const plan = (w: number, budget = 100_000) => allGenesPlan({
    rect: view(w), bounds, total, pxPerUnit: 1260 / w, levels, budget, canIndividual: true,
  });

  it('draws every transcript once those in view fit the budget', () => {
    // 60 µm wide: ~30k transcripts.
    expect(plan(60)).toEqual({ kind: 'individual' });
  });

  it('groups into the finest readable bins when they do not', () => {
    // 250 µm wide: ~500k transcripts — too many, so bins. 1.95 µm bins would be ~10 px
    // apart, under the 14 px floor, so the 3.9 µm level (~20 px) is the finest readable.
    expect(plan(250)).toEqual({ kind: 'bins', level: 1 });
  });

  it('coarsens as the camera zooms out, never exceeding the budget or crowding the screen', () => {
    let previous = -1;
    for (const w of [500, 1000, 2000, 4000, 9000]) {
      const p = plan(w);
      expect(p.kind).toBe('bins');
      const level = (p as { level: number }).level;
      expect(level).toBeGreaterThanOrEqual(previous);
      const bin = levels[level].binSize;
      expect(bin * (1260 / w)).toBeGreaterThanOrEqual(14); // groups ≥ 14 px apart
      previous = level;
    }
  });

  it('a smaller budget switches to groups sooner', () => {
    expect(plan(60, 10_000).kind).toBe('bins');
  });

  it('draws nothing for a view outside the tissue', () => {
    expect(allGenesPlan({
      rect: { x0: -500, y0: -500, x1: -100, y1: -100 }, bounds, total, pxPerUnit: 1,
      levels, budget: 1e5, canIndividual: true,
    })).toEqual({ kind: 'none' });
    expect(visibleArea({ x0: -10, y0: 0, x1: 10, y1: 10 }, bounds)).toBe(100);
  });

  it('sizes a group by its share of a busy bin, within the bin', () => {
    expect(groupedMarkerPx(100, 100, 20)).toBeCloseTo(20 * 1.1, 6);
    expect(groupedMarkerPx(25, 100, 20)).toBeCloseTo(20 * (0.35 + 0.75 * 0.5), 6);
    expect(groupedMarkerPx(1, 100, 4)).toBeGreaterThanOrEqual(4); // never below the floor
    expect(groupedMarkerPx(10_000, 100, 20)).toBeLessThanOrEqual(24); // outliers capped
  });

  it('quantileOf picks a high percentile of the counts', () => {
    const v = Uint32Array.from({ length: 100 }, (_v, i) => i + 1);
    expect(quantileOf(v, 0.95)).toBe(96);
    expect(quantileOf(new Uint32Array(0), 0.95)).toBe(0);
  });

  it('tilesInRectFrom honours a grid origin', () => {
    const keys = tilesInRectFrom([-250, 0], { x0: -240, y0: 10, x1: -10, y1: 20 }, 0, [{ tileSize: 125 }]);
    expect(keys.map((k) => k.gx).sort()).toEqual([0, 1]);
  });
});

describe('INFERNO_SCALE', () => {
  it('resolves through the LUT factory from black-purple to pale yellow', () => {
    const lut = lutFor(INFERNO_SCALE);
    expect(lut[0]).toEqual([0, 0, 4]);
    expect(lut[lut.length - 1]).toEqual([252, 255, 164]);
  });
});

describe('grouping a gene selection by zoom', () => {
  it('uses the pyramid ladder: the finest bin at least 14 px apart, none when zoomed in', () => {
    const base = 250 / 128;
    expect(geneBinSize(10, base)).toBeNull();          // 19.5 px per base bin: draw each transcript
    expect(geneBinSize(1, base)).toBeCloseTo(base * 8); // 15.6 px at 8× the base bin
    expect(geneBinSize(0.001, base, 7)).toBeCloseTo(base * 64); // capped at the coarsest level
    expect(geneBinSize(0, base)).toBeNull();
  });

  it('groups each gene on its own, at the weighted centroid, in the cell holding most', () => {
    const t: SpatialTranscriptTile = {
      count: 4, aggregated: false,
      x: new Float32Array([1, 3, 2, 30]), y: new Float32Array([1, 1, 2, 30]), z: new Float32Array(4),
      weight: new Uint32Array([1, 3, 1, 1]), observation: new Uint32Array([7, 8, 9, 9]),
      gene: new Uint16Array([0, 0, 1, 0]),
    };
    const g = groupTranscriptsByGene(t, 10);
    expect(g.count).toBe(3); // gene 0 near the origin, gene 1 there too, gene 0 far away
    expect(g.aggregated).toBe(true);
    expect(Array.from(g.weight)).toEqual([4, 1, 1]);
    expect(g.x[0]).toBeCloseTo((1 + 3 * 3) / 4);
    expect(g.observation[0]).toBe(8); // the entry standing for 3 transcripts
    expect(Array.from(g.gene)).toEqual([0, 1, 0]);
  });
});
