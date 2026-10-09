import { HoverSource, PointGridIndex, hoverText, nearestObservation } from './spatial-hover';
import { NO_CATEGORY } from '../contracts/spatial-dataset.contract';

describe('nearestObservation', () => {
  // Three drawn points and one that is not on screen.
  const screen = Float32Array.from([10, 10, 50, 50, 12, 13, NaN, NaN]);

  it('finds the point under the cursor', () => {
    expect(nearestObservation(screen, 10, 10, 8)).toBe(0);
    expect(nearestObservation(screen, 49, 51, 8)).toBe(1);
  });

  it('picks the nearest when two are within reach', () => {
    // (12,13) is 3.6px from (12,10); (10,10) is 2px.
    expect(nearestObservation(screen, 12, 10, 8)).toBe(0);
    // Move closer to the other one and the answer follows.
    expect(nearestObservation(screen, 12, 14, 8)).toBe(2);
  });

  it('returns -1 when nothing is close enough', () => {
    expect(nearestObservation(screen, 200, 200, 8)).toBe(-1);
    // Exactly at the radius still counts; a pixel further does not, so the
    // tooltip does not follow the cursor around empty tissue.
    const lone = Float32Array.from([10, 10]);
    expect(nearestObservation(lone, 10, 20, 10)).toBe(0);
    expect(nearestObservation(lone, 10, 21, 10)).toBe(-1);
  });

  it('skips observations that are not drawn', () => {
    // Index 3 is NaN — a hidden section, or behind the eye. NaN fails every
    // comparison, so it can never win, and never becomes a phantom tooltip.
    expect(nearestObservation(Float32Array.from([NaN, NaN]), 0, 0, 1000)).toBe(-1);
  });

  it('breaks a tie towards the point drawn on top', () => {
    // Two points at the same place: the later one is drawn over the earlier, so
    // it is the one the user believes they are pointing at.
    const stacked = Float32Array.from([20, 20, 20, 20]);
    expect(nearestObservation(stacked, 20, 20, 5)).toBe(1);
  });

  it('handles an empty cloud', () => {
    expect(nearestObservation(new Float32Array(0), 0, 0, 10)).toBe(-1);
  });
});

describe('hoverText', () => {
  const categorical: HoverSource = {
    kind: 'categorical',
    name: 'class',
    categories: ['06 CTX-CGE GABA', '18 TH Glut'],
    codes: Uint16Array.from([1, 0, NO_CATEGORY]),
  };

  it('names the class, then the column it came from', () => {
    expect(hoverText(categorical, 0)).toEqual(['18 TH Glut', 'class']);
    expect(hoverText(categorical, 1)).toEqual(['06 CTX-CGE GABA', 'class']);
  });

  it('says nothing for an observation with no category', () => {
    // NO_CATEGORY is outside the list: a cell the annotation does not cover. A
    // tooltip reading "undefined" would be worse than no tooltip.
    expect(hoverText(categorical, 2)).toBeNull();
    // …and so is an index past the end.
    expect(hoverText(categorical, 99)).toBeNull();
  });

  it('reports a continuous value with its unit', () => {
    const source: HoverSource = {
      kind: 'continuous',
      name: 'Slc32a1',
      values: Float32Array.from([4.25, 0, NaN]),
      unit: 'log2(CPM+1)',
    };
    expect(hoverText(source, 0)).toEqual(['4.25 log2(CPM+1)', 'Slc32a1']);
    expect(hoverText(source, 1)).toEqual(['0 log2(CPM+1)', 'Slc32a1']);
    // Not measured for this cell — distinct from a measured zero.
    expect(hoverText(source, 2)).toBeNull();
  });

  it('keeps a value readable at either extreme, and needs no unit', () => {
    const big: HoverSource = {
      kind: 'continuous', name: 'counts', values: Float32Array.from([12345, 0.0001, 3.14159]),
    };
    expect(hoverText(big, 0)).toEqual(['1.23e+4', 'counts']);
    expect(hoverText(big, 1)).toEqual(['1.00e-4', 'counts']);
    expect(hoverText(big, 2)).toEqual(['3.14', 'counts']);
  });

  it('says nothing without a colour source, or without a hit', () => {
    // Nothing is being shown about the cells, so there is no cluster to name.
    expect(hoverText(null, 0)).toBeNull();
    expect(hoverText(categorical, -1)).toBeNull();
  });
});

describe('PointGridIndex', () => {
  /** A deterministic pseudo-random cloud, with some points not drawn. */
  function cloud(n: number, seed = 7): Float32Array {
    let s = seed;
    const rand = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const hidden = rand() < 0.05;
      out[i * 2] = hidden ? NaN : rand() * 1000;
      out[i * 2 + 1] = hidden ? NaN : rand() * 600;
    }
    return out;
  }

  it('answers exactly what the linear scan answers', () => {
    const positions = cloud(5000);
    const index = PointGridIndex.build(positions)!;
    for (let q = 0; q < 500; q++) {
      const x = (q * 37) % 1100 - 50;
      const y = (q * 53) % 700 - 50;
      for (const r of [0.5, 5, 40, 2000]) {
        expect(index.nearest(x, y, r)).toBe(nearestObservation(positions, x, y, r));
      }
    }
  });

  it('gives a tie to the later observation, as the scan does', () => {
    const positions = Float32Array.from([10, 10, 10, 10, 0, 0, 10, 10]);
    expect(PointGridIndex.build(positions)!.nearest(10, 10, 1)).toBe(3);
  });

  it('skips undrawn points and is null when nothing is drawn', () => {
    const positions = Float32Array.from([NaN, NaN, 5, 5]);
    expect(PointGridIndex.build(positions)!.nearest(5, 5, 1)).toBe(1);
    expect(PointGridIndex.build(Float32Array.from([NaN, NaN]))).toBeNull();
  });

  it('handles every point on one spot', () => {
    const positions = Float32Array.from([3, 3, 3, 3, 3, 3]);
    const index = PointGridIndex.build(positions)!;
    expect(index.nearest(3, 3, 0)).toBe(2);
    expect(index.nearest(4, 3, 0.5)).toBe(-1);
  });
});
