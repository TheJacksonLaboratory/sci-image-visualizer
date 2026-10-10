import { WandImage, WandOptions, computeWandPatchMask, computeWandRegion } from './wand-region-grow';
import { WandService } from './wand.service';

/** A 120×120 image: a bright disc (r=25) at (60,60) with a gradient-ish dark surround. */
function discImage(rgb: boolean): WandImage {
  const W = 120, H = 120;
  const data: (number | number[])[][] = [];
  for (let y = 0; y < H; y++) {
    const row: (number | number[])[] = [];
    for (let x = 0; x < W; x++) {
      const inside = (x - 60) ** 2 + (y - 60) ** 2 <= 25 * 25;
      const v = inside ? 200 + ((x * 7 + y * 3) % 9) : 20 + ((x + y) % 5);
      row.push(rgb ? [v, inside ? 40 : 180, v / 2] : v);
    }
    data.push(row);
  }
  return { data: data as WandImage['data'], width: W, height: H, isGrayscale: !rgb };
}

describe('wand-region-grow', () => {
  const cases: [string, boolean, WandOptions][] = [
    ['gray default', false, { patchSize: 81 }],
    ['gray simple', false, { patchSize: 81, simpleMode: true }],
    ['rgb default', true, { patchSize: 81 }],
    ['rgb LAB_DISTANCE', true, { patchSize: 81, type: 'LAB_DISTANCE' }],
    ['rgb forced GRAY', true, { patchSize: 81, type: 'GRAY', sensitivity: 3 }],
  ];

  it.each(cases)('%s: the WandService façade returns exactly the pure pipeline output', (_n, rgb, opts) => {
    const img = discImage(rgb);
    const svc = new WandService();
    expect(svc.computePatchMask(img, 60, 60, opts)).toEqual(computeWandPatchMask(img, 60, 60, opts));
    expect(svc.computeRegion(img, 60, 60, opts)).toEqual(computeWandRegion(img, 60, 60, opts));
  });

  // LAB_DISTANCE thresholds on the mean distance, so on this two-tone image it
  // leaks into the surround; the equality case above pins it.
  it.each(cases.filter(([n]) => !n.includes('LAB')))('%s: grows a region roughly covering the disc', (_n, rgb, opts) => {
    const poly = computeWandRegion(discImage(rgb), 60, 60, opts);
    expect(poly).not.toBeNull();
    const xs = poly!.xpoints, ys = poly!.ypoints;
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(30);
    expect(Math.max(...xs)).toBeLessThanOrEqual(90);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(30);
    expect(Math.max(...ys)).toBeLessThanOrEqual(90);
  });

  it('the patch mask is size×size and centred on the click', () => {
    const patch = computeWandPatchMask(discImage(false), 60, 60, { patchSize: 21, simpleMode: false })!;
    expect(patch.size).toBe(21);
    expect(patch.mask.length).toBe(21 * 21);
    expect(patch.mask[10 * 21 + 10]).toBe(1);
  });

  it('rejects an even patch size', () => {
    expect(() => computeWandPatchMask(discImage(false), 60, 60, { patchSize: 20 })).toThrow(/odd/);
  });
});
