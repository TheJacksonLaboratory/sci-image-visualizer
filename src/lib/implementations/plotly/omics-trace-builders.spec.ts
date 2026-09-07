import {
  buildCountTraces, buildHeatmapTraces, countByCategory, countsLayout, heatmapLayout,
  OmicsGrouping, OmicsTraceInput, benefitsFromGrouping, buildOmicsTraces, omicsLayout,
} from './omics-trace-builders';
import { NO_CATEGORY } from '../../contracts/spatial-dataset.contract';

const input = (over: Partial<OmicsTraceInput> = {}): OmicsTraceInput => ({
  values: new Float32Array([1, 2, 3, 4]),
  name: 'total_counts',
  ...over,
});

const group = (over: Partial<OmicsGrouping> = {}): OmicsGrouping => ({
  codes: new Uint16Array([0, 0, 1, 1]),
  categories: ['A', 'B'],
  colors: ['#ff0000', '#0000ff'],
  ...over,
});

/** Traces as loosely-typed records, for readable assertions. */
const asRecords = (traces: unknown[]) => traces as Record<string, any>[];

describe('omics-trace-builders', () => {
  describe('histogram', () => {
    it('charts the full distribution', () => {
      const [all] = asRecords(buildOmicsTraces('histogram', input()));
      expect(all.type).toBe('histogram');
      expect(all.x).toEqual([1, 2, 3, 4]);
      expect(all.name).toBe('All');
      expect(all.opacity).toBe(1);
    });

    it('overlays a Selected trace so the two are comparable', () => {
      const traces = asRecords(buildOmicsTraces('histogram', input({
        selection: new Uint8Array([0, 1, 1, 0]),
      })));
      expect(traces).toHaveLength(2);
      expect(traces[0].x).toEqual([1, 2, 3, 4]);   // all, muted
      expect(traces[0].opacity).toBeLessThan(1);
      expect(traces[1].name).toBe('Selected');
      expect(traces[1].x).toEqual([2, 3]);
    });

    it('ignores an all-zero selection mask (nothing is actually selected)', () => {
      const traces = buildOmicsTraces('histogram', input({
        selection: new Uint8Array([0, 0, 0, 0]),
      }));
      expect(traces).toHaveLength(1);
    });

    it('drops non-finite values rather than plotting gaps', () => {
      const [all] = asRecords(buildOmicsTraces('histogram', input({
        values: new Float32Array([1, NaN, 3]),
      })));
      expect(all.x).toEqual([1, 3]);
    });

    it('log-scales when asked', () => {
      const [all] = asRecords(buildOmicsTraces('histogram', input({
        values: new Float32Array([0, 9]), log: true,
      })));
      expect(all.x[0]).toBeCloseTo(0);
      expect(all.x[1]).toBeCloseTo(Math.log1p(9));
    });

    it('clamps negatives before log so log1p never returns NaN', () => {
      const [all] = asRecords(buildOmicsTraces('histogram', input({
        values: new Float32Array([-5]), log: true,
      })));
      expect(all.x).toEqual([0]);
    });
  });

  describe('violin / box', () => {
    it.each(['violin', 'box'] as const)('%s: one trace per category, in its map colour', (kind) => {
      const traces = asRecords(buildOmicsTraces(kind, input({ group: group() })));
      expect(traces).toHaveLength(2);
      expect(traces[0]).toEqual(expect.objectContaining({ type: kind, name: 'A', y: [1, 2] }));
      expect(traces[0].marker.color).toBe('#ff0000');
      expect(traces[1]).toEqual(expect.objectContaining({ name: 'B', y: [3, 4] }));
    });

    it('violin shows its box and mean line (a bare violin hides the quartiles)', () => {
      const [t] = asRecords(buildOmicsTraces('violin', input({ group: group() })));
      expect(t.box).toEqual({ visible: true });
      expect(t.meanline).toEqual({ visible: true });
    });

    it('falls back to a single trace when there is no grouping', () => {
      const traces = asRecords(buildOmicsTraces('violin', input()));
      expect(traces).toHaveLength(1);
      expect(traces[0].y).toEqual([1, 2, 3, 4]);
      expect(traces[0].name).toBe('All');
    });

    it('narrows TO the selection rather than overlaying it', () => {
      const traces = asRecords(buildOmicsTraces('violin', input({
        group: group(), selection: new Uint8Array([1, 0, 0, 1]),
      })));
      expect(traces).toHaveLength(2);
      expect(traces[0].y).toEqual([1]);
      expect(traces[1].y).toEqual([4]);
    });

    it('labels a single ungrouped trace as Selected when one is active', () => {
      const [t] = asRecords(buildOmicsTraces('box', input({
        selection: new Uint8Array([0, 0, 1, 1]),
      })));
      expect(t.name).toBe('Selected');
      expect(t.y).toEqual([3, 4]);
    });

    it('drops empty categories — an empty violin reads as data', () => {
      const traces = asRecords(buildOmicsTraces('violin', input({
        group: group({ codes: new Uint16Array([0, 0, 0, 0]) }),
      })));
      expect(traces).toHaveLength(1);
      expect(traces[0].name).toBe('A');
    });

    it('skips NO_CATEGORY and out-of-range codes instead of misbucketing them', () => {
      const traces = asRecords(buildOmicsTraces('violin', input({
        group: group({ codes: new Uint16Array([0, NO_CATEGORY, 7, 1]) }),
      })));
      expect(traces.map((t) => [t.name, t.y])).toEqual([['A', [1]], ['B', [4]]]);
    });

    it('returns no traces when everything is filtered out', () => {
      expect(buildOmicsTraces('violin', input({
        values: new Float32Array([NaN, NaN]), selection: null,
      }))).toEqual([]);
    });

    it('thins a very large sample instead of handing Plotly 84k points', () => {
      const big = new Float32Array(60_000);
      for (let i = 0; i < big.length; i++) big[i] = i;
      const [t] = asRecords(buildOmicsTraces('violin', input({ values: big })));
      expect(t.y.length).toBe(20_000);
      // Thinning is even, so the distribution's ends survive.
      expect(t.y[0]).toBe(0);
      expect(t.y[t.y.length - 1]).toBeGreaterThan(55_000);
    });
  });

  describe('omicsLayout', () => {
    it('labels the value axis, and marks it as log when scaled', () => {
      expect((omicsLayout('histogram', input()) as any).xaxis.title.text).toBe('total_counts');
      expect((omicsLayout('histogram', input({ log: true })) as any).xaxis.title.text)
        .toBe('log1p(total_counts)');
    });

    it('puts the value on Y for violin/box and on X for a histogram', () => {
      expect((omicsLayout('violin', input()) as any).yaxis.title.text).toBe('total_counts');
      expect((omicsLayout('histogram', input()) as any).yaxis.title.text).toBe('observations');
    });

    it('shows a legend only when the histogram has something to compare', () => {
      expect((omicsLayout('histogram', input()) as any).showlegend).toBe(false);
      expect((omicsLayout('histogram', input({
        selection: new Uint8Array([1, 0, 0, 0]),
      })) as any).showlegend).toBe(true);
      expect((omicsLayout('violin', input({
        selection: new Uint8Array([1, 0, 0, 0]),
      })) as any).showlegend).toBe(false);
    });

    it('overlays histogram bars rather than stacking them', () => {
      expect((omicsLayout('histogram', input()) as any).barmode).toBe('overlay');
    });
  });

  describe('benefitsFromGrouping', () => {
    it('is true for the per-category charts only', () => {
      expect(benefitsFromGrouping('violin')).toBe(true);
      expect(benefitsFromGrouping('box')).toBe(true);
      expect(benefitsFromGrouping('histogram')).toBe(false);
      expect(benefitsFromGrouping('counts')).toBe(false);
    });
  });

  describe('counts (the distribution a CATEGORICAL column has)', () => {
    const group = (codes: number[], n = 3) => ({
      codes: Uint16Array.from(codes),
      categories: Array.from({ length: n }, (_, i) => `c${i}`),
      colors: Array.from({ length: n }, (_, i) => `#00000${i}`),
    });

    it('counts per category, biggest first, with its own colours', () => {
      const { labels, totals, colors } = countByCategory({ group: group([0, 1, 1, 2, 1]) });
      // 3, 1, 1 — by count, and ties keep CATEGORY order (a stable sort), so the
      // bars do not reshuffle between two datasets that happen to tie.
      expect(labels).toEqual(['c1', 'c0', 'c2']);
      expect(totals).toEqual([3, 1, 1]);
      expect(colors[0]).toBe('#000001');
    });

    it('skips unassigned observations rather than counting them as a category', () => {
      const g = group([0, NO_CATEGORY, 0]);
      const { labels, totals } = countByCategory({ group: g });
      expect(labels).toEqual(['c0']);
      expect(totals).toEqual([2]);
    });

    it('folds the tail into one aggregate bar rather than dropping it', () => {
      // 338 subclasses do not fit a readable axis, but showing 25 of them silently
      // would misstate the whole.
      const codes = Array.from({ length: 60 }, (_, i) => i % 30);
      const { labels, totals } = countByCategory({ group: group(codes, 30), max: 25 });
      expect(labels).toHaveLength(26);
      expect(labels.at(-1)).toBe('other (5 categories)');
      expect(totals.reduce((a, b) => a + b, 0)).toBe(60); // nothing lost
    });

    it('shows the selection against the total, overlaid', () => {
      const input = {
        group: group([0, 0, 1, 1]),
        selection: new Uint8Array([1, 0, 0, 0]),
      };
      const traces = buildCountTraces(input) as any[];
      expect(traces).toHaveLength(2);
      expect(traces[0].name).toBe('All');
      expect(traces[1].name).toBe('Selected');
      // Reversed for the horizontal axis, so the biggest bar sits at the top.
      expect(traces[1].y).toEqual(['c1', 'c0']);
      expect(traces[1].x).toEqual([0, 1]);
      expect((countsLayout({ ...input, name: 'region' }) as any).barmode).toBe('overlay');
    });

    it('grows the plot height with the bar count', () => {
      const few = countsLayout({ group: group([0, 1]), name: 'region' }) as any;
      const many = countsLayout({
        group: group(Array.from({ length: 40 }, (_, i) => i % 20), 20), name: 'region',
      }) as any;
      expect(many.height).toBeGreaterThan(few.height);
    });

    it('draws no bar for a category nothing is assigned to', () => {
      const traces = buildCountTraces({ group: group([0, 0], 3) }) as any[];
      expect(traces[0].y).toEqual(['c0']);
    });
  });

  describe('heatmap (genes x groups)', () => {
    const input = {
      rows: ['g1', 'g2'],
      cols: ['A', 'B', 'C'],
      // row-major: g1 across A,B,C then g2
      values: Float32Array.from([1, 2, NaN, -1, 0, 3]),
      counts: Uint32Array.from([10, 20, 30]),
      zScored: true,
      groupLabel: 'class',
    };

    it('flips the rows, because Plotly draws z[0] at the bottom', () => {
      // The caller lists genes top-down; Plotly stacks upward. Without the flip
      // the row labels and the values would disagree.
      const [tr] = buildHeatmapTraces(input) as any[];
      expect(tr.type).toBe('heatmap');
      expect(tr.y).toEqual(['g2', 'g1']);
      expect(tr.z[0]).toEqual([-1, 0, 3]); // g2
      expect(tr.z[1]).toEqual([1, 2, null]); // g1, with the gap as null
      expect(tr.x).toEqual(['A', 'B', 'C']);
    });

    it('draws an unmeasured cell as a gap, not as the scale bottom', () => {
      const [tr] = buildHeatmapTraces(input) as any[];
      // NaN became null and gaps are not coloured — "nothing was measured" is
      // not the same statement as "a low mean".
      expect(tr.z[1][2]).toBeNull();
      expect(tr.hoverongaps).toBe(false);
    });

    it('centres the scale on zero when z-scored, since the sign is the reading', () => {
      const [tr] = buildHeatmapTraces(input) as any[];
      expect(tr.zmin).toBeCloseTo(-3, 5);
      expect(tr.zmax).toBeCloseTo(3, 5);
      expect(tr.colorscale[1][1]).toBe('#F7F7F7'); // white at the midpoint
    });

    it('uses a sequential scale and no forced centre for raw means', () => {
      // Raw means have no meaningful zero crossing, so a diverging scale would
      // imply one.
      const [tr] = buildHeatmapTraces({ ...input, zScored: false }) as any[];
      expect(tr.zmin).toBeUndefined();
      expect(tr.zmax).toBeUndefined();
      expect(tr.colorscale[0][1]).toBe('#F7FBFF');
    });

    it('puts the cell count behind each column in the hover', () => {
      const [tr] = buildHeatmapTraces(input) as any[];
      expect(tr.customdata[0]).toEqual(['A · 10 cells', 'B · 20 cells', 'C · 30 cells']);
    });

    it('draws nothing for an empty matrix', () => {
      expect(buildHeatmapTraces({ ...input, rows: [], values: new Float32Array(0) })).toEqual([]);
      expect(buildHeatmapTraces({ ...input, cols: [], values: new Float32Array(0) })).toEqual([]);
    });

    it('grows its height with the gene count', () => {
      const short = heatmapLayout(input) as any;
      const tall = heatmapLayout({
        ...input,
        rows: Array.from({ length: 20 }, (_, i) => `g${i}`),
      }) as any;
      expect(tall.height).toBeGreaterThan(short.height);
      expect(short.xaxis.title.text).toBe('class');
    });
  });

});
