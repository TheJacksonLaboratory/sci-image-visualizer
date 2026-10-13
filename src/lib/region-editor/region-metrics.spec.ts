import { MultiPolygon, Rectangle, Region } from '../models/region';
import { makePolygon } from '../models/polygon-factory';
import { IImageMetadata } from '../contracts/image.contract';
import { formatArea, pickMpp, regionAreaPx } from './region-metrics';

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

  it('formatArea: px² without calibration, µm² / mm² with it, blank when degenerate', () => {
    expect(formatArea(0)).toBe('');
    expect(formatArea(1200)).toBe(`${(1200).toLocaleString()} px²`);
    expect(formatArea(12.345)).toBe('12.35 px²');
    expect(formatArea(1200, { mppX: 2, mppY: 2 })).toBe(`${(4800).toLocaleString()} µm²`);
    expect(formatArea(4e6, { mppX: 1, mppY: 1 })).toBe('4 mm²');
    expect(formatArea(100, { mppX: 2 })).toBe('100 px²');
  });
});
