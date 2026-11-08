import { HeadlessViewer } from 'napari-js/testing';
import type { SurfaceLayer, Viewer } from 'napari-js';

import { CELLS_3D_MAX_CELLS, CELLS_3D_TRIANGLE_BUDGET, Spatial3dCells } from './napari-spatial-3d-cells';
import * as workers from '../../region-source/worker-region-source';
import type { Cells3dStatus } from '../../contracts/display-types';

/** A square cell outline at (x, y), `s` across. */
const square = (x: number, y: number, s = 40) => Float32Array.of(x, y, x + s, y, x + s, y + s, x, y + s);

/**
 * A served 3D segmentation, small: three cells on three planes (c1 and c2 of type A, c3 of B),
 * their features `<plane>:<cell id>` as a folder region set serves them.
 */
function source() {
  const cells = [
    { id: 'c1', label: 'A', x: 60 },
    { id: 'c2', label: 'A', x: 460 },
    { id: 'c3', label: 'B', x: 700 },
  ];
  const getTile = jest.fn(async (z: number) => ({
    z,
    level: 0,
    gx: 0,
    gy: 0,
    features: cells.map((c) => ({
      id: `${z}:${c.id}`,
      label: c.label,
      color: null,
      bbox: [c.x, 100, c.x + 40, 140],
      open: false,
      rings: [square(c.x, 100)],
    })),
  }));
  return {
    info: {
      featureCount: 9,
      bounds: [0, 0, 800, 400],
      tileSize: 1024,
      levels: 1,
      planes: [0, 1, 2],
      classColors: {},
    },
    getTile,
    dispose: jest.fn(),
  };
}

const DATASET: any = {
  id: 'ileum',
  imageRef: { imageId: 'b.omics/image/plate.ome.tif', scale: [1, 1] },
  observations: { count: 3, x: new Float32Array(3), y: new Float32Array(3), radius: 20, ids: ['c1', 'c2', 'c3'] },
  polygonTiles: { bounds: [0, 0, 1, 1], levels: [], sets: [{ name: '3d', label: '3D', regionSource: 'rs-3d' }] },
};
const PLANES = {
  z: [0, 10, 20],
  scale: [1, 1] as [number, number],
  offset: [-400, -200, -10] as [number, number, number],
};

async function settled(statuses: (Cells3dStatus | null)[]): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5));
    const last = statuses.at(-1);
    if (last && !last.building && last.shown > 0) return;
  }
}

function setup(wireframe?: () => boolean) {
  const v = new HeadlessViewer({ canvasRect: { width: 400, height: 300 } });
  const viewer = v as unknown as Viewer;
  const src = source();
  const port: any = { openRegionSet: jest.fn(async () => src) };
  const statuses: (Cells3dStatus | null)[] = [];
  const ended = jest.fn();
  const cells = new Spatial3dCells({
    viewer,
    port,
    beginTask: () => ended,
    status: (s) => statuses.push(s),
    ...(wireframe ? { wireframe } : {}),
  });
  const surfaces = () => v.layers.items.filter((l) => l.name.startsWith('cells')) as SurfaceLayer[];
  return { v, viewer, cells, src, port, statuses, ended, surfaces };
}

describe('Spatial3dCells', () => {
  it("builds each cell its own surface, from the region set's planes, in its observation's colour", async () => {
    const { cells, statuses, surfaces, port, ended } = setup();
    cells.setDataset(DATASET);
    cells.setPlacement(PLANES, 1);
    cells.setClasses(new Set(['A', 'B']));
    await settled(statuses);
    expect(port.openRegionSet).toHaveBeenCalledWith('rs-3d');
    expect(statuses.at(-1)).toEqual({ shown: 3, capped: false, building: false });
    expect(ended).toHaveBeenCalled(); // the loading badge was taken down
    const layers = surfaces();
    expect(layers.length).toBeGreaterThan(0);
    const faces = layers.reduce((s, l) => s + (l as any).faces.length, 0);
    expect(faces).toBeGreaterThan(0);

    // Coloured per vertex by the observations' colours: c1 red, c2 green, c3 blue.
    cells.setStyle(Float32Array.of(1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1), null, 0.7);
    const colors = layers.flatMap((l) => Array.from(l.vertexColors ?? []));
    expect(colors.length).toBeGreaterThan(0);
    expect(layers.every((l) => l.opacity === 0.7)).toBe(true);
    // A selection (c3): the others keep their colours and fade; c3 stays near opaque.
    cells.setStyle(Float32Array.of(1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1), null, 0.7, Uint8Array.of(0, 0, 1));
    const rgba = layers.flatMap((l) => Array.from(l.vertexColors ?? []));
    const alphas = new Set(rgba.filter((_v, i) => i % 4 === 3).map((a) => Math.round(a * 100) / 100));
    expect(alphas.size).toBe(2);
    expect(Math.max(...alphas)).toBe(1);
    expect(Math.min(...alphas)).toBeLessThan(0.3);
    // Colours kept: no grey.
    expect(rgba.some((v, i) => i % 4 === 0 && v === 1)).toBe(true);
    cells.dispose();
  });

  it('draws its cells as wireframes while the toggle is on', async () => {
    const { cells, statuses, surfaces } = setup(() => true);
    cells.setDataset(DATASET);
    cells.setPlacement(PLANES, 1);
    cells.setClasses(new Set(['A', 'B']));
    await settled(statuses);
    expect(surfaces().length).toBeGreaterThan(0);
    expect(surfaces().every((l) => l.wireframe)).toBe(true);
    cells.dispose();
  });

  it('leaves out the cells of a hidden class, and those the panel hides, without meshing again', async () => {
    const { cells, statuses, surfaces, src } = setup();
    cells.setDataset(DATASET);
    cells.setPlacement(PLANES, 1);
    cells.setClasses(new Set(['A', 'B']));
    await settled(statuses);
    const count = () => surfaces().reduce((s, l) => s + (l.visible ? (l as any).faces.length : 0), 0);
    const all = count();
    const tiles = src.getTile.mock.calls.length;
    cells.setHiddenClasses(['B']);
    const withoutB = count();
    expect(withoutB).toBeLessThan(all);
    cells.setStyle(null, Uint8Array.of(1, 0, 0), 1); // c2 hidden by the panel too
    expect(count()).toBeLessThan(withoutB);
    cells.setHiddenClasses([]);
    cells.setStyle(null, null, 1);
    expect(count()).toBe(all);
    expect(src.getTile.mock.calls.length).toBe(tiles); // nothing read or meshed again
    cells.dispose();
  });

  it('draws a selection as a solid surface of its own, so the faded cells in front show it through', async () => {
    const { v, cells, statuses, surfaces, viewer } = setup();
    cells.setDataset(DATASET);
    cells.setPlacement(PLANES, 1);
    cells.setClasses(new Set(['A', 'B']));
    await settled(statuses);
    const faces = (layers: SurfaceLayer[]) =>
      layers.reduce((n, l) => n + (l.visible ? (l as any).faces.length : 0), 0);
    const all = faces(surfaces());
    const selectedSurfaces = () =>
      v.layers.items.filter((l) => l.name.startsWith('selected cells')) as SurfaceLayer[];

    cells.setStyle(Float32Array.of(1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1), null, 0.7, Uint8Array.of(0, 0, 1));
    await new Promise((r) => setTimeout(r, 20));
    const selected = selectedSurfaces().filter((l) => l.visible);
    expect(selected.length).toBeGreaterThan(0);
    // Opaque: full opacity, every vertex alpha 1, in c3's colour (blue).
    expect(selected.every((l) => l.opacity === 1 && !l.translucent)).toBe(true);
    const rgba = selected.flatMap((l) => Array.from(l.vertexColors ?? []));
    expect(rgba.filter((_v, i) => i % 4 === 3).every((a) => a === 1)).toBe(true);
    // c3's triangles moved out of the faded surfaces, none lost.
    expect(faces(surfaces()) + faces(selected)).toBe(all);
    expect(faces(surfaces())).toBeLessThan(all);
    // Picked on its own surface, it is still c3.
    jest
      .spyOn(viewer, 'pickSurface')
      .mockReturnValue({ layer: selected[0], face: 0, distance: 1, point: [0, 0, 0] } as any);
    expect(cells.pick(10, 10)).toBe(2);

    // Cleared: back in one surface per chunk.
    cells.setStyle(Float32Array.of(1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1), null, 0.7, null);
    await new Promise((r) => setTimeout(r, 20));
    expect(selectedSurfaces().some((l) => l.visible)).toBe(false);
    expect(faces(surfaces())).toBe(all);
    cells.dispose();
  });

  it('names the cell under the pointer by its observation', async () => {
    const { cells, statuses, surfaces, viewer } = setup();
    cells.setDataset(DATASET);
    cells.setPlacement(PLANES, 1);
    cells.setClasses(new Set(['B']));
    await settled(statuses);
    const layer = surfaces()[0];
    jest.spyOn(viewer, 'pickSurface').mockReturnValue({ layer, face: 0, distance: 1, point: [0, 0, 0] } as any);
    expect(cells.pick(10, 10)).toBe(2); // c3, the only B
    (viewer.pickSurface as jest.Mock).mockReturnValue(null);
    expect(cells.pick(10, 10)).toBe(-1);
    cells.dispose();
  });

  it('draws nothing without classes, a placement, or the dataset naming a region set', async () => {
    const { cells, statuses, surfaces, port } = setup();
    cells.setDataset({ ...DATASET, polygonTiles: undefined });
    cells.setPlacement(PLANES, 1);
    cells.setClasses(new Set(['A']));
    await new Promise((r) => setTimeout(r, 20));
    expect(port.openRegionSet).not.toHaveBeenCalled();
    expect(surfaces()).toHaveLength(0);
    expect(statuses.filter(Boolean)).toEqual([]); // no cells: nothing reported (and no churn)
    cells.dispose();
  });

  it('keeps to the cell cap, the chunks nearest the view first', () => {
    const { cells } = setup();
    const chunk = (key: string, n: number) =>
      ({ key, box: [0, 0, 1, 1], tier: -1, want: -1, cells: n, triangles: new Map(), labels: new Map() }) as any;
    const near = chunk('near', CELLS_3D_MAX_CELLS - 10);
    const far = chunk('far', 100);
    (cells as any).chunks = [near, far];
    (cells as any).assignTiers(
      [
        { chunk: near, ppi: 0, onScreen: true, d2: 0 },
        { chunk: far, ppi: 0, onScreen: true, d2: 10 },
      ],
      [10, 5, 2.5],
    );
    expect(near.want).toBe(0);
    expect(far.want).toBe(-1); // over the cap: left out (and the status says so)
    cells.dispose();
  });

  it('meshes a chunk on screen finer, within the triangle budget', () => {
    const { cells } = setup();
    const chunk = {
      key: 'c',
      box: [0, 0, 100, 100],
      tier: 0,
      want: 0,
      cells: 10,
      triangles: new Map([[0, 1000]]),
      labels: new Map(),
    } as any;
    (cells as any).chunks = [chunk];
    // 1 screen px per image px: the finest step (2.5 px) is under the 3 px a voxel needs, the next (5) is not.
    (cells as any).assignTiers([{ chunk, ppi: 1, onScreen: true, d2: 0 }], [10, 5, 2.5]);
    expect(chunk.want).toBe(1);
    // Off screen (no pixels): coarse.
    (cells as any).assignTiers([{ chunk, ppi: 0, onScreen: false, d2: 0 }], [10, 5, 2.5]);
    expect(chunk.want).toBe(0);
    cells.dispose();
  });

  it('builds the classes asked for while a build of others was still reading', async () => {
    const { cells, statuses, surfaces, src } = setup();
    // Class A's tiles held back: its build is in flight when B is asked for.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const read = src.getTile.getMockImplementation()!;
    src.getTile.mockImplementation(async (z: number) => {
      await held;
      return read(z);
    });
    cells.setDataset(DATASET);
    cells.setPlacement(PLANES, 1);
    cells.setClasses(new Set(['A']));
    await new Promise((r) => setTimeout(r, 20));
    cells.setClasses(new Set(['B']));
    await new Promise((r) => setTimeout(r, 20)); // B's plan ran, while A's build held the runner
    release();
    await settled(statuses);
    expect(statuses.at(-1)).toEqual({ shown: 1, capped: false, building: false });
    expect(surfaces().some((l) => l.visible && (l as any).faces.length > 0)).toBe(true);
    cells.dispose();
  });

  it('draws a placement that lands after the scene passed the same placement again', async () => {
    const { cells, statuses, surfaces } = setup();
    const place = workers.placeInWorker;
    const pending: (() => void)[] = [];
    const spy = jest.spyOn(workers, 'placeInWorker').mockImplementation((vertices, frame) => {
      const out = place(vertices, frame);
      return new Promise((resolve) => pending.push(() => resolve(out)));
    });
    cells.setDataset(DATASET);
    cells.setPlacement(PLANES, 1);
    cells.setClasses(new Set(['A', 'B']));
    for (let i = 0; i < 100 && !pending.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(pending.length).toBeGreaterThan(0);
    // The same placement in a new object, with a new Z stretch: what is in flight still holds.
    cells.setPlacement({ ...PLANES }, 2);
    for (let i = 0; i < 100; i++) {
      pending.splice(0).forEach((go) => go());
      await new Promise((r) => setTimeout(r, 5));
      if (statuses.at(-1)?.building === false && surfaces().some((l) => l.visible)) break;
    }
    expect(surfaces().some((l) => l.visible)).toBe(true);
    expect(surfaces().every((l) => l.scale3d[2] === 2)).toBe(true);
    spy.mockRestore();
    cells.dispose();
  });

  it('draws the new placement when it lands after the one it replaced', async () => {
    const { cells, surfaces } = setup();
    const place = workers.placeInWorker;
    const pending: (() => void)[] = [];
    const spy = jest.spyOn(workers, 'placeInWorker').mockImplementation((vertices, frame) => {
      const out = place(vertices, frame);
      return new Promise((resolve) => pending.push(() => resolve(out)));
    });
    cells.setDataset(DATASET);
    cells.setPlacement(PLANES, 1);
    cells.setClasses(new Set(['B']));
    for (let i = 0; i < 100 && !pending.length; i++) await new Promise((r) => setTimeout(r, 5));
    const old = pending.splice(0);
    // Moved while the first is in flight: placed again; the first lands late and is dropped.
    cells.setPlacement({ ...PLANES, offset: [0, 0, 0] }, 1);
    for (let i = 0; i < 100 && !pending.length; i++) await new Promise((r) => setTimeout(r, 5));
    old.forEach((go) => go());
    await new Promise((r) => setTimeout(r, 5));
    pending.splice(0).forEach((go) => go());
    await new Promise((r) => setTimeout(r, 10));
    expect(surfaces().some((l) => l.visible)).toBe(true);
    spy.mockRestore();
    cells.dispose();
  });

  it('recolours without uploading the geometry again', async () => {
    const { cells, statuses, surfaces } = setup();
    cells.setDataset(DATASET);
    cells.setPlacement(PLANES, 1);
    cells.setClasses(new Set(['A', 'B']));
    await settled(statuses);
    const layers = surfaces();
    const data = layers.map((l) => l.dataVersion);
    const colors = layers.map((l) => l.colorVersion);
    cells.setStyle(Float32Array.of(1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1), null, 0.5);
    await new Promise((r) => setTimeout(r, 20));
    expect(layers.map((l) => l.dataVersion)).toEqual(data);
    expect(layers.every((l, i) => l.colorVersion > colors[i])).toBe(true);
    // Hiding cells still takes them out of what is drawn (here B's chunk, c3 alone: none left).
    cells.setHiddenClasses(['B']);
    await new Promise((r) => setTimeout(r, 20));
    expect(layers.filter((l) => l.visible).length).toBe(layers.length - 1);
    cells.dispose();
  });

  it('meshes only the cells that fit of a first chunk over the cap or the budget by itself', () => {
    const { cells } = setup();
    const chunk = (key: string, n: number, triangles: number) =>
      ({
        key,
        box: [0, 0, 1, 1],
        tier: -1,
        want: -1,
        cells: n,
        meshed: -1,
        limit: Infinity,
        builtLimit: Infinity,
        triangles: new Map([[0, triangles]]),
        labels: new Map(),
      }) as any;
    const order = (...chunks: any[]) => chunks.map((c, i) => ({ chunk: c, ppi: 0, onScreen: true, d2: i }));

    // Over the cap: drawn, but cut to it.
    const dense = chunk('dense', CELLS_3D_MAX_CELLS + 1, 1000);
    (cells as any).chunks = [dense];
    (cells as any).assignTiers(order(dense), [10, 5, 2.5]);
    expect(dense.want).toBe(0);
    expect(dense.limit).toBe(CELLS_3D_MAX_CELLS);

    // Over the budget at its coarsest: cut to the cells that fit in it.
    const heavy = chunk('heavy', 10_000, 4_000_000);
    (cells as any).chunks = [heavy];
    (cells as any).assignTiers(order(heavy), [10, 5, 2.5]);
    expect(heavy.want).toBe(0);
    expect(heavy.limit).toBe(Math.floor((CELLS_3D_TRIANGLE_BUDGET / 4_000_000) * 10_000));

    // Two over the budget together at their coarsest: the second is left out.
    const a = chunk('a', 100, 2_000_000);
    const b = chunk('b', 100, 2_000_000);
    (cells as any).chunks = [a, b];
    (cells as any).assignTiers(order(a, b), [10, 5, 2.5]);
    expect([a.want, b.want]).toEqual([0, -1]);
    expect(a.limit).toBe(Infinity);

    // A chunk not built yet: no more cells than the cap leaves it.
    const fresh = { ...chunk('fresh', -1, 0), triangles: new Map() };
    (cells as any).chunks = [fresh];
    (cells as any).assignTiers(order(fresh), [10, 5, 2.5]);
    expect(fresh.limit).toBe(CELLS_3D_MAX_CELLS);
    cells.dispose();
  });
});
