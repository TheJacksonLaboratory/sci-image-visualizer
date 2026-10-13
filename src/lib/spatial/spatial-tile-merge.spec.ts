import { DEFAULT_SPATIAL_VIEW } from '../contracts/display-types';
import {
  NO_CATEGORY,
  NO_OBSERVATION,
  SpatialDensityRaster,
  SpatialPolygonTile,
  SpatialTranscriptTile,
} from '../contracts/spatial-dataset.contract';
import {
  clusterMarkers,
  filterRings,
  filterTranscripts,
  hiddenGeneSlots,
  median,
  mergePolygonTiles,
  mergeTranscriptTiles,
} from './spatial-tile-merge';

const tile = (xs: number[], ys: number[], weight = 1): SpatialTranscriptTile => ({
  count: xs.length,
  aggregated: weight > 1,
  x: Float32Array.from(xs),
  y: Float32Array.from(ys),
  z: new Float32Array(xs.length),
  weight: new Uint32Array(xs.length).fill(weight),
  observation: Uint32Array.from(xs.map((_v, i) => i)),
  gene: new Uint16Array(xs.length),
});

describe('tile merging', () => {
  it('concatenates transcript tiles and stops at the limit', () => {
    const m = mergeTranscriptTiles([tile([1, 2], [3, 4]), tile([5], [6])], 2);
    expect(m.count).toBe(2);
    expect(Array.from(m.x)).toEqual([1, 2]);
  });

  it('drops a ring listed by two tiles', () => {
    const t = (obs: number[]) => ({
      count: obs.length,
      observation: Uint32Array.from(obs),
      offsets: Uint32Array.from(obs.map((_o, i) => i * 3).concat(obs.length * 3)),
      coords: new Float32Array(obs.length * 6).map((_v, i) => i),
    });
    const m = mergePolygonTiles([t([7, 8]), t([8, 9])]);
    expect(Array.from(m.observation)).toEqual([7, 8, 9]);
    expect(m.offsets[m.count]).toBe(9);
  });
});

describe('clusterMarkers (a zoomed-out selection, from density grids)', () => {
  it("sums each cluster's grid cells per square, at their count-weighted centre", () => {
    const raster = (values: number[]): SpatialDensityRaster => ({
      meta: { gridSize: [10, 10], origin: [0, 0], rows: 2, cols: 2 },
      genes: [],
      values: Float32Array.from(values),
    });
    // One 20-unit square holds all four cells. Cluster 0 is mostly in the top-left cell.
    const { tile, group } = clusterMarkers([raster([3, 1, 0, 0]), raster([0, 0, 0, 2])], [5, 7], 20, {
      x0: 0,
      y0: 0,
      x1: 20,
      y1: 20,
    });
    expect(tile.count).toBe(2);
    expect(Array.from(group)).toEqual([0, 1]);
    expect(Array.from(tile.weight)).toEqual([4, 2]);
    expect(tile.x[0]).toBeCloseTo((3 * 5 + 1 * 15) / 4); // pulled toward the busier cell
    expect(tile.x[1]).toBeCloseTo(15);
    expect(Array.from(tile.gene)).toEqual([5, 7]); // each cluster's icon gene
    expect(tile.observation[0]).toBe(NO_OBSERVATION);
  });
});

describe('filtering hidden groups and genes', () => {
  // Three cells: codes 0 (shown), 1 (hidden) and none.
  const hidden = { codes: Uint16Array.of(0, 1, NO_CATEGORY), hidden: Uint8Array.of(0, 1) };

  it('drops the rings of cells in a hidden group, keeping their vertices aligned', () => {
    const rings: SpatialPolygonTile = {
      count: 3,
      observation: Uint32Array.of(0, 1, 2),
      offsets: Uint32Array.of(0, 3, 6, 9),
      coords: new Float32Array(18).map((_v, i) => i),
    };
    const out = filterRings(rings, hidden);
    expect(Array.from(out.observation)).toEqual([0, 2]);
    expect(Array.from(out.offsets)).toEqual([0, 3, 6]);
    expect(Array.from(out.coords.subarray(6))).toEqual([12, 13, 14, 15, 16, 17]);
    expect(filterRings(rings, null)).toBe(rings);
  });

  it('drops transcripts in a hidden cell or of a hidden gene, with their sizes', () => {
    const t = tile([1, 2, 3, 4], [0, 0, 0, 0]);
    t.observation = Uint32Array.of(0, 1, NO_OBSERVATION, 0);
    t.gene = Uint16Array.of(0, 0, 0, 1);
    const px = Float32Array.of(10, 20, 30, 40);
    const out = filterTranscripts(t, px, hidden, Uint8Array.of(0, 1));
    expect(Array.from(out.merged.x)).toEqual([1, 3]); // hidden cell and hidden gene gone
    expect(Array.from(out.px)).toEqual([10, 30]);
    expect(filterTranscripts(t, px, null, null).merged).toBe(t);
  });

  it('names the selected genes switched off with their eye toggle', () => {
    const view = { ...DEFAULT_SPATIAL_VIEW, transcriptGenes: ['A', 'B', 'C'], transcriptHiddenGenes: ['B'] };
    expect(Array.from(hiddenGeneSlots(view)!)).toEqual([0, 1, 0]);
    expect(hiddenGeneSlots({ ...view, transcriptHiddenGenes: [] })).toBeNull();
  });
});

describe('median', () => {
  it('takes the middle of a (sampled) vector, and 0 of an empty one', () => {
    expect(median(Float32Array.of(5, 1, 3))).toBe(3);
    expect(median(new Float32Array(0))).toBe(0);
  });
});
