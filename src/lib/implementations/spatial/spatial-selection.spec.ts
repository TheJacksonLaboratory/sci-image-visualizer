import {
  countMask, emptySelection, maskToIndices, mutedFromSelection, pointInRing,
  regionShapes, sameSelection, selectByCategory, selectInRegions, selectInRegionsProjected,
} from './spatial-selection';
import { MultiPolygon, Polygon, Rectangle, Region } from '../../models/region';
import { SpatialObservations } from '../../contracts/spatial-dataset.contract';

/** Observations at the given [x, y] pairs. */
function obs(...points: [number, number][]): SpatialObservations {
  return {
    count: points.length,
    x: Float32Array.from(points.map((p) => p[0])),
    y: Float32Array.from(points.map((p) => p[1])),
  };
}

function rectRegion(x: number, y: number, w: number, h: number): Region {
  const r = new Region();
  const b = new Rectangle();
  b.x = x; b.y = y; b.width = w; b.height = h;
  r.bounds = b;
  return r;
}

function polyRegion(xs: number[], ys: number[], over: Partial<Polygon> = {}): Region {
  const r = new Region();
  const p = new Polygon();
  p.xpoints = xs; p.ypoints = ys; p.npoints = xs.length;
  Object.assign(p, over);
  r.bounds = p;
  return r;
}

describe('spatial-selection', () => {
  describe('pointInRing', () => {
    const sq = { xs: [0, 10, 10, 0], ys: [0, 0, 10, 10] };

    it('is true inside and false outside', () => {
      expect(pointInRing(sq.xs, sq.ys, 5, 5)).toBe(true);
      expect(pointInRing(sq.xs, sq.ys, 15, 5)).toBe(false);
      expect(pointInRing(sq.xs, sq.ys, -1, 5)).toBe(false);
    });

    it('counts a vertex-level ray once, not twice', () => {
      // y == a vertex y is the classic double-count bug; the half-open
      // comparison must keep an interior point interior.
      expect(pointInRing([0, 10, 5], [0, 0, 10], 5, 0.001)).toBe(true);
    });

    it('handles a concave ring (a point in the notch is outside)', () => {
      // A "C" shape opening to the right.
      const xs = [0, 10, 10, 4, 4, 10, 10, 0];
      const ys = [0, 0, 3, 3, 7, 7, 10, 10];
      expect(pointInRing(xs, ys, 2, 5)).toBe(true);   // in the spine
      expect(pointInRing(xs, ys, 7, 5)).toBe(false);  // in the notch
    });
  });

  describe('regionShapes', () => {
    it('normalises a rectangle dragged right-to-left / bottom-to-top', () => {
      const [shape] = regionShapes(rectRegion(10, 10, -6, -6));
      expect(shape.hit(7, 7)).toBe(true);
      expect(shape.hit(2, 2)).toBe(false);
    });

    it('ignores shapes that enclose no area', () => {
      expect(regionShapes(rectRegion(0, 0, 0, 10))).toEqual([]);        // zero width
      expect(regionShapes(polyRegion([0, 5], [0, 5]))).toEqual([]);     // 2 points
      expect(regionShapes(polyRegion([0, 5, 5], [0, 0, 5], { closed: false })))
        .toEqual([]);                                                   // open polyline
    });

    it('ignores intensity-profile line ROIs (they belong to another tool)', () => {
      const r = polyRegion([0, 10, 10], [0, 0, 10]);
      (r as unknown as { kind: string }).kind = 'profile';
      expect(regionShapes(r)).toEqual([]);
    });

    it('treats a hole as outside the region', () => {
      const donut = polyRegion([0, 20, 20, 0], [0, 0, 20, 20], {
        holes: [[[5, 5], [15, 5], [15, 15], [5, 15]]],
      } as Partial<Polygon>);
      const [shape] = regionShapes(donut);
      expect(shape.hit(2, 2)).toBe(true);    // in the ring
      expect(shape.hit(10, 10)).toBe(false); // in the hole
    });

    it('flattens a MultiPolygon into one shape per part', () => {
      const r = new Region();
      const mp = new MultiPolygon();
      const a = new Polygon();
      a.xpoints = [0, 5, 5, 0]; a.ypoints = [0, 0, 5, 5];
      const b = new Polygon();
      b.xpoints = [10, 15, 15, 10]; b.ypoints = [10, 10, 15, 15];
      mp.polygons = [a, b];
      r.bounds = mp;
      expect(regionShapes(r)).toHaveLength(2);
    });
  });

  describe('selectInRegions', () => {
    it('selects the observations inside a rectangle', () => {
      const selection = selectInRegions(
        obs([1, 1], [5, 5], [50, 50]), undefined, [rectRegion(0, 0, 10, 10)],
      );
      expect(Array.from(selection.mask)).toEqual([1, 1, 0]);
      expect(selection.count).toBe(2);
    });

    it('unions multiple regions rather than intersecting them', () => {
      const selection = selectInRegions(
        obs([1, 1], [50, 50], [200, 200]), undefined,
        [rectRegion(0, 0, 10, 10), rectRegion(40, 40, 20, 20)],
      );
      expect(Array.from(selection.mask)).toEqual([1, 1, 0]);
    });

    it('applies the imageRef affine, so it agrees with what the renderer draws', () => {
      // Observations at 100,100 land at 50,50 in world space under scale 0.5 —
      // inside a region drawn at 40..60. Without the transform they would miss.
      const observations = obs([100, 100]);
      const region = [rectRegion(40, 40, 20, 20)];
      expect(selectInRegions(observations, { scale: [0.5, 0.5] }, region).count).toBe(1);
      expect(selectInRegions(observations, undefined, region).count).toBe(0);
    });

    it('honours a translate as well as a scale', () => {
      expect(selectInRegions(
        obs([0, 0]), { scale: [1, 1], translate: [50, 50] }, [rectRegion(40, 40, 20, 20)],
      ).count).toBe(1);
    });

    it('restricts the test to the candidate indices, keeping the mask observation-indexed', () => {
      // Three observations at the same x/y — different sections of a registered
      // volume seen from above. A region drawn over the displayed section must
      // select that section's cell only, not the column of brain behind it.
      const observations = obs([1, 1], [1, 1], [1, 1]);
      const region = [rectRegion(0, 0, 10, 10)];
      expect(selectInRegions(observations, undefined, region).count).toBe(3);

      const selection = selectInRegions(observations, undefined, region, new Uint32Array([1]));
      expect(Array.from(selection.mask)).toEqual([0, 1, 0]);
      expect(selection.count).toBe(1);
    });

    it('selects nothing when every candidate is outside the region', () => {
      const selection = selectInRegions(
        obs([1, 1], [50, 50]), undefined, [rectRegion(0, 0, 10, 10)], new Uint32Array([1]),
      );
      expect(selection.count).toBe(0);
    });

    it('selects nothing when no region encloses area', () => {
      const selection = selectInRegions(obs([1, 1]), undefined, [rectRegion(0, 0, 0, 0)]);
      expect(selection.count).toBe(0);
    });

    it('selects nothing for an empty region list', () => {
      expect(selectInRegions(obs([1, 1]), undefined, []).count).toBe(0);
    });
  });

  describe('selectInRegionsProjected', () => {
    /** Screen positions as the renderer hands them over: [x0, y0, x1, y1, …]. */
    const screen = (...pts: [number, number][]) =>
      Float32Array.from(pts.flatMap(([x, y]) => [x, y]));

    it('selects points whose SCREEN position falls inside the region', () => {
      const selection = selectInRegionsProjected(
        screen([5, 5], [50, 50], [8, 2]), 3, [rectRegion(0, 0, 10, 10)],
      );
      expect(selection.count).toBe(2);
      expect(Array.from(maskToIndices(selection.mask))).toEqual([0, 2]);
    });

    it('ignores the imageRef affine entirely', () => {
      // The whole point of this path: the coordinates are ALREADY in screen
      // space, so there is no data->world transform left to apply. A selection
      // that silently re-applied one would land in the wrong place, and would do
      // it invisibly because the outline and the cloud both look plausible.
      const pts = screen([5, 5]);
      expect(selectInRegionsProjected(pts, 1, [rectRegion(0, 0, 10, 10)]).count).toBe(1);
      // Same numbers via the 2D path with a 0.5 scale would MISS this rectangle,
      // which is what makes the two paths genuinely different.
      expect(selectInRegions(obs([5, 5]), { scale: [10, 10] }, [rectRegion(0, 0, 10, 10)]).count)
        .toBe(0);
    });

    it('never selects a point the camera puts behind the eye', () => {
      // The projector writes NaN for a non-positive w rather than a wild
      // coordinate; without the finite check those wrap into the region and a
      // lasso would grab points behind the viewer.
      const selection = selectInRegionsProjected(
        screen([NaN, NaN], [5, 5]), 2, [rectRegion(0, 0, 10, 10)],
      );
      expect(selection.count).toBe(1);
      expect(Array.from(maskToIndices(selection.mask))).toEqual([1]);
    });

    it('selects nothing when no region is drawn', () => {
      expect(selectInRegionsProjected(screen([5, 5]), 1, []).count).toBe(0);
    });

    it('takes the union across regions, counting a point once', () => {
      const selection = selectInRegionsProjected(
        screen([5, 5]), 1, [rectRegion(0, 0, 10, 10), rectRegion(4, 4, 10, 10)],
      );
      expect(selection.count).toBe(1);
    });

    it('works with a polygon lasso, not just a rectangle', () => {
      // Freehand and polygon are the tools people actually reach for on a cloud.
      const triangle = polyRegion([0, 10, 0], [0, 0, 10]);
      const selection = selectInRegionsProjected(
        screen([1, 1], [9, 9]), 2, [triangle],
      );
      expect(Array.from(maskToIndices(selection.mask))).toEqual([0]);
    });
  });

  describe('selectByCategory', () => {
    it('selects every observation with the given code', () => {
      const selection = selectByCategory(new Uint16Array([0, 1, 1, 0]), 1);
      expect(Array.from(selection.mask)).toEqual([0, 1, 1, 0]);
      expect(selection.count).toBe(2);
    });

    it('selects nothing for a code no observation carries', () => {
      expect(selectByCategory(new Uint16Array([0, 0]), 3).count).toBe(0);
    });
  });

  describe('mask helpers', () => {
    it('emptySelection is sized but empty', () => {
      const empty = emptySelection(5);
      expect(empty.mask).toHaveLength(5);
      expect(empty.count).toBe(0);
    });

    it('countMask and maskToIndices agree', () => {
      const mask = new Uint8Array([0, 1, 0, 1, 1]);
      expect(countMask(mask)).toBe(3);
      expect(Array.from(maskToIndices(mask))).toEqual([1, 3, 4]);
    });

    describe('mutedFromSelection', () => {
      it('mutes nothing when nothing is selected — the tissue reads normally', () => {
        expect(mutedFromSelection(emptySelection(3))).toBeNull();
      });

      it('mutes everything NOT selected, so the selection is what stands out', () => {
        const muted = mutedFromSelection({ mask: new Uint8Array([0, 1, 0]), count: 1 });
        expect(Array.from(muted!)).toEqual([1, 0, 1]);
      });
    });
  });
});

describe('sameSelection', () => {
  const sel = (bytes: number[]) => ({
    mask: Uint8Array.from(bytes),
    count: bytes.filter((b) => b).length,
  });

  it('is true for the same observations', () => {
    expect(sameSelection(sel([1, 0, 1]), sel([1, 0, 1]))).toBe(true);
  });

  it('is false for a different set of the same size', () => {
    // The cheap count check cannot catch this one, which is the case that matters:
    // two classes with equally many cells.
    expect(sameSelection(sel([1, 0, 1]), sel([0, 1, 1]))).toBe(false);
  });

  it('is false for different sizes or different counts', () => {
    expect(sameSelection(sel([1, 0]), sel([1, 0, 0]))).toBe(false);
    expect(sameSelection(sel([1, 1, 0]), sel([1, 0, 0]))).toBe(false);
  });

  it('treats any non-zero flag as selected', () => {
    // Writers are free to use any truthy value for "selected".
    expect(sameSelection(sel([2, 0, 7]), sel([1, 0, 1]))).toBe(true);
  });

  it('is true for two empty selections', () => {
    expect(sameSelection(emptySelection(), emptySelection())).toBe(true);
  });
});
