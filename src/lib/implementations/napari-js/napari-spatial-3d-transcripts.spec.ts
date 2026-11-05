import { HeadlessViewer } from 'napari-js/testing';
import type { Points3DLayer, Viewer } from 'napari-js';

import {
  ALL_GENES,
  type SpatialDataPort,
  type TranscriptTileQuery,
} from '../../contracts/ports/spatial-data.port';
import { DEFAULT_SPATIAL_VIEW, SpatialViewState } from '../../contracts/display-types';
import type { SpatialDataset, SpatialTranscriptTile } from '../../contracts/spatial-dataset.contract';
import { DEFAULT_CATEGORICAL_PALETTE, DEFAULT_MUTED_OPACITY, parseHex } from '../../spatial/spatial-encoding';
import { Spatial3dTranscripts, transcripts3dColors, transcripts3dGenes } from './napari-spatial-3d-transcripts';

/** A 2 × 1 tile dataset (tiles 100 wide) whose transcripts carry z. */
function dataset(over: Partial<NonNullable<SpatialDataset['transcriptTiles']>> = {}): SpatialDataset {
  return {
    id: 'ileum',
    columns: [],
    transcriptTiles: {
      bounds: [0, 0, 150, 50],
      count: 3,
      geneCount: 3,
      genes: ['Acta2', 'Cd3e', 'Krt5'],
      hasZ: true,
      levels: [{ tileSize: 100, aggregated: false }],
      ...over,
    },
  } as unknown as SpatialDataset;
}

const view = (over: Partial<SpatialViewState> = {}): SpatialViewState => ({
  ...DEFAULT_SPATIAL_VIEW,
  transcriptMode: 'circles',
  ...over,
});

function tile(xs: number[], genes: number[], cells: number[] = xs.map(() => 0)): SpatialTranscriptTile {
  const n = xs.length;
  return {
    count: n,
    aggregated: false,
    x: Float32Array.from(xs),
    y: Float32Array.from(xs, () => 5),
    z: Float32Array.from(xs, (_x, i) => 10 * (i + 1)),
    weight: new Uint32Array(n).fill(1),
    observation: Uint32Array.from(cells),
    gene: Uint16Array.from(genes),
  };
}

function setup() {
  const v = new HeadlessViewer({ canvasRect: { width: 200, height: 100 } });
  const viewer = v as unknown as Viewer;
  const calls: { gx: number; gy: number; query: TranscriptTileQuery }[] = [];
  const port = {
    getTranscriptTile: jest.fn(async (_level: number, gx: number, gy: number, query: TranscriptTileQuery) => {
      calls.push({ gx, gy, query });
      return gx === 0 ? tile([10, 20], [0, 1]) : tile([120], [2]);
    }),
  } as unknown as SpatialDataPort;
  (port as unknown as { getColumn: jest.Mock }).getColumn = jest.fn(async () => ({
    kind: 'categorical',
    meta: { kind: 'categorical', name: 'cell_type', categories: ['Goblet', 'Paneth'] },
    codes: Uint16Array.of(0, 1),
  }));
  const ends: string[] = [];
  const t = new Spatial3dTranscripts(viewer, (label) => () => ends.push(label));
  const layers = () => v.layers.items.filter((l) => l.name === 'transcripts') as Points3DLayer[];
  return { t, port, calls, ends, layers };
}

const frame = { origin: [-75, -25, -50] as const, zScale: 2 };

describe('transcripts3dGenes', () => {
  it('draws the selected genes left shown, every gene with "All genes", nothing when off', () => {
    const ds = dataset();
    expect(transcripts3dGenes(ds, view({ transcriptGenes: ['A', 'B'], transcriptHiddenGenes: ['B'] }))).toEqual({
      query: ['A'],
      allGenes: false,
    });
    expect(transcripts3dGenes(ds, view({ transcriptGenes: ['A'], transcriptHiddenGenes: ['A'] }))).toBeNull();
    expect(transcripts3dGenes(ds, view({ transcriptAllGenes: true }))).toEqual({
      query: [ALL_GENES],
      allGenes: true,
    });
    expect(
      transcripts3dGenes(ds, view({ transcriptAllGenes: true, transcriptAllGenesHidden: [ALL_GENES] })),
    ).toBeNull();
    expect(transcripts3dGenes(ds, view({ transcriptMode: 'off', transcriptGenes: ['A'] }))).toBeNull();
  });
});

describe('transcripts3dColors', () => {
  it("colours each transcript by its gene's chosen colour, else the palette's by slot", () => {
    const rgba = transcripts3dColors(
      view({ transcriptGeneColors: { Cd3e: '#ff0000' } }),
      ['Acta2', 'Cd3e'],
      Uint16Array.of(0, 1),
      2,
    );
    const [r, g, b] = parseHex(DEFAULT_CATEGORICAL_PALETTE[0]);
    const close = (got: Float32Array, want: number[]) => want.forEach((w, i) => expect(got[i]).toBeCloseTo(w, 6));
    close(rgba.subarray(0, 4), [r / 255, g / 255, b / 255, 1]);
    close(rgba.subarray(4, 8), [1, 0, 0, 1]);
  });
});

describe('Spatial3dTranscripts', () => {
  it("reads every level-0 tile for the genes once, and draws them at their z in the cloud's box", async () => {
    const { t, port, calls, ends, layers } = setup();
    await t.sync(dataset(), view({ transcriptGenes: ['Acta2', 'Cd3e', 'Krt5'] }), port, frame);
    expect(calls.map((c) => [c.gx, c.gy])).toEqual(
      expect.arrayContaining([
        [0, 0],
        [1, 0],
      ]),
    );
    expect(calls[0].query).toEqual({ genes: ['Acta2', 'Cd3e', 'Krt5'], quality: 'high' });
    expect(ends).toEqual(['Loading transcripts…']); // on the canvas while they load and draw
    const [layer] = layers();
    expect(layer).toBeDefined();
    expect(Array.from(layer.positions)).toEqual(
      expect.arrayContaining([10 - 75, 5 - 25, 10 - 50, 20 - 75, 5 - 25, 20 - 50, 120 - 75, 5 - 25, 10 - 50]),
    );
    expect(layer.scale3d).toEqual([1, 1, 2]);

    // A size or opacity change restyles without reading again; a stretch follows the scene.
    await t.sync(
      dataset(),
      view({ transcriptGenes: ['Acta2', 'Cd3e', 'Krt5'], transcriptOpacity: 0.3 }),
      port,
      frame,
    );
    expect(calls).toHaveLength(2);
    expect(layers()[0].opacity).toBe(0.3);
    t.setZScale(5);
    expect(layers()[0].scale3d).toEqual([1, 1, 5]);

    // Turning transcripts off takes the layer down.
    await t.sync(dataset(), view({ transcriptMode: 'off' }), port, frame);
    expect(layers()).toHaveLength(0);
  });

  it('fades the transcripts outside a selected cell or cell type, as the cells are, without reading again', async () => {
    const { t, port, layers } = setup();
    (port.getTranscriptTile as jest.Mock).mockImplementation(async (_l: number, gx: number) =>
      gx === 0 ? tile([10, 20], [0, 1], [0, 1]) : tile([120], [2], [2]),
    );
    const v = view({ transcriptGenes: ['Acta2', 'Cd3e', 'Krt5'] });
    await t.sync(dataset(), v, port, frame);
    expect(layers()[0].alphas).toBeNull();

    // Cell 1 selected: its transcript as it is, the others faded.
    const selection = { mask: Uint8Array.of(0, 1, 0), count: 1 };
    await t.sync(dataset(), v, port, frame, selection);
    const alphas = Array.from(layers()[0].alphas ?? []);
    const cellOf = (x: number) => (x === 10 ? 0 : x === 20 ? 1 : 2);
    const xs = Array.from({ length: alphas.length }, (_v, i) => layers()[0].positions[3 * i] + 75);
    xs.forEach((x, i) => expect(alphas[i]).toBeCloseTo(cellOf(Math.round(x)) === 1 ? 1 : DEFAULT_MUTED_OPACITY));
    expect(alphas).toHaveLength(3);
    expect(port.getTranscriptTile as jest.Mock).toHaveBeenCalledTimes(2); // faded, not read again

    // Cleared: every transcript as it is again.
    await t.sync(dataset(), v, port, frame, { mask: new Uint8Array(3), count: 0 });
    expect(layers()[0].alphas).toBeNull();
  });

  it('leaves out the genes hidden from "All genes"', async () => {
    const { t, port, calls, layers } = setup();
    await t.sync(dataset(), view({ transcriptAllGenes: true, transcriptAllGenesHidden: ['Cd3e'] }), port, frame);
    expect(calls[0].query.genes).toEqual([ALL_GENES]);
    // Acta2 (x 10) and Krt5 (x 120) are drawn; Cd3e (x 20) is not.
    expect(layers()[0].positions.length).toBe(6);
  });

  it('draws nothing for transcripts without z', async () => {
    const { t, port, calls, layers } = setup();
    await t.sync(dataset({ hasZ: false }), view({ transcriptGenes: ['Acta2'] }), port, frame);
    expect(calls).toHaveLength(0);
    expect(layers()).toHaveLength(0);
  });

  it('reads the pyramid level the camera calls for, and only the tiles in view, again when it rests', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const v = new HeadlessViewer({ canvasRect: { width: 200, height: 100 } });
      const viewer = v as unknown as Viewer;
      const levels: number[] = [];
      const tiles: string[] = [];
      const port = {
        getTranscriptTile: jest.fn(async (level: number, gx: number, gy: number) => {
          levels.push(level);
          tiles.push(`${level}/${gx}/${gy}`);
          return tile([gx * 10], [0]);
        }),
      } as unknown as SpatialDataPort;
      const t = new Spatial3dTranscripts(viewer, () => () => undefined);
      // A 10,000-unit section, a pyramid of levels four times coarser each (tiles twice as wide).
      const big = dataset({
        bounds: [0, 0, 10000, 10000],
        count: 10_000_000,
        levels: [0, 1, 2, 3, 4, 5].map((l) => ({ tileSize: 100 * 2 ** l, aggregated: l > 0 })),
      });
      const at = { origin: [-5000, -5000, 0] as const, zScale: 1 };
      // Far out (the whole section in view): a coarse level, every one of its tiles.
      viewer.camera3d.target = [0, 0, 0];
      viewer.camera3d.azimuth = 0; // looking straight down on the section
      viewer.camera3d.elevation = 0;
      viewer.camera3d.distance = 20000;
      await t.sync(big, view({ transcriptAllGenes: true }), port, at);
      const far = Math.max(...levels);
      expect(far).toBeGreaterThan(0);
      // Close in on a cell at the centre: level 0, a few tiles around it only.
      levels.length = 0;
      tiles.length = 0;
      viewer.camera3d.distance = 15;
      jest.advanceTimersByTime(400);
      await Promise.resolve();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(new Set(levels)).toEqual(new Set([0]));
      expect(tiles.length).toBeGreaterThan(0);
      expect(tiles.length).toBeLessThan(16); // not the 10,000 tiles of level 0
      t.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('stays off when the camera moves after the transcripts were turned off', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const v = new HeadlessViewer({ canvasRect: { width: 200, height: 100 } });
      const viewer = v as unknown as Viewer;
      const { port } = setup();
      const t = new Spatial3dTranscripts(viewer, () => () => undefined);
      const layers = () => v.layers.items.filter((l) => l.name === 'transcripts');
      await t.sync(dataset(), view({ transcriptGenes: ['Acta2'] }), port, frame);
      expect(layers()).toHaveLength(1);
      // A move pending as they are turned off, then another after: neither draws them again.
      viewer.camera3d.distance = viewer.camera3d.distance * 2;
      await t.sync(dataset(), view({ transcriptMode: 'off' }), port, frame);
      viewer.camera3d.distance = viewer.camera3d.distance / 3;
      jest.advanceTimersByTime(400);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(layers()).toHaveLength(0);
      t.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  describe('Colour by', () => {
    const typed = () =>
      ({
        ...dataset(),
        columns: [{ kind: 'categorical', name: 'cell_type', categories: ['Goblet', 'Paneth'] }],
      }) as unknown as SpatialDataset;
    /** Each drawn transcript's RGBA, in draw order. */
    const rgbaOf = (layer: Points3DLayer) => {
      const c = (layer as unknown as { colors: Float32Array }).colors;
      return Array.from({ length: c.length / 4 }, (_v, i) => Array.from(c.subarray(i * 4, i * 4 + 4)));
    };

    it("colours each transcript by its cell's type, with the user's group colours, unassigned outside a cell", async () => {
      const { t, port, layers } = setup();
      (port.getTranscriptTile as jest.Mock).mockImplementation(async (_l: number, gx: number) =>
        gx === 0 ? tile([10, 20], [0, 1], [0, 0xffffffff]) : tile([120], [2], [1]),
      );
      await t.sync(
        typed(),
        view({ transcriptGenes: ['Acta2', 'Cd3e', 'Krt5'], groupColors: { cell_type: { Paneth: '#ff0000' } } }),
        port,
        frame,
      );
      const rgba = rgbaOf(layers()[0]);
      const [r, g, b] = parseHex(DEFAULT_CATEGORICAL_PALETTE[0]);
      expect(rgba[0][0]).toBeCloseTo(r / 255, 5); // in a Goblet cell
      expect(rgba[0][1]).toBeCloseTo(g / 255, 5);
      expect(rgba[0][2]).toBeCloseTo(b / 255, 5);
      expect(rgba[1][3]).toBeCloseTo(0.55, 5); // in no cell: unassigned
      expect(rgba[2]).toEqual([1, 0, 0, 1]); // in a Paneth cell, in the user's colour
    });

    it("colours by a gene's cluster, a cluster named like a cell group in that group's colour", async () => {
      const { t, port, layers } = setup();
      await t.sync(
        typed(),
        view({
          transcriptColorBy: 'cluster',
          transcriptGenes: ['Acta2', 'Cd3e', 'Krt5'],
          transcriptGeneGroups: [{ name: 'Paneth', genes: ['Acta2', 'Krt5'] }],
          groupColors: { cell_type: { Paneth: '#00ff00' } },
        }),
        port,
        frame,
      );
      const rgba = rgbaOf(layers()[0]);
      // Acta2 (x 10) and Krt5 (x 120) are the Paneth cluster: the Paneth cells' colour.
      expect(rgba[0]).toEqual([0, 1, 0, 1]);
      expect(rgba[2]).toEqual([0, 1, 0, 1]);
      expect(rgba[1]).not.toEqual([0, 1, 0, 1]);
    });

    it('colours by gene when the dataset has no cell types to colour by', async () => {
      const { t, port, layers } = setup();
      await t.sync(
        dataset(),
        view({ transcriptGenes: ['Acta2'], transcriptGeneColors: { Acta2: '#0000ff' } }),
        port,
        frame,
      );
      expect(rgbaOf(layers()[0])[0]).toEqual([0, 0, 1, 1]);
    });
  });

  it('takes the drawn transcripts down when the genes asked for next cannot be read', async () => {
    const { t, port, layers } = setup();
    await t.sync(dataset(), view({ transcriptGenes: ['Acta2'] }), port, frame);
    expect(layers()).toHaveLength(1);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (port.getTranscriptTile as jest.Mock).mockRejectedValue(new Error('503'));
    await t.sync(dataset(), view({ transcriptGenes: ['Cd3e'] }), port, frame);
    expect(layers()).toHaveLength(0);
    warn.mockRestore();
  });
});
