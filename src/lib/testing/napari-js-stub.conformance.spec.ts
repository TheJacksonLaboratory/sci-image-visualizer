/**
 * The napari-js jest stub, checked against the REAL napari-js types (review REPO-18).
 *
 * Specs type-check against the real `.d.ts` (TypeScript resolves `napari-js` to the package)
 * but run against `napari-js-stub.ts` (jest's moduleNameMapper). Nothing else ties the two
 * together, so a napari-js upgrade could change a signature the stub still fakes the old way
 * and every spec would keep passing against behaviour the library no longer has. The
 * assignments below make that a COMPILE error in this spec instead.
 *
 * Direction: SIV code is typed against the real API and receives the stub at runtime, so
 * each stub member must be usable WHERE THE REAL ONE IS EXPECTED — it accepts at least what
 * the real one accepts and returns something shaped like what the real one returns. Covered:
 * the members SIV uses. Known, documented deviations are listed at the bottom.
 */
import type * as Real from 'napari-js';

import * as Stub from './napari-js-stub';

/** Compile-time only: `Stub` must be assignable to `Real`. */
function conforms<T>(_stub: T): void {
  /* type check only */
}

// ── pure helpers: identical signatures ──────────────────────────────────────────
conforms<typeof Real.projectPoint>(Stub.projectPoint);
conforms<typeof Real.projectPoints>(Stub.projectPoints);
conforms<typeof Real.nearestProjectedIndex>(Stub.nearestProjectedIndex);
conforms<typeof Real.worldViewport>(Stub.worldViewport);
conforms<typeof Real.histogramScalar>(Stub.histogramScalar);
conforms<typeof Real.heightField>(Stub.heightField);
conforms<typeof Real.LUT_SIZE>(Stub.LUT_SIZE);
conforms<number>(Stub.WHEEL_DELTA_CLAMP);
conforms<typeof Real.SCREEN_INDEX_MIN_POINTS>(Stub.SCREEN_INDEX_MIN_POINTS);

// ── classes ─────────────────────────────────────────────────────────────────────
type PublicOf<T, K extends keyof T> = Pick<T, K>;

conforms<
  new (
    ...a: ConstructorParameters<typeof Real.ScreenIndex>
  ) => PublicOf<Real.ScreenIndex, 'pick' | 'indexed' | 'cell' | 'cols' | 'rows' | 'margin'>
>(Stub.ScreenIndex);

conforms<
  new (
    ...a: ConstructorParameters<typeof Real.LruCache<number>>
  ) => PublicOf<Real.LruCache<number>, 'get' | 'set' | 'has' | 'delete' | 'clear' | 'size'>
>(Stub.LruCache<number>);

conforms<new (...a: ConstructorParameters<typeof Real.Colormap>) => PublicOf<Real.Colormap, 'name'>>(
  Stub.Colormap,
);

/** The Viewer members SIV calls whose types the stub can match exactly. */
type ViewerSurface = PublicOf<
  Real.Viewer,
  | 'ready'
  | 'canvasToWorld'
  | 'worldToCanvas'
  | 'visibleWorldRect'
  | 'projectPoints'
  | 'requestRender'
  | 'setControlsEnabled'
  | 'controlsActive'
  | 'resetFit3D'
  | 'fitToLayers'
  | 'screenshot'
  | 'dispose'
>;
conforms<new (...a: ConstructorParameters<typeof Real.Viewer>) => ViewerSurface>(Stub.Viewer);

/** Type-level assignability: `true` when `A` can be used where `B` is expected. */
type Assignable<A, B> = [A] extends [B] ? true : false;
type Assert<T extends true> = T;

/** The 2D camera: what the navigator, scale bar, overlays and spatial tiles read and drive. */
type StubCamera = Stub.Viewer['camera'];
export type CameraConforms = Assert<Assignable<StubCamera, PublicOf<Real.Camera, 'center' | 'zoom' | 'set'>>>;
export type CameraEventConforms = Assert<
  Assignable<StubCamera['changed'], { connect(listener: () => void): () => void }>
>;

/** The layer list: order and structural events (the spatial overlays reorder by re-adding). */
type StubLayers = Stub.Viewer['layers'];
export type LayerListConforms = Assert<
  Assignable<
    StubLayers,
    PublicOf<Real.LayerList, 'length' | 'clear'> & {
      readonly items: readonly unknown[];
      add(layer: Real.Layer): unknown;
      remove(layer: Real.Layer): boolean;
      readonly added: { connect(listener: () => void): () => void };
      readonly removed: { connect(listener: () => void): () => void };
      readonly changed: { connect(listener: () => void): () => void };
    }
  >
>;

// ── value exports: nothing the real package lacks ───────────────────────────────
/** Names the stub exports as values that napari-js does not: must stay empty. */
type StubOnlyExports = Exclude<keyof typeof Stub, keyof typeof Real>;
const noStubOnlyExports: [StubOnlyExports] extends [never] ? true : StubOnlyExports = true;

/*
 * Known deviations (not checked above, on purpose):
 * - `addImage`/`addPoints`/`addShapes`/`addVolume`/… return plain objects that keep their
 *   constructor arguments, not the real layer classes; specs read those arguments back.
 * - `colormapFromLut` keeps the raw LUT rows as `stops` (the real one normalises them into
 *   ColorStops); a service spec indexes the rows. Colormap does not sort or sample.
 * - `camera.fit`, `fitToLayers` and `addSurface` framing are not modelled.
 * - `MultiChannelImageView`/`MultiChannelVolumeView` take the stub's minimal host types.
 */

describe('napari-js stub conformance', () => {
  it('type-checks against the real napari-js declarations (see the assignments above)', () => {
    expect(noStubOnlyExports).toBe(true);
  });

  it('behaves like napari-js where specs depend on it', () => {
    // Colormap validation.
    expect(() => new Stub.Colormap('x', [])).toThrow();
    expect(() => Stub.colormapFromLut('x', [[0, 0, 0]])).toThrow();
    // Depth clip: a point past the far plane is not drawn.
    const farOnly = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]; // clip z = 2z
    expect(Stub.projectPoint(farOnly, [0, 0, 0.4], 100, 100).visible).toBe(true);
    expect(Stub.projectPoint(farOnly, [0, 0, 0.6], 100, 100).visible).toBe(false);
    // ScreenIndex: a centre beyond maxReach off the canvas cannot be picked.
    const screen = Float32Array.from([-40, 50, -10, 50]);
    const index = new Stub.ScreenIndex({ screen, depth: new Float32Array(2) }, 100, 100, { maxReach: 32 });
    expect(index.indexed).toBe(1);
    expect(index.pick(-40, 50, 5)).toBe(-1);
    expect(index.pick(-10, 50, 5)).toBe(1);
    // worldToCanvas returns CLIENT px: the canvas rect's origin is added.
    const canvas = document.createElement('canvas');
    jest
      .spyOn(canvas, 'getBoundingClientRect')
      .mockReturnValue({ left: 100, top: 50, width: 0, height: 0 } as DOMRect);
    const viewer = new Stub.Viewer({ canvas });
    expect(viewer.worldToCanvas(2, 3)).toEqual([102, 53]);
    expect(viewer.canvasToWorld(102, 53)).toEqual([2, 3]);
    // Layer list events.
    const added: unknown[] = [];
    viewer.layers.added.connect((l) => added.push(l));
    const layer = viewer.addShapes(new Float32Array(0), new Uint32Array([0]));
    expect(added).toEqual([layer]);
    expect(viewer.layers.items).toEqual([layer]);
  });
});
