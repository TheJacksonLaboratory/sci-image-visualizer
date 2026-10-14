import { BehaviorSubject } from 'rxjs';

import { RegionSource, RegionSourceView } from '../region-source/region-source';
import { RegionFeatureTable, RegionTileKey } from '../region-source/region-tiles';
import { RegionSourceLayer, SOURCE_REPLAN_MS } from './region-source-layer';
import { Affine } from './svg-region-renderer';

/** A ring with `perSide` points per side, so coarse levels have something to drop. */
function square(x: number, y: number, s: number, perSide = 20): number[][] {
  const c = [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
  ];
  const pts: number[][] = [];
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = c[k];
    const [bx, by] = c[(k + 1) % 4];
    for (let i = 0; i < perSide; i++) pts.push([ax + ((bx - ax) * i) / perSide, ay + ((by - ay) * i) / perSide]);
  }
  return [...pts, pts[0]];
}

const feature = (id: string, ring: number[][], name: string) => ({
  type: 'Feature',
  id,
  properties: { classification: { name } },
  geometry: { type: 'Polygon', coordinates: [ring] },
});

/** 2048×2048 px: a big square, a small one far from it, and a cell under a pixel when zoomed out. */
const table = RegionFeatureTable.fromGeoJson(
  JSON.stringify({
    type: 'FeatureCollection',
    features: [
      feature('big', square(100, 100, 400), 'A'),
      feature('far', square(1800, 1800, 200), 'B'),
      feature('cell', square(50, 50, 3), 'A'),
    ],
  }),
);

function source(): RegionSource & { asked: RegionTileKey[]; gate: Promise<void> | null } {
  const s = {
    info: table.info(),
    asked: [] as RegionTileKey[],
    gate: null as Promise<void> | null,
    async getTile(z: number, k: RegionTileKey) {
      s.asked.push(k);
      if (s.gate) await s.gate;
      return table.tile(z, k.level, k.gx, k.gy);
    },
    getFeatures: async () => [],
    getIndex: async () => ({ total: 0, rows: [] }),
    getClassCounts: async () => ({}),
    exportGeoJson: async () => '',
    dispose: () => undefined,
  };
  return s;
}

const wait = (ms = SOURCE_REPLAN_MS + 40) => new Promise((r) => setTimeout(r, ms));

describe('RegionSourceLayer', () => {
  let svg: SVGSVGElement;
  let view$: BehaviorSubject<RegionSourceView | null>;
  let layer: RegionSourceLayer;
  let src: ReturnType<typeof source>;

  const viewOf = (taken: string[] = []): RegionSourceView => ({
    source: src,
    plane: 0,
    taken: new Set(taken),
    colorOf: (f) => (f.label === 'A' ? '#ff0000' : '#0000ff'),
  });
  /** Screen px per image px `s`, image point (ox, oy) at the svg's top-left. */
  const camera = (s: number, ox = 0, oy = 0): Affine => [s, 0, 0, s, -ox * s, -oy * s];
  const paths = () => Array.from(svg.querySelectorAll('[data-layer="region-source"] path'));

  beforeEach(() => {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'g'));
    src = source();
    view$ = new BehaviorSubject<RegionSourceView | null>(null);
    layer = new RegionSourceLayer(svg, view$, () => ({ width: 800, height: 600 }));
  });

  afterEach(() => layer.destroy());

  it('draws nothing and is detached without a source', async () => {
    layer.setCamera(camera(1));
    await wait();
    expect(svg.querySelector('[data-layer="region-source"]')).toBeNull();
  });

  it('draws the tiles in view under the regions, one path per colour, exactly at 1:1', async () => {
    layer.setCamera(camera(1));
    view$.next(viewOf());
    await wait();
    const group = svg.firstChild as SVGGElement;
    expect(group.getAttribute('data-layer')).toBe('region-source');
    expect(group.getAttribute('transform')).toBe('matrix(1 0 0 1 0 0)');
    expect(src.asked.every((k) => k.level === 0)).toBe(true);
    expect(src.asked.some((k) => k.gx >= 3)).toBe(false); // 'far' is off screen
    const [red] = paths();
    expect(paths()).toHaveLength(1);
    expect(red.getAttribute('stroke')).toBe('#ff0000');
    expect(red.getAttribute('vector-effect')).toBe('non-scaling-stroke');
    // The big square at full detail (80 vertices) plus the cell.
    expect((red.getAttribute('d')!.match(/L/g) ?? []).length).toBe(79 + 79);
  });

  it('draws coarse simplified tiles zoomed out, leaving out what is under a pixel', async () => {
    layer.setCamera(camera(1 / 8));
    view$.next(viewOf());
    await wait();
    // The coarsest level (2: a 2048 px tile holds the whole set) at 1/8.
    expect(src.info.levels).toBe(3);
    expect(src.asked.every((k) => k.level === 2)).toBe(true);
    const d = paths().map((p) => p.getAttribute('d')!);
    expect(d).toHaveLength(2);
    expect((d[0].match(/M/g) ?? []).length).toBe(1); // the cell is gone
    expect((d[0].match(/L/g) ?? []).length).toBe(3); // the square has 4 corners
  });

  it('only moves the transform on a camera change, and re-plans once it settles', async () => {
    layer.setCamera(camera(1));
    view$.next(viewOf());
    await wait();
    const asked = src.asked.length;
    layer.setCamera(camera(1, 1200, 1200));
    expect((svg.firstChild as Element).getAttribute('transform')).toBe('matrix(1 0 0 1 -1200 -1200)');
    expect(src.asked.length).toBe(asked);
    await wait();
    expect(src.asked.length).toBeGreaterThan(asked);
  });

  it("draws a loading tile's coarser ancestor meanwhile", async () => {
    layer.setCamera(camera(1 / 8));
    view$.next(viewOf());
    await wait();
    let open!: () => void;
    src.gate = new Promise((r) => (open = r));
    layer.setCamera(camera(1));
    await wait();
    // Still the level-2 outline (4 corners) while level 0 loads.
    expect((paths()[0].getAttribute('d')!.match(/L/g) ?? []).length).toBe(3);
    open();
    await wait(40);
    expect((paths()[0].getAttribute('d')!.match(/L/g) ?? []).length).toBe(79 + 79);
  });

  it('leaves taken features out and picks the innermost drawn feature', async () => {
    layer.setCamera(camera(1));
    view$.next(viewOf());
    await wait();
    expect(layer.featureAt(300, 300)?.id).toBe('big');
    expect(layer.featureAt(51, 51)?.id).toBe('cell');
    expect(layer.featureAt(700, 700)).toBeNull();
    expect(
      layer
        .featuresInRect(0, 0, 120, 120)
        .map((f) => f.id)
        .sort(),
    ).toEqual(['big', 'cell']);
    view$.next(viewOf(['big']));
    await wait(40);
    expect(layer.featureAt(300, 300)).toBeNull();
    expect((paths()[0].getAttribute('d')!.match(/M/g) ?? []).length).toBe(1);
  });

  it('hides with the regions', async () => {
    layer.setCamera(camera(1));
    view$.next(viewOf());
    await wait();
    layer.setVisible(false);
    expect(svg.querySelector('[data-layer="region-source"]')).toBeNull();
    expect(layer.featureAt(300, 300)).toBeNull();
    layer.setVisible(true);
    expect(svg.firstChild).toBe(svg.querySelector('[data-layer="region-source"]'));
  });
});
