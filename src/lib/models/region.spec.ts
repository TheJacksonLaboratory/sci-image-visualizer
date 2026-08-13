import { Region, Rectangle, Polygon, MultiPolygon, hydrateBounds } from './region';
import { ShapeSelection } from './shape';

describe('Region', () => {
  let region: Region;

  beforeEach(() => {
    region = new Region();
    region.name = 'TestRegion';
    region.color = '#00FF00';
    region.label = 'Label';
    region.filename = 'file.png';
  });

  it('should return correct string for Rectangle bounds', () => {
    region.bounds = new Rectangle();
    region.bounds.x = 1;
    region.bounds.y = 2;
    region.bounds.width = 3;
    region.bounds.height = 4;
    expect(region.toString()).toContain('x: 1');
    expect(region.toString()).toContain('width: 3');
  });

  it('should return correct path string for Polygon bounds', () => {
    const poly = new Polygon();
    poly.npoints = 2;
    poly.xpoints = [1, 2];
    poly.ypoints = [3, 4];
    region.bounds = poly;
    expect(region.toString()).toBe('M1,3L2,4Z');
  });

  it('should return correct path string for open Polygon bounds (no Z)', () => {
    const poly = new Polygon();
    poly.npoints = 2;
    poly.xpoints = [1, 2];
    poly.ypoints = [3, 4];
    poly.closed = false;
    region.bounds = poly;
    expect(region.toString()).toBe('M1,3L2,4');
  });

  it('should return empty string for undefined bounds', () => {
    region.bounds = null;
    expect(region.toString()).toBe('');
  });

  it('should create a ShapeSelection with correct properties (Rectangle)', () => {
    region.bounds = new Rectangle();
    region.bounds.x = 1;
    region.bounds.y = 2;
    region.bounds.width = 3;
    region.bounds.height = 4;
    const shape = region.getShape(true);
    expect(shape.name).toBe('TestRegion');
    expect(shape.editable).toBe(true);
    expect(shape.line?.color).toBe('#00FF00');
    expect(shape.type).toBe('rect');
    expect(shape.x0).toBe(1);
    expect(shape.y1).toBe(6);
    expect(shape.label?.text).toBe('Label');
  });

  it('should create a ShapeSelection with correct properties (Polygon)', () => {
    const poly = new Polygon();
    poly.npoints = 2;
    poly.xpoints = [1, 2];
    poly.ypoints = [3, 4];
    region.bounds = poly;
    const shape = region.getShape(false);
    expect(shape.type).toBe('path');
    expect(shape.path).toBe('M1,3L2,4Z');
    expect(shape.label).toEqual({});
  });

  it('should create a ShapeSelection with open path for open Polygon (no Z)', () => {
    const poly = new Polygon();
    poly.npoints = 2;
    poly.xpoints = [1, 2];
    poly.ypoints = [3, 4];
    poly.closed = false;
    region.bounds = poly;
    const shape = region.getShape(false);
    expect(shape.type).toBe('path');
    expect(shape.path).toBe('M1,3L2,4');
  });

  it('should identify Rectangle correctly', () => {
    const rect = new Rectangle();
    expect(region.isRectangle(rect)).toBe(true);
    expect(region.isPolygon(rect)).toBe(false);
  });

  it('should identify Polygon correctly', () => {
    const poly = new Polygon();
    expect(region.isPolygon(poly)).toBe(true);
    expect(region.isRectangle(poly)).toBe(false);
  });
});

// jit-ui#124: JSON bounds have the right fields but the wrong prototype, which
// the duck-typing renderers accept and the `instanceof` ones silently ignore.
describe('hydrateBounds', () => {
  it('rebuilds a JSON rectangle as a Rectangle instance', () => {
    const bounds = hydrateBounds({ x: 10, y: 20, width: 30, height: 40 }) as Rectangle;

    expect(bounds).toBeInstanceOf(Rectangle);
    expect(bounds).toEqual(expect.objectContaining({ x: 10, y: 20, width: 30, height: 40 }));
  });

  it('rebuilds a JSON polygon, deriving the fields a lean serializer omits', () => {
    // JIT's Java PolygonSerializer emits npoints/xpoints/ypoints and nothing else.
    const bounds = hydrateBounds({ npoints: 3, xpoints: [0, 4, 4], ypoints: [0, 0, 6] }) as Polygon;

    expect(bounds).toBeInstanceOf(Polygon);
    expect(bounds.npoints).toBe(3);
    expect(bounds.coordinates).toEqual([[0, 0], [4, 0], [4, 6]]);
    expect(bounds.closed).toBe(true);
  });

  it('infers npoints when only the point arrays are present', () => {
    const bounds = hydrateBounds({ xpoints: [1, 2], ypoints: [3, 4] }) as Polygon;

    expect(bounds.npoints).toBe(2);
  });

  it('preserves an explicitly open polyline', () => {
    const bounds = hydrateBounds({ xpoints: [1, 2], ypoints: [3, 4], closed: false }) as Polygon;

    expect(bounds.closed).toBe(false);
  });

  it('copies the point arrays rather than aliasing the caller’s', () => {
    const raw = { npoints: 2, xpoints: [1, 2], ypoints: [3, 4] };
    const bounds = hydrateBounds(raw) as Polygon;

    raw.xpoints.push(99);

    expect(bounds.xpoints).toEqual([1, 2]);
  });

  it('rebuilds a JSON multi-polygon, hydrating every part', () => {
    const bounds = hydrateBounds({
      polygons: [
        { npoints: 3, xpoints: [0, 1, 1], ypoints: [0, 0, 1] },
        { npoints: 3, xpoints: [5, 6, 6], ypoints: [5, 5, 6] },
      ],
    }) as MultiPolygon;

    expect(bounds).toBeInstanceOf(MultiPolygon);
    expect(bounds.polygons).toHaveLength(2);
    expect(bounds.polygons[0]).toBeInstanceOf(Polygon);
    expect(bounds.polygons[1]).toBeInstanceOf(Polygon);
  });

  it('returns instances by reference, so live edits keep their target', () => {
    // Overlays and tools mutate the bounds they created during a drag, so
    // rebuilding an already-good instance would strand those references.
    const rect = Object.assign(new Rectangle(), { x: 1, y: 2, width: 3, height: 4 });
    const poly = new Polygon();
    const multi = new MultiPolygon();

    expect(hydrateBounds(rect)).toBe(rect);
    expect(hydrateBounds(poly)).toBe(poly);
    expect(hydrateBounds(multi)).toBe(multi);
  });

  it('passes null and undefined through', () => {
    expect(hydrateBounds(null)).toBeNull();
    expect(hydrateBounds(undefined)).toBeUndefined();
  });

  it('hands back an unrecognisable shape rather than coercing it', () => {
    const odd = { radius: 5 };

    expect(hydrateBounds(odd)).toBe(odd);
  });
});
