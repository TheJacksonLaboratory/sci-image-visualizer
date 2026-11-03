import { HeadlessViewer } from 'napari-js/testing';
import type { Points3DLayer, Viewer } from 'napari-js';

import {
  ALL_GENES,
  type SpatialDataPort,
  type TranscriptTileQuery,
} from '../../contracts/ports/spatial-data.port';
import { DEFAULT_SPATIAL_VIEW, SpatialViewState } from '../../contracts/display-types';
import type { SpatialDataset, SpatialTranscriptTile } from '../../contracts/spatial-dataset.contract';
import { DEFAULT_CATEGORICAL_PALETTE, parseHex } from '../../spatial/spatial-encoding';
import {
  Spatial3dTranscripts,
  TRANSCRIPTS_3D_MAX,
  transcripts3dColors,
  transcripts3dGenes,
} from './napari-spatial-3d-transcripts';

/** A 2 × 1 tile dataset (tiles 100 wide) whose transcripts carry z. */
function dataset(over: Partial<NonNullable<SpatialDataset['transcriptTiles']>> = {}): SpatialDataset {
  return {
    id: 'ileum',
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

function tile(xs: number[], genes: number[]): SpatialTranscriptTile {
  const n = xs.length;
  return {
    count: n,
    aggregated: false,
    x: Float32Array.from(xs),
    y: Float32Array.from(xs, () => 5),
    z: Float32Array.from(xs, (_x, i) => 10 * (i + 1)),
    weight: new Uint32Array(n).fill(1),
    observation: new Uint32Array(n),
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
    expect(ends).toEqual(['Transcripts']);
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

  it('leaves out the genes hidden from "All genes"', async () => {
    const { t, port, calls, layers } = setup();
    await t.sync(dataset(), view({ transcriptAllGenes: true, transcriptAllGenesHidden: ['Cd3e'] }), port, frame);
    expect(calls[0].query.genes).toEqual([ALL_GENES]);
    // Acta2 (x 10) and Krt5 (x 120) are drawn; Cd3e (x 20) is not.
    expect(layers()[0].positions.length).toBe(6);
  });

  it('draws nothing for transcripts without z, or too many of them for "All genes"', async () => {
    const { t, port, calls, layers } = setup();
    await t.sync(dataset({ hasZ: false }), view({ transcriptGenes: ['Acta2'] }), port, frame);
    await t.sync(dataset({ count: TRANSCRIPTS_3D_MAX + 1 }), view({ transcriptAllGenes: true }), port, frame);
    expect(calls).toHaveLength(0);
    expect(layers()).toHaveLength(0);
  });
});
