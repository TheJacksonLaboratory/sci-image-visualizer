import { MultiPolygon, Polygon, Rectangle, Region } from '../models/region';
import { DEFAULT_HIGHLIGHT, DEFAULT_REGION_STYLE, labelFits, regionLabelSpots, shapePaint } from './region-style';

const square = (x: number, y: number, s: number): Polygon =>
  Object.assign(new Polygon(), { xpoints: [x, x + s, x + s, x], ypoints: [y, y, y + s, y + s], npoints: 4 });

describe('region-style', () => {
  it('outlines by default, filling only the selection', () => {
    expect(shapePaint('#f00', false)).toEqual({ fill: 'none', fillOpacity: 0, stroke: '#f00', strokeWidth: 2 });
    expect(shapePaint('#f00', true).fillOpacity).toBe(0.35);
  });

  it('fills in the filled look, the selection in the highlight', () => {
    const style = { ...DEFAULT_REGION_STYLE, fillOpacity: 0.7, stroke: '#333' };
    expect(shapePaint('#f00', false, style)).toEqual({
      fill: '#f00',
      fillOpacity: 0.7,
      stroke: '#333',
      strokeWidth: 1,
    });
    const sel = shapePaint('#f00', true, style);
    expect(sel.fill).toBe(DEFAULT_HIGHLIGHT);
    expect(sel.fillOpacity).toBe(0.85);
    expect(sel.strokeWidth).toBe(2);
  });

  it('labels a rectangle at its centre and each part of a multipolygon at its pole', () => {
    const rect = Object.assign(new Region(), {
      bounds: Object.assign(new Rectangle(), { x: 0, y: 0, width: 10, height: 4 }),
    });
    expect(regionLabelSpots(rect)).toEqual([{ x: 5, y: 2, room: 2 }]);
    const multi = Object.assign(new Region(), {
      bounds: Object.assign(new MultiPolygon(), { polygons: [square(0, 0, 10), square(100, 0, 20)] }),
    });
    const spots = regionLabelSpots(multi);
    expect(spots).toHaveLength(2);
    expect(spots[1].x).toBeCloseTo(110, 0);
    expect(spots[1].room).toBeCloseTo(10, 0);
  });

  it('shows a label only while it fits on screen', () => {
    const spot = { x: 0, y: 0, room: 10 };
    expect(labelFits((x, y) => [x, y], spot, 8)).toBe(true);
    expect(labelFits((x, y) => [x * 0.1, y * 0.1], spot, 8)).toBe(false);
  });
});
