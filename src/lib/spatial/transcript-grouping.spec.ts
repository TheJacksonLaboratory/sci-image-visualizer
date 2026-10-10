import { SpatialTranscriptTile } from '../contracts/spatial-dataset.contract';
import { tilesInRectFrom, visibleArea } from './lod';
import {
  TRANSCRIPT_MAX_PX, TRANSCRIPT_MIN_PX, TRANSCRIPT_PHYSICAL_UM, allGenesPlan, clusterColorMap, clusterOfGene,
  geneBinSize, groupTranscripts, groupedMarkerPx, quantileOf, transcriptMarkerPx,
} from './transcript-grouping';

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
    expect(quantileOf(v, 0.95)).toBe(95);
    expect(quantileOf(new Uint32Array(0), 0.95)).toBe(0);
  });

  it('tilesInRectFrom honours a grid origin', () => {
    const keys = tilesInRectFrom([-250, 0], { x0: -240, y0: 10, x1: -10, y1: 20 }, 0, [{ tileSize: 125 }]);
    expect(keys.map((k) => k.gx).sort()).toEqual([0, 1]);
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

  it('groups each gene on its own by default, at the weighted centroid, in the cell holding most', () => {
    const t: SpatialTranscriptTile = {
      count: 4, aggregated: false,
      x: new Float32Array([1, 3, 2, 30]), y: new Float32Array([1, 1, 2, 30]), z: new Float32Array(4),
      weight: new Uint32Array([1, 3, 1, 1]), observation: new Uint32Array([7, 8, 9, 9]),
      gene: new Uint16Array([0, 0, 1, 0]),
    };
    const { tile: g } = groupTranscripts(t, 10);
    expect(g.count).toBe(3); // gene 0 near the origin, gene 1 there too, gene 0 far away
    expect(g.aggregated).toBe(true);
    expect(Array.from(g.weight)).toEqual([4, 1, 1]);
    expect(g.x[0]).toBeCloseTo((1 + 3 * 3) / 4);
    expect(g.observation[0]).toBe(8); // the entry standing for 3 transcripts
    expect(Array.from(g.gene)).toEqual([0, 1, 0]);
  });

  it('takes the cell holding most transcripts in total, not the heaviest single one', () => {
    const t: SpatialTranscriptTile = {
      count: 4, aggregated: false,
      x: new Float32Array([1, 2, 3, 4]), y: new Float32Array(4), z: new Float32Array(4),
      weight: new Uint32Array([2, 1, 1, 1]), observation: new Uint32Array([8, 7, 7, 7]),
      gene: new Uint16Array(4),
    };
    expect(groupTranscripts(t, 10).tile.observation[0]).toBe(7); // 3 in cell 7, 2 in cell 8
  });

  it('merges the genes of one cluster into one marker, showing its dominant gene', () => {
    const t: SpatialTranscriptTile = {
      count: 4, aggregated: false,
      x: new Float32Array([1, 2, 3, 4]), y: new Float32Array([1, 2, 3, 4]), z: new Float32Array(4),
      weight: new Uint32Array([1, 1, 5, 1]), observation: new Uint32Array(4),
      gene: new Uint16Array([0, 1, 1, 2]),
    };
    // Genes 0 and 1 are one cluster (key 0); gene 2 is its own (key 9).
    const { tile, group } = groupTranscripts(t, 10, (slot) => (slot <= 1 ? 0 : 9));
    expect(tile.count).toBe(2);
    expect(Array.from(group)).toEqual([0, 9]);
    expect(Array.from(tile.weight)).toEqual([7, 1]);
    expect(tile.gene[0]).toBe(1); // gene 1 holds 6 of the cluster's 7
  });

  it('matches the string-keyed reference on a dense random tile, ties included', () => {
    // The original algorithm, kept here as the oracle: a template-string key per transcript
    // and a Map per entry, dominant = largest total, first seen on a tie.
    const reference = (t: SpatialTranscriptTile, bin: number, groupOf: (g: number) => number) => {
      const index = new Map<string, number>();
      const w: number[] = [];
      const sx: number[] = [];
      const genesW: Map<number, number>[] = [];
      const obsW: Map<number, number>[] = [];
      const grp: number[] = [];
      for (let i = 0; i < t.count; i++) {
        const gk = groupOf(t.gene[i]);
        const key = `${gk}|${Math.floor(t.x[i] / bin)}|${Math.floor(t.y[i] / bin)}`;
        let k = index.get(key);
        const wi = t.weight[i] || 1;
        if (k === undefined) {
          k = w.length; index.set(key, k);
          w.push(0); sx.push(0); grp.push(gk); genesW.push(new Map()); obsW.push(new Map());
        }
        w[k] += wi; sx[k] += t.x[i] * wi;
        genesW[k].set(t.gene[i], (genesW[k].get(t.gene[i]) ?? 0) + wi);
        obsW[k].set(t.observation[i], (obsW[k].get(t.observation[i]) ?? 0) + wi);
      }
      const dominant = (m: Map<number, number>) => {
        let best = 0; let top = -1;
        for (const [key, v] of m) if (v > top) { top = v; best = key; }
        return best;
      };
      return {
        weight: w, group: grp, x: sx.map((v, k) => v / w[k]),
        gene: genesW.map(dominant), observation: obsW.map(dominant),
      };
    };
    let seed = 11;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor((seed / 2147483648) * n);
    };
    const n = 3000;
    const t: SpatialTranscriptTile = {
      count: n, aggregated: false,
      x: Float32Array.from({ length: n }, () => rand(400) - 200),
      y: Float32Array.from({ length: n }, () => rand(300) - 100),
      z: new Float32Array(n),
      // Small weights and few genes and cells, so ties are common.
      weight: Uint32Array.from({ length: n }, () => rand(3)),
      observation: Uint32Array.from({ length: n }, () => (rand(5) === 0 ? 0xffffffff : rand(4))),
      gene: Uint16Array.from({ length: n }, () => rand(6)),
    };
    const groupOf = (g: number) => (g < 3 ? 0 : g);
    const want = reference(t, 50, groupOf);
    const got = groupTranscripts(t, 50, groupOf);
    expect(Array.from(got.tile.weight)).toEqual(want.weight);
    expect(Array.from(got.group)).toEqual(want.group);
    expect(Array.from(got.tile.gene)).toEqual(want.gene);
    expect(Array.from(got.tile.observation)).toEqual(want.observation);
    got.tile.x.forEach((v, k) => expect(v).toBeCloseTo(want.x[k], 3));
  });

});

describe('cluster colours', () => {
  const groups = [{ name: 'Cluster 27', genes: ['CD55', 'TFF3'] }, { name: 'Cluster 28', genes: ['TNS4', 'SOCS3'] }];
  const genes = ['CD55', 'TFF3', 'TNS4', 'SOCS3', 'LONE'];

  it('gives every gene of a cluster one colour, a different one per cluster', () => {
    const map = clusterColorMap(genes, groups, new Map(), ['#a', '#b', '#c']);
    expect(map.get(clusterOfGene('CD55', groups))).toBe(map.get(clusterOfGene('TFF3', groups)));
    expect(map.get('Cluster 27')).not.toBe(map.get('Cluster 28'));
    expect(map.get('LONE')).toBe('#c'); // an ungrouped gene is its own cluster
  });

  it('takes the colour of the cell group of the same name, palette for the rest in tree order', () => {
    const map = clusterColorMap(genes, groups, new Map([['Cluster 28', '#ff0000']]), ['#a', '#b']);
    expect(map.get('Cluster 28')).toBe('#ff0000');
    expect(map.get('Cluster 27')).toBe('#a');
    expect(map.get('LONE')).toBe('#b');
  });
});
