import { MultiPolygon, Rectangle, Region } from '../models/region';
import { makePolygon } from '../models/polygon-factory';
import { IImageMetadata } from '../contracts/image.contract';
import { formatArea, formatVolume, pickMpp, regionAreaPx, withSliceScale } from './region-metrics';

const region = (bounds: Region['bounds']) => Object.assign(new Region(), { bounds });
const square = (x0: number, w: number) => makePolygon([x0, x0 + w, x0 + w, x0], [0, 0, w, w]);

describe('region-metrics', () => {
  it('pickMpp reads calibration off a non-[0] entry and squares a single axis', () => {
    const pick = (m: unknown) => pickMpp(m as IImageMetadata[]);
    expect(
      pick([
        { mppX: 0, mppY: 0 },
        { mppX: 0.5, mppY: 0.5 },
      ]),
    ).toEqual({ mppX: 0.5, mppY: 0.5 });
    expect(pick([{ mppX: 0.25 }])).toEqual({ mppX: 0.25, mppY: 0.25 });
    expect(pick([{ mppX: 0, mppY: 0 }])).toEqual({ mppX: undefined, mppY: undefined });
    expect(pick(undefined)).toEqual({ mppX: undefined, mppY: undefined });
  });

  it('regionAreaPx: rectangle, polygon minus holes, multi-polygon sum, else 0', () => {
    expect(regionAreaPx(region(Object.assign(new Rectangle(), { width: -30, height: 40 })))).toBe(1200);
    const donut = square(0, 10);
    donut.holes = [
      [
        [3, 3],
        [7, 3],
        [7, 7],
        [3, 7],
      ],
    ];
    expect(regionAreaPx(region(donut))).toBe(84);
    expect(
      regionAreaPx(region(Object.assign(new MultiPolygon(), { polygons: [square(0, 10), square(20, 5)] }))),
    ).toBe(125);
    expect(regionAreaPx(region(makePolygon([0, 1], [0, 1])))).toBe(0);
    expect(regionAreaPx(region(undefined as unknown as Region['bounds']))).toBe(0);
  });

  it("withSliceScale: a region set's planes give the slice spacing, and the pixel size the image lacks", () => {
    // The image's pixel size, the planes' spacing in its units.
    expect(withSliceScale({ mppX: 0.5, mppY: 0.5 }, { spacing: 4, micronsPerUnit: null })).toEqual({
      mppX: 0.5,
      mppY: 0.5,
      mppZ: 2,
    });
    // The set's µm per unit, for an image without a pixel size.
    expect(withSliceScale({}, { spacing: 3, micronsPerUnit: 0.25 })).toEqual({
      mppX: 0.25,
      mppY: 0.25,
      mppZ: 0.75,
    });
    // The planes, not what an image of one plane says of its own z.
    expect(withSliceScale({ mppX: 1, mppY: 1, mppZ: 9 }, { spacing: 2, micronsPerUnit: 1 })).toEqual({
      mppX: 1,
      mppY: 1,
      mppZ: 2,
    });
    // No unit at all: still voxels.
    expect(formatVolume(10, withSliceScale({}, { spacing: 2, micronsPerUnit: null }))).toBe('10 voxels');
    // No planes: the image's own.
    const own = { mppX: 1, mppY: 1, mppZ: 3 };
    expect(withSliceScale(own, null)).toBe(own);
  });

  it('formatVolume: voxels without a slice spacing, µm³ / mm³ with it, blank when empty', () => {
    expect(formatVolume(0)).toBe('');
    expect(formatVolume(1500, { mppX: 1, mppY: 1 })).toBe('1,500 voxels');
    expect(formatVolume(8, { mppX: 2, mppY: 2, mppZ: 2 })).toBe('64 µm³');
    expect(formatVolume(1e6, { mppX: 10, mppY: 10, mppZ: 10 })).toBe('1 mm³');
    expect(formatVolume(4321, { mppX: 25, mppY: 25, mppZ: 25 })).toBe('0.0675 mm³');
    expect(formatVolume(999, { mppX: 1, mppY: 1, mppZ: 1 })).toBe('999 µm³');
    expect(pickMpp([{ mppX: 25, mppY: 25, mppZ: 50 }] as unknown as IImageMetadata[]).mppZ).toBe(50);
  });

  it('formatArea: px² without calibration, µm² / mm² with it, blank when degenerate', () => {
    expect(formatArea(0)).toBe('');
    expect(formatArea(1200)).toBe(`${(1200).toLocaleString()} px²`);
    expect(formatArea(12.345)).toBe('12.35 px²');
    expect(formatArea(1200, { mppX: 2, mppY: 2 })).toBe(`${(4800).toLocaleString()} µm²`);
    expect(formatArea(4e6, { mppX: 1, mppY: 1 })).toBe('4 mm²');
    expect(formatArea(100, { mppX: 2 })).toBe('100 px²');
  });
});
