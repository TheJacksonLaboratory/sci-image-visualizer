import { HeadlessViewer } from 'napari-js/testing';
import type { SurfaceLayer, Viewer } from 'napari-js';

import { CELLS_3D_MAX_CELLS, Spatial3dCells } from './napari-spatial-3d-cells';
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

function setup() {
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
});
