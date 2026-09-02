import {
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
    });
  });
});
