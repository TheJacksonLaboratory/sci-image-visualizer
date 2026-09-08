import {
  UMAP_MAX_LEGEND_CATEGORIES, UMAP_MAX_LEGEND_SHOWN, buildUmapTraces, umapLayout,
} from './omics-trace-builders';
import { NO_CATEGORY } from '../../contracts/spatial-dataset.contract';

/**
 * The embedding scatter.
 *
 * Read beside the tissue map: the map says where a population sits, the embedding says which
 * populations exist and how close they are in expression. What matters here is that a category
 * keeps its colour and its name, that a selection dims rather than deletes context, and that the
 * axes cannot invent structure.
 */
describe('buildUmapTraces', () => {
  const f32 = (...v: number[]) => Float32Array.from(v);
  const cats = (names: string[], colors: string[], codes: number[]) =>
    ({ names, colors, codes: Uint16Array.from(codes) });

  it('draws one trace per category, so the legend can isolate one', () => {
    // A trace each is what makes the legend entries toggle — clicking a population to
    // isolate it is how these plots are read.
    const traces = buildUmapTraces({
      x: f32(1, 2, 3, 4), y: f32(5, 6, 7, 8), label: 'UMAP',
      categories: cats(['A', 'B'], ['#f00', '#00f'], [0, 1, 0, 1]),
    }) as any[];
    expect(traces).toHaveLength(2);
    expect(traces.map((t) => t.name)).toEqual(['A', 'B']);
    expect(traces[0].marker.color).toBe('#f00');
    expect(traces[0].x).toEqual([1, 3]);
    expect(traces[1].x).toEqual([2, 4]);
  });

  it('uses scattergl, not svg', () => {
    // 10^4-10^6 points: the SVG renderer would not survive it.
    const traces = buildUmapTraces({ x: f32(1), y: f32(2), label: 'UMAP' }) as any[];
    expect(traces[0].type).toBe('scattergl');
  });

  it('names the category in the hover', () => {
    const traces = buildUmapTraces({
      x: f32(1, 2), y: f32(3, 4), label: 'UMAP',
      categories: cats(['Gut tube', 'Endothelium'], ['#f00', '#00f'], [0, 1]),
    }) as any[];
    expect(traces[0].hovertemplate).toContain('Gut tube');
  });

  it('drops unassigned observations rather than colouring them as a population', () => {
    // NO_CATEGORY is "we do not know", which must not acquire a colour and a legend
    // entry of its own — that reads as a real class.
    const traces = buildUmapTraces({
      x: f32(1, 2, 3), y: f32(4, 5, 6), label: 'UMAP',
      categories: cats(['A'], ['#f00'], [0, NO_CATEGORY, 0]),
    }) as any[];
    expect(traces).toHaveLength(1);
    expect(traces[0].x).toEqual([1, 3]);
  });

  it('omits a category with no points instead of an empty legend entry', () => {
    const traces = buildUmapTraces({
      x: f32(1), y: f32(2), label: 'UMAP',
      categories: cats(['present', 'absent'], ['#f00', '#00f'], [0]),
    }) as any[];
    expect(traces.map((t) => t.name)).toEqual(['present']);
  });

  it('collapses to a single trace past the legend cap', () => {
    // 338 subclasses would be 338 traces and an unreadable legend. One trace with a
    // per-point colour still draws, and the hover still names the category.
    const n = UMAP_MAX_LEGEND_CATEGORIES + 1;
    const names = Array.from({ length: n }, (_, i) => `c${i}`);
    const colors = Array.from({ length: n }, () => '#123456');
    const traces = buildUmapTraces({
      x: f32(...Array.from({ length: n }, (_, i) => i)),
      y: f32(...Array.from({ length: n }, (_, i) => i)),
      label: 'UMAP',
      categories: cats(names, colors, Array.from({ length: n }, (_, i) => i)),
    }) as any[];
    expect(traces).toHaveLength(1);
    expect(Array.isArray(traces[0].marker.color)).toBe(true);
    expect(traces[0].hovertemplate).toContain('%{text}');
    expect(traces[0].text[3]).toBe('c3');
  });

  it('draws a legend for a handful of categories', () => {
    const traces = buildUmapTraces({
      x: f32(1, 2), y: f32(1, 2), label: 'UMAP',
      categories: cats(['A', 'B'], ['#f00', '#00f'], [0, 1]),
    }) as any[];
    expect(traces.every((t) => t.showlegend === true)).toBe(true);
  });

  it('drops the legend past what a docked panel can fit, keeping the traces split', () => {
    // seqFISH's 22 cell types stack into one tall column, overlapping the axis title and
    // running off the panel. The colours already match the map, which lists them, and
    // hover names the one under the cursor — so the plot takes the space instead.
    const n = UMAP_MAX_LEGEND_SHOWN + 1;
    const names = Array.from({ length: n }, (_, i) => `c${i}`);
    const traces = buildUmapTraces({
      x: f32(...Array.from({ length: n }, (_, i) => i)),
      y: f32(...Array.from({ length: n }, (_, i) => i)),
      label: 'UMAP',
      categories: cats(names, names.map(() => '#123456'),
        Array.from({ length: n }, (_, i) => i)),
    }) as any[];
    // Still one trace each — hover keeps naming the category.
    expect(traces).toHaveLength(n);
    expect(traces.every((t) => t.showlegend === false)).toBe(true);
    expect(traces[0].hovertemplate).toContain('c0');
  });

  it('dims unselected points rather than removing them', () => {
    // The shape of the whole embedding is the context that makes a selection legible;
    // dropping it would leave a few dots floating in an empty plane.
    const traces = buildUmapTraces({
      x: f32(1, 2, 3, 4), y: f32(1, 2, 3, 4), label: 'UMAP',
      categories: cats(['A'], ['#f00'], [0, 0, 0, 0]),
      selection: Uint8Array.from([1, 0, 1, 0]),
    }) as any[];
    expect(traces[0].x).toHaveLength(4);
    const op = traces[0].marker.opacity;
    expect(op[0]).toBe(1);
    expect(op[1]).toBeLessThan(1);
    expect(op[2]).toBe(1);
  });

  it('sets no per-point opacity when nothing is selected', () => {
    // An opacity array per point costs memory and gains nothing with no selection.
    const traces = buildUmapTraces({
      x: f32(1, 2), y: f32(1, 2), label: 'UMAP',
      categories: cats(['A'], ['#f00'], [0, 0]),
    }) as any[];
    expect(traces[0].marker.opacity).toBeUndefined();
  });

  it('returns nothing to draw for an empty embedding', () => {
    expect(buildUmapTraces({ x: f32(), y: f32(), label: 'UMAP' })).toEqual([]);
  });
});

describe('a 3D embedding', () => {
  const f32 = (...v: number[]) => Float32Array.from(v);
  const cats = (names: string[], colors: string[], codes: number[]) =>
    ({ names, colors, codes: Uint16Array.from(codes) });

  it('switches to a rotatable 3D scatter when a third dimension is given', () => {
    // Not a `scattergl` with a z: `scatter3d` is a different trace type with its own
    // scene, which is why the third dimension cannot simply be added to the plane.
    const traces = buildUmapTraces({
      x: f32(1, 2), y: f32(3, 4), z: f32(5, 6), label: 'UMAP',
    }) as any[];
    expect(traces[0].type).toBe('scatter3d');
    expect(traces[0].z).toEqual([5, 6]);
  });

  it('stays a 2D scattergl with no third dimension', () => {
    const traces = buildUmapTraces({ x: f32(1), y: f32(2), label: 'UMAP' }) as any[];
    expect(traces[0].type).toBe('scattergl');
    expect(traces[0].z).toBeUndefined();
  });

  it('carries the third dimension per category, index-aligned with x and y', () => {
    // The per-category split takes a SUBSET of points, so z has to be subset the same
    // way — a mismatch would place cells at another cell's depth.
    const traces = buildUmapTraces({
      x: f32(10, 20, 30, 40), y: f32(11, 21, 31, 41), z: f32(12, 22, 32, 42),
      label: 'UMAP',
      categories: cats(['A', 'B'], ['#f00', '#00f'], [0, 1, 0, 1]),
    }) as any[];
    const a = traces.find((tr) => tr.name === 'A');
    expect(a.x).toEqual([10, 30]);
    expect(a.y).toEqual([11, 31]);
    expect(a.z).toEqual([12, 32]);
    expect(a.customdata).toEqual([0, 2]);
  });

  it('keeps observation indices on the 3D traces, so a pick still resolves', () => {
    const traces = buildUmapTraces({
      x: f32(1, 2), y: f32(3, 4), z: f32(5, 6), label: 'UMAP',
    }) as any[];
    expect(traces[0].customdata).toEqual([0, 1]);
  });

  it('lays out a scene with three named axes and true proportions', () => {
    const l = umapLayout({
      x: f32(1), y: f32(2), z: f32(3), label: 'UMAP', derived: true,
    }) as any;
    expect(l.scene.xaxis.title.text).toBe('UMAP 1');
    expect(l.scene.zaxis.title.text).toBe('UMAP 3');
    // The axes carry no units, so all three must be scaled alike or distances lie.
    expect(l.scene.aspectmode).toBe('data');
    // No 2D axes on a 3D plot.
    expect(l.xaxis).toBeUndefined();
  });

  it('says it was computed here, which a 3D embedding always is', () => {
    // Nothing published with a spatial dataset is 3D, so this note is not optional
    // decoration — it is the difference between the paper's figure and ours.
    const l = umapLayout({ x: f32(1), y: f32(2), z: f32(3), label: 'UMAP', derived: true }) as any;
    expect(l.annotations[0].text).toMatch(/computed here/);
  });
});

describe('umapLayout', () => {
  it('locks the axes to equal scale', () => {
    // An embedding's axes carry no units, so distances only compare if both are scaled
    // alike. Stretching one to fill the panel invents structure that is not in the data.
    const l = umapLayout({ x: Float32Array.of(1), y: Float32Array.of(1), label: 'UMAP' }) as any;
    expect(l.yaxis.scaleanchor).toBe('x');
    expect(l.yaxis.scaleratio).toBe(1);
  });

  it('names the axes after the embedding', () => {
    const l = umapLayout({ x: Float32Array.of(1), y: Float32Array.of(1), label: 't-SNE' }) as any;
    expect(l.xaxis.title.text).toBe('t-SNE 1');
    expect(l.yaxis.title.text).toBe('t-SNE 2');
  });

  it('says on the plot when the embedding was computed here', () => {
    // A recomputed embedding is a different picture from the published one; a reader
    // comparing against a paper's figure has to be told, and a tooltip is not enough.
    const derived = umapLayout({
      x: Float32Array.of(1), y: Float32Array.of(1), label: 'UMAP', derived: true,
    }) as any;
    expect(derived.annotations[0].text).toMatch(/computed here/);

    const published = umapLayout({
      x: Float32Array.of(1), y: Float32Array.of(1), label: 'UMAP',
    }) as any;
    expect(published.annotations).toBeUndefined();
  });
});
