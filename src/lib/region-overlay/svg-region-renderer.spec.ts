import { MultiPolygon, Polygon, Rectangle, Region } from '../models/region';
import {
  Affine,
  SvgRegionRenderer,
  SvgRegionRendererOptions,
  affineFromProjection,
  applyAffine,
  svgEl,
} from './svg-region-renderer';

/** The world-space renderer behind both region overlays (NAPARI-BOUNDARY-10, OSD-PLOTLY-11). */

function region(bounds: unknown, extra: Partial<Region> = {}): Region {
  return Object.assign(new Region(), { bounds, label: 'r' }, extra);
}
function poly(xs: number[], ys: number[], extra: Partial<Polygon> = {}): Polygon {
  return Object.assign(new Polygon(), { npoints: xs.length, xpoints: xs, ypoints: ys, closed: true }, extra);
}
const rect = (x: number, y: number, width: number, height: number) =>
  Object.assign(new Rectangle(), { x, y, width, height });

function setup(opts: Partial<SvgRegionRendererOptions> = {}) {
  const svg = svgEl('svg');
  document.body.appendChild(svg);
  const renderer = new SvgRegionRenderer(svg, {
    styleShape: (el, _r, selected) => el.setAttribute('stroke-width', selected ? '4' : '2'),
    ...opts,
  });
  return { svg, renderer };
}

/** Collect the DOM mutations `fn` causes under `root`. */
function mutations(root: Node, fn: () => void): MutationRecord[] {
  const observer = new MutationObserver(() => undefined);
  observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  fn();
  const records = observer.takeRecords();
  observer.disconnect();
  return records;
}

describe('SvgRegionRenderer', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('affineFromProjection recovers a scaled, rotated and translated projection', () => {
    const m: Affine = [0, 2, -2, 0, 7, -3]; // 90° rotation, 2x zoom, offset
    const fitted = affineFromProjection((x, y) => applyAffine(m, x, y));
    expect(fitted).toEqual(m);
    expect(applyAffine(fitted, 3, 4)).toEqual([-1, 3]);
  });

  it('draws regions in world coordinates inside one transformed group', () => {
    const { svg, renderer } = setup();
    renderer.setCamera([2, 0, 0, 2, 10, 20]);
    renderer.render([region(poly([0, 10, 5], [0, 0, 10]))], []);
    const g = svg.querySelector('g[data-layer="regions"]')!;
    expect(g.getAttribute('transform')).toBe('matrix(2 0 0 2 10 20)');
    const shape = g.querySelector('polygon')!;
    expect(shape.getAttribute('points')).toBe('0,0 10,0 5,10');
    expect(shape.getAttribute('vector-effect')).toBe('non-scaling-stroke');
  });

  it('a camera change mutates only the transform attribute', () => {
    const { svg, renderer } = setup();
    renderer.render(
      [
        region(rect(0, 0, 10, 10)),
        region(poly([0, 10, 5], [0, 0, 10])),
        region(
          poly([0, 20, 20, 0], [0, 0, 20, 20], {
            holes: [
              [
                [7, 7],
                [13, 7],
                [13, 13],
              ],
            ],
          }),
        ),
      ],
      [1],
    );
    const records = mutations(svg, () => expect(renderer.setCamera([3, 0, 0, 3, -5, 4])).toBe(true));
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('attributes');
    expect(records[0].attributeName).toBe('transform');
    expect((records[0].target as Element).getAttribute('data-layer')).toBe('regions');
  });

  it('an unchanged camera touches nothing', () => {
    const { svg, renderer } = setup();
    renderer.setCamera([2, 0, 0, 2, 0, 0]);
    renderer.render([region(rect(0, 0, 10, 10))], []);
    expect(mutations(svg, () => expect(renderer.setCamera([2, 0, 0, 2, 0, 0])).toBe(false))).toEqual([]);
    expect(mutations(svg, () => renderer.setCamera([NaN, 0, 0, 1, 0, 0]))).toEqual([]);
  });

  it('re-positions labels and overlay elements in place on a camera change', () => {
    const { svg, renderer } = setup({
      decorate: (r, _i, _s, layer) => {
        const t = svgEl('text');
        t.textContent = r.label ?? '';
        layer.at(t, (r.bounds as Rectangle).x, (r.bounds as Rectangle).y, { dy: -4 });
      },
    });
    renderer.render([region(rect(5, 6, 10, 10))], []);
    renderer.renderOverlay((layer) => {
      layer.at(svgEl('circle'), 1, 1, { x: 'cx', y: 'cy' });
      layer.line(0, 0, 2, 2);
      layer.poly('polyline', [
        { x: 0, y: 0 },
        { x: 1, y: 2 },
      ]);
    });
    const text = svg.querySelector('text')!;
    const circle = svg.querySelector('circle')!;
    expect([text.getAttribute('x'), text.getAttribute('y')]).toEqual(['5', '2']);

    const records = mutations(svg, () => renderer.setCamera([2, 0, 0, 2, 100, 0]));
    expect(records.some((r) => r.type === 'childList')).toBe(false); // nothing rebuilt
    expect(svg.querySelector('text')).toBe(text);
    expect([text.getAttribute('x'), text.getAttribute('y')]).toEqual(['110', '8']);
    expect(circle.getAttribute('cx')).toBe('102');
    expect(svg.querySelector('line')!.getAttribute('x2')).toBe('104');
    expect(svg.querySelector('polyline')!.getAttribute('points')).toBe('100,0 102,4');
  });

  it.each<[string, unknown, Partial<SvgRegionRendererOptions>, string, string | null]>([
    ['rectangle as a polygon (OSD)', rect(0, 0, 10, 10), {}, 'polygon', null],
    ['rectangle as a rect (napari)', rect(0, 0, 10, 10), { rectElement: 'rect' }, 'rect', null],
    ['closed polygon', poly([0, 10, 5], [0, 0, 10]), {}, 'polygon', null],
    ['open polyline', poly([0, 10, 5], [0, 0, 10], { closed: false }), {}, 'polyline', null],
    [
      'donut',
      poly([0, 20, 20, 0], [0, 0, 20, 20], {
        holes: [
          [
            [7, 7],
            [13, 7],
            [13, 13],
          ],
        ],
      }),
      {},
      'path',
      'evenodd',
    ],
    ['bezier', poly([0, 10, 5], [0, 0, 10], { bezier: true }), {}, 'path', null],
    [
      'multi-polygon',
      Object.assign(new MultiPolygon(), { polygons: [poly([0, 1, 1], [0, 0, 1])] }),
      {},
      'path',
      'evenodd',
    ],
    ['JSON rectangle', { x: 0, y: 0, width: 1, height: 1 }, {}, 'polygon', null],
  ])('draws a %s', (_name, bounds, opts, tag, fillRule) => {
    const { svg, renderer } = setup(opts);
    renderer.render([region(bounds)], []);
    const shapes = svg.querySelector('g[data-layer="regions"]')!.children;
    expect(shapes).toHaveLength(1);
    expect(shapes[0].tagName).toBe(tag);
    expect(shapes[0].getAttribute('fill-rule')).toBe(fillRule);
  });

  it('draws nothing for empty geometry and skipped regions, keeping indices for selection', () => {
    const selectedOf: boolean[] = [];
    const { svg, renderer } = setup({
      skip: (r) => r.kind === 'profile',
      styleShape: (_el, _r, selected) => selectedOf.push(selected),
    });
    renderer.render(
      [
        region(rect(0, 0, 1, 1), { kind: 'profile' }),
        region(null),
        region(poly([], [])),
        region(Object.assign(new MultiPolygon(), { polygons: [poly([0, 1], [0, 1])] })),
        region(rect(0, 0, 1, 1)),
      ],
      [4],
    );
    expect(svg.querySelector('g[data-layer="regions"]')!.children).toHaveLength(1);
    expect(selectedOf).toEqual([true]);
  });

  it('attaches only the layers that have content, in order', () => {
    const { svg, renderer } = setup();
    renderer.render([], []);
    expect(svg.childElementCount).toBe(0);
    const marquee = svg.appendChild(svgEl('rect')); // an element the overlay owns directly
    renderer.renderOverlay((layer) => layer.at(svgEl('circle'), 0, 0));
    renderer.render([region(rect(0, 0, 1, 1))], []);
    const layers = Array.from(svg.children).map((c) => c.getAttribute('data-layer'));
    expect(layers.filter((l) => l)).toEqual(['regions', 'overlay']);
    expect(marquee.parentNode).toBe(svg); // foreign children are left alone
    renderer.renderOverlay(() => undefined);
    renderer.render([], []);
    expect(Array.from(svg.children)).toEqual([marquee]);
    renderer.destroy();
  });
});
