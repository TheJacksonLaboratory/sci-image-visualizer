import {
  UMAP_MAX_LEGEND_CATEGORIES, buildUmapTraces, umapLayout,
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
