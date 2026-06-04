import { Region, Rectangle, Polygon } from './region';
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
