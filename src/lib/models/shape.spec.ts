import { ShapeSelection } from './shape';
import { Region, Rectangle, Polygon } from './region';

describe('ShapeSelection', () => {
  let shape: ShapeSelection;

  beforeEach(() => {
    shape = new ShapeSelection();
    shape.name = 'TestShape';
    shape.fillcolor = '#123456';
    shape.editable = true;
  });

  it('should create a Region from a rectangle shape', () => {
    shape.type = 'rect';
    shape.x0 = 10;
    shape.y0 = 20;
    shape.x1 = 30;
    shape.y1 = 40;

    const region = shape.getRegion();
    expect(region).toBeInstanceOf(Region);
    expect(region.name).toBe('TestShape');
    expect(region.color).toBe('#123456');
    expect(region.bounds).toBeInstanceOf(Rectangle);
    if (region.bounds && region.bounds instanceof Rectangle) {
      expect(region.bounds.x).toBe(10);
      expect(region.bounds.y).toBe(20);
      expect(region.bounds.width).toBe(20);
      expect(region.bounds.height).toBe(20);
    }
  });

  it('should create a Region from a polygon shape', () => {
    shape.type = 'path';
    shape.path = 'M1,2L3,4L5,6Z';

    const region = shape.getRegion();
    expect(region).toBeInstanceOf(Region);
    expect(region.bounds).toBeInstanceOf(Polygon);
    if (region.bounds && region.bounds instanceof Polygon) {
      expect(region.bounds.npoints).toBe(3);
      expect(region.bounds.xpoints).toEqual([1, 3, 5]);
      expect(region.bounds.ypoints).toEqual([2, 4, 6]);
      expect(region.bounds.coordinates).toEqual([[1,2],[3,4],[5,6]]);
      expect(region.bounds.closed).toBe(true);
    }
  });

  it('should create a Region with closed=false from an open path shape', () => {
    shape.type = 'path';
    shape.path = 'M1,2L3,4L5,6';

    const region = shape.getRegion();
    expect(region.bounds).toBeInstanceOf(Polygon);
    if (region.bounds && region.bounds instanceof Polygon) {
      expect(region.bounds.npoints).toBe(3);
      expect(region.bounds.xpoints).toEqual([1, 3, 5]);
      expect(region.bounds.ypoints).toEqual([2, 4, 6]);
      expect(region.bounds.closed).toBe(false);
    }
  });

  it('should throw an error for unsupported shape type', () => {
    shape.type = 'circle' as any;
    expect(() => shape.getRegion()).toThrowError('Unsupported shape type: circle');
  });
});
