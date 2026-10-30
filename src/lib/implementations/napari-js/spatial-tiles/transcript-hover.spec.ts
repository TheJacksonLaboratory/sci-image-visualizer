import { PointsLayer } from 'napari-js';

import type { SpatialDataPort } from '../../../contracts/ports/spatial-data.port';
import type { SpatialTranscriptTile } from '../../../contracts/spatial-dataset.contract';
import { TranscriptHover } from './transcript-hover';

const tile = (xs: number[], ys: number[]): SpatialTranscriptTile => ({
  count: xs.length,
  aggregated: false,
  x: Float32Array.from(xs),
  y: Float32Array.from(ys),
  z: new Float32Array(xs.length),
  weight: new Uint32Array(xs.length).fill(1),
  observation: Uint32Array.from(xs.map((_v, i) => i)),
  gene: Uint16Array.from(xs.map((_v, i) => i)),
});

describe('TranscriptHover: which marker is under the pointer', () => {
  /** Markers of radius `r` at `xs` (y as given), each its own gene `G<i>`, behind `affine`. */
  function hoverOver(xs: number[], ys: number[], r: number, affine = { scale: [1, 1], translate: [0, 0] }) {
    const merged = tile(xs, ys);
    const positions = new Float32Array(xs.flatMap((x, i) => [x, ys[i]]));
    const layer = new PointsLayer(positions, {
      size: new Float32Array(xs.length).fill(2 * r),
      scale: affine.scale as [number, number],
      translate: affine.translate as [number, number],
    });
    const hover = new TranscriptHover({} as SpatialDataPort, () => true);
    hover.setDrawn({ kind: 'genes', merged, layer, genes: xs.map((_v, i) => `G${i}`) }, null);
    /** The gene named at world `(x, y)` with `tolerance` world units of slack, or null. */
    return (x: number, y: number, tolerance: number) =>
      hover.hoverAt(x, y, tolerance, () => undefined)?.[0]?.split(' ')[0] ?? null;
  }

  it('finds the marker under the cursor, within its radius', () => {
    const at = hoverOver([0, 10, 20], [0, 0, 0], 2);
    expect(at(10.5, 0.5, 0.1)).toBe('G1');
    expect(at(15, 0, 0.1)).toBeNull(); // between markers
  });

  it('uses the pointer tolerance for markers smaller than it', () => {
    const at = hoverOver([0, 10], [0, 0], 0.1);
    expect(at(1, 0, 1.5)).toBe('G0');
  });

  it('prefers the closest of overlapping markers', () => {
    const at = hoverOver([0, 1.5], [0, 0], 2);
    expect(at(1.2, 0, 0.1)).toBe('G1');
    expect(at(0.2, 0, 0.1)).toBe('G0');
  });

  it('gives an exact tie to the marker drawn on top', () => {
    // Two genes' groups on one bin centre: the later one is the one on screen.
    const at = hoverOver([5, 5], [5, 5], 2);
    expect(at(5, 5, 0.1)).toBe('G1');
  });

  it("names an individual transcript's gene by its code, before any details arrive", () => {
    const merged = tile([0, 10], [0, 0]);
    const layer = new PointsLayer(new Float32Array([0, 0, 10, 0]), { size: new Float32Array(2).fill(2) });
    const hover = new TranscriptHover({} as SpatialDataPort, () => true);
    hover.setDrawn({ kind: 'individual', merged, layer, genes: ['ACTA2', 'KRT5'] }, null);
    expect(hover.hoverAt(10, 0, 0.1, () => undefined)?.[0]).toBe('KRT5 transcript');
    // Without the dataset's gene list it waits for the server's summary.
    hover.setDrawn({ kind: 'individual', merged, layer, genes: [] }, null);
    expect(hover.hoverAt(10, 0, 0.1, () => undefined)?.[0]).toBe('Transcript');
  });

  it("reads the pointer through the layer's dataset affine", () => {
    // World = data × 2 + 100: the marker at data (10, 0) sits at world (120, 100).
    const at = hoverOver([0, 10], [0, 0], 1, { scale: [2, 2], translate: [100, 100] });
    expect(at(120, 100, 0.1)).toBe('G1');
    expect(at(10, 0, 0.1)).toBeNull();
  });
});
