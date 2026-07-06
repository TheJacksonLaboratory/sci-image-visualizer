import { Polygon, Rectangle, Region, MultiPolygon } from './models/region';
import { PlotUtilities } from './plot.utilities';
import { ShapeSelection } from './models/shape';

describe('PlotUtilities', () => {

  let plotUtilities: PlotUtilities;

  beforeEach(() => {
    plotUtilities = new PlotUtilities();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('Test roundPathCoordinates', ()=> {
    const path = 'M13.54,54.566L35.44,33.3L36.22,89.6Z';
    const resultRoundPath = plotUtilities.roundPathCoordinates(path);
    expect(resultRoundPath).toBe('M14,55L35,33L36,90Z');
  });

  it('Test arrayToMatrix', () => {
    const inputUint8Array = new Uint8Array([ 5, 6, 9, 7, 7, 7, 3, 2, 1, 1, 0, 0, 1, 5, 4, 6 ]);
    const outputMatrix = plotUtilities.arrayToMatrix(inputUint8Array, 4);
    expect(outputMatrix).toEqual([[5, 6, 9, 7 ], [7, 7, 3, 2], [1, 1, 0, 0], [1, 5, 4, 6]]);
  });

  it('Test get Rectangle Inside', () => {
    // true image dimensions
    const trueImageSize = [0, 300, 0, 500];
    // region coordinates
    const coordinatesInside = [10, 200, 300, 30];
    const result = plotUtilities.getRectangle(coordinatesInside, trueImageSize);
    expect(result.x).toBe(10);
    expect(result.y).toBe(30);
    expect(result.width).toBe(190);
    expect(result.height).toBe(270);
  });

  it('Test get Rectangle Out right', () => {
    // true image dimensions
    const trueImageSize = [0, 300, 0, 500];
    // region coordinates
    const coordinatesOutRight = [10, 310, 300, 30];
    const result = plotUtilities.getRectangle(coordinatesOutRight, trueImageSize);
    expect(result.x).toBe(10);
    expect(result.y).toBe(30);
    expect(result.width).toBe(290);
    expect(result.height).toBe(270);
  });

  it('Test get Rectangle Out top', () => {
    // true image dimensions
    const trueImageSize = [0, 300, 0, 500];
    // region coordinates
    const coordinatesOutTop = [10, 200, 300, -30];
    const result = plotUtilities.getRectangle(coordinatesOutTop, trueImageSize);
    expect(result.x).toBe(10);
    expect(result.y).toBe(0);
    expect(result.width).toBe(190);
    expect(result.height).toBe(300);
  });

  it('Test get Rectangle Out left', () => {
    // true image dimensions
    const trueImageSize = [0, 300, 0, 500];
    // region coordinates
    const coordinatesOutLeft = [-10, 200, 300, 30];
    const result = plotUtilities.getRectangle(coordinatesOutLeft, trueImageSize);
    expect(result.x).toBe(0);
    expect(result.y).toBe(30);
    expect(result.width).toBe(200);
    expect(result.height).toBe(270);
  });

  it('Test get Rectangle Out bottom', () => {
    // true image dimensions
    const trueImageSize = [0, 300, 0, 500];
    // region coordinates
    const coordinatesOutBottom = [10, 200, 600, 30];
    const result = plotUtilities.getRectangle(coordinatesOutBottom, trueImageSize);
    expect(result.x).toBe(10);
    expect(result.y).toBe(30);
    expect(result.width).toBe(190);
    expect(result.height).toBe(470);
  });

  it('Test get Rectangle Completely out left', () => {
    // true image dimensions
    const trueImageSize = [0, 300, 0, 500];
    // region coordinates
    const coordinatesOutCompleteLeft = [0, -50, 250, 40];
    const result = plotUtilities.getRectangle(coordinatesOutCompleteLeft, trueImageSize);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
    expect(result.width).toBe(300);
    expect(result.height).toBe(500);
  });

  it('Test arrayToMatrix', () => {
    const array = [ 0, 10, 0, 15, 20, 16, 9, 5, 17 ];
    const matrix = plotUtilities.arrayToMatrix(array, 3);
    expect(matrix).toStrictEqual([[0, 10, 0], [15, 20, 16], [9, 5, 17]]);
  });

  it('Test Zoom same as Image size', () => {
    // true image dimensions
    const trueImageSize = [0, 300, 0, 500];
    // region coordinates as a Rectangle
    const region = new Rectangle();
    region.x = 0;
    region.y = 0;
    region.width = 300;
    region.height = 500;
    const result = plotUtilities.isZoomSameAsImgSize(region, trueImageSize);
    expect(result).toBe(true);
  });

  it('Test rounding of rectangular selection',  () => {
    const rectangleSelection = new ShapeSelection();
    rectangleSelection.x0 = 23.55;
    rectangleSelection.x1 = 67.5055;
    rectangleSelection.y0 = 54.221;
    rectangleSelection.y1 = 77.32566;
    const roundedRectangle = plotUtilities.snapRegion(rectangleSelection);
    expect(roundedRectangle.x0).toBe(24);
    expect(roundedRectangle.x1).toBe(68);
    expect(roundedRectangle.y0).toBe(54);
    expect(roundedRectangle.y1).toBe(77);
  });

  it('Test rounding of polygon selection',  () => {
    const polygonSelection = new ShapeSelection();
    polygonSelection.path = 'M45.6663,87.1224L677.1099,590.0567L12.789,98.0004Z';
    const roundedPolygon = plotUtilities.snapRegion(polygonSelection);
    expect(roundedPolygon.path).toBe('M46,87L677,590L13,98Z');
  });

  it('Test rounding of list', () => {
    const list = [3.4, 4.5, 6.123, 5];
    expect(plotUtilities.round(list)).toEqual([3, 5, 6, 5]);
  });

  it('Test getPolygon', ()=> {
    // test shape
    const shape = { type: 'path', path: 'M45.6663,87.1224L677.1099,590.0567L12.789,98.0004Z' };
    const resultPoly1 = plotUtilities.getPolygon(shape);
    const expectedPoly1 = new Polygon();
    expectedPoly1.npoints = 3;
    expectedPoly1.xpoints = [ 46, 677, 13 ];
    expectedPoly1.ypoints = [ 87, 590, 98 ];
    expect(resultPoly1).toEqual(expectedPoly1);
    // test rectangle
    const rectangle = { type: 'rect', x0: 10.15, x1: 15, y0: 20, y1: 25.7 };
    const resultPoly2 = plotUtilities.getPolygon(rectangle);
    const expectedPoly2 = new Polygon();
    expectedPoly2.npoints = 4;
    expectedPoly2.xpoints = [ 10, 15, 15, 10 ];
    expectedPoly2.ypoints = [ 26, 26, 20, 20 ];
    expect(resultPoly2).toEqual(expectedPoly2);
  });

  it('Test importROIsFromGeoJson', () => {
    const geoJson = '{ "type": "FeatureCollection", "features": [ { "type": "Feature", "id": "188c53c6-acfc-4088-8099-1831971e3632", "geometry": { "type": "Polygon", "coordinates": [[[ 403, 1123 ], [ 455, 1123 ], [ 455, 1162 ], [ 403, 1162 ], [ 403, 1123 ]]]}, "properties": { "objectType": "annotation", "classification": { "name": "Two-cell-embryo", "color": [ 0, 0, 255 ]}}}, { "type": "Feature", "id": "a829812c-a03b-4a92-937f-88d9e12ad6a0", "geometry": { "type": "Polygon", "coordinates": [[[ 352, 334 ], [ 352, 336 ], [ 350, 338 ], [ 349, 338 ], [ 343, 344 ], [ 340, 344 ], [ 340, 357 ], [ 343, 357 ], [ 352, 334 ]]]}, "properties": { "objectType": "annotation", "classification": { "name": "Two-cell-embryo", "color": [ 0, 0, 255 ] }}}]}';
    const result = plotUtilities.importROIsFromGeoJson(geoJson);
    const region1 = new Region();
    region1.label = 'Two-cell-embryo';
    region1.name = 'shape0'
    region1.bounds = new Rectangle();
    region1.bounds.x = 403;
    region1.bounds.y = 1123;
    region1.bounds.width = 52;
    region1.bounds.height = 39;
    region1.color = '#0000ff';
    const region2 = new Region();
    region2.label = 'Two-cell-embryo';
    region2.name = 'shape1'
    region2.bounds = new Polygon();
    region2.bounds.npoints = 8;
    region2.bounds.xpoints = [ 352, 352, 350, 349, 343, 340, 340, 343 ];
    region2.bounds.ypoints = [ 334, 336, 338, 338, 344, 344, 357, 357 ];
    region2.bounds.coordinates = [[ 352, 334 ], [ 352, 336 ], [ 350, 338 ], [ 349, 338 ],
      [ 343, 344 ], [ 340, 344 ], [ 340, 357 ], [ 343, 357 ]];
    region2.color = '#0000ff';
    expect(result).toEqual([region1, region2]);
  });

  it('Test exportROIsToGeoJson', () => {
    const regions: Region[] = [];
    const region1 = new Region();
    region1.name = 'region1';
    region1.bounds = new Rectangle();
    region1.color = 'red';
    regions.push(region1);
    const region2 = new Region();
    region2.name = 'region2';
    region2.bounds = new Polygon();
    region2.color = 'blue';
    regions.push(region2);

    const result = plotUtilities.exportROIsToGeoJson(regions);
    const expected = '{"features":[{"type":"Feature","properties":{"classification":{"name":"region1","color":[0,0,237]}},"geometry":{"type":"Polygon","coordinates":[[[0,0],[0,0],[0,0],[0,0],[0,0]]]}},{"type":"Feature","properties":{"classification":{"name":"region2","color":[0,0,0]}},"geometry":{"type":"Polygon","coordinates":[[null]]}}],"type":"FeatureCollection"}';
    expect(result).toEqual(expected);
  });

  it('test hexToRgb', () => {
    const hexColor = '#ff0000';
    const result = plotUtilities.hexToRgb(hexColor);
    expect(result).toEqual([255, 0, 0]);
    const hexColor2 = '#00FFFF';
    const result2 = plotUtilities.hexToRgb(hexColor2);
    expect(result2).toEqual([0, 255, 255]);
  });

  it('Test importROIsFromGeoJson with polyline (LineString)', () => {
    const geoJson = '{"features":[{"type":"Feature","properties":{"classification":{"name":"legend","color":[0,255,255]}},"geometry":{"type":"LineString","coordinates":[[4067,4802],[4105,5150],[4260,5421],[4512,6388],[4724,6582],[4995,6717],[5691,6737],[6233,6640],[6562,6543],[6620,6427],[6562,6253],[5421,4725],[5363,4628]]}}],"type":"FeatureCollection"}';
    const result = plotUtilities.importROIsFromGeoJson(geoJson);
    expect(result.length).toBe(1);
    const region = result[0];
    expect(region.name).toBe('shape0');
    expect(region.label).toBe('legend');
    expect(region.color).toBe('#00ffff');
    expect(region.bounds instanceof Polygon).toBe(true);
    const poly = region.bounds as Polygon;
    expect(poly.closed).toBe(false);
    expect(poly.npoints).toBe(13);
    expect(poly.xpoints).toEqual([4067, 4105, 4260, 4512, 4724, 4995, 5691, 6233, 6562, 6620, 6562, 5421, 5363]);
    expect(poly.ypoints).toEqual([4802, 5150, 5421, 6388, 6582, 6717, 6737, 6640, 6543, 6427, 6253, 4725, 4628]);
    expect(poly.coordinates).toEqual([
      [4067, 4802], [4105, 5150], [4260, 5421], [4512, 6388], [4724, 6582],
      [4995, 6717], [5691, 6737], [6233, 6640], [6562, 6543], [6620, 6427],
      [6562, 6253], [5421, 4725], [5363, 4628]
    ]);
  });

  it('Test exportROIsToGeoJson with polyline (LineString)', () => {
    const region = new Region();
    region.name = 'shape0';
    region.label = 'legend';
    region.color = '#00ffff';
    const poly = new Polygon();
    poly.closed = false;
    poly.npoints = 13;
    poly.xpoints = [4067, 4105, 4260, 4512, 4724, 4995, 5691, 6233, 6562, 6620, 6562, 5421, 5363];
    poly.ypoints = [4802, 5150, 5421, 6388, 6582, 6717, 6737, 6640, 6543, 6427, 6253, 4725, 4628];
    poly.coordinates = [
      [4067, 4802], [4105, 5150], [4260, 5421], [4512, 6388], [4724, 6582],
      [4995, 6717], [5691, 6737], [6233, 6640], [6562, 6543], [6620, 6427],
      [6562, 6253], [5421, 4725], [5363, 4628]
    ];
    region.bounds = poly;

    const result = plotUtilities.exportROIsToGeoJson([region]);
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe('FeatureCollection');
    expect(parsed.features.length).toBe(1);
    const feature = parsed.features[0];
    expect(feature.type).toBe('Feature');
    expect(feature.geometry.type).toBe('LineString');
    expect(feature.properties.classification.name).toBe('legend');
    expect(feature.properties.classification.color).toEqual([0, 255, 255]);
    expect(feature.geometry.coordinates).toEqual([
      [4067, 4802], [4105, 5150], [4260, 5421], [4512, 6388], [4724, 6582],
      [4995, 6717], [5691, 6737], [6233, 6640], [6562, 6543], [6620, 6427],
      [6562, 6253], [5421, 4725], [5363, 4628]
    ]);
  });

  it('bezier region: exports a flattened curve + anchors, and round-trips', () => {
    const region = new Region();
    region.name = 'shape0';
    region.label = 'legend';
    region.color = '#00ffff';
    const poly = new Polygon();
    poly.closed = true;
    poly.bezier = true;
    poly.npoints = 4;
    poly.xpoints = [0, 30, 30, 0];
    poly.ypoints = [0, 0, 30, 30];
    poly.coordinates = [[0, 0], [30, 0], [30, 30], [0, 30]];
    region.bounds = poly;

    const json = plotUtilities.exportROIsToGeoJson([region]);
    const feature = JSON.parse(json).features[0];

    // Geometry is the flattened smooth curve (QuPath renders it) — denser than
    // the 4 anchors — and the editable anchors + flag ride in properties.
    expect(feature.geometry.type).toBe('Polygon');
    expect(feature.geometry.coordinates[0].length).toBeGreaterThan(5);
    expect(feature.properties.isBezier).toBe(true);
    expect(feature.properties.bezierAnchors).toEqual([[0, 0], [30, 0], [30, 30], [0, 30]]);

    // Re-import reconstructs the editable bezier region from the anchors.
    const back = plotUtilities.importROIsFromGeoJson(json)[0];
    const b = back.bounds as Polygon;
    expect(b).toBeInstanceOf(Polygon);
    expect(b.bezier).toBe(true);
    expect(b.closed).toBe(true);
    expect(b.xpoints).toEqual([0, 30, 30, 0]);
    expect(b.ypoints).toEqual([0, 0, 30, 30]);
  });

  it('bezier region round-trips edited control handles through properties', () => {
    const region = new Region();
    region.name = 'shape0';
    region.label = 'legend';
    region.color = '#00ffff';
    const poly = new Polygon();
    poly.closed = true;
    poly.bezier = true;
    poly.npoints = 4;
    poly.xpoints = [0, 30, 30, 0];
    poly.ypoints = [0, 0, 30, 30];
    poly.coordinates = [[0, 0], [30, 0], [30, 30], [0, 30]];
    // A hand-edited (non-default) handle on vertex 0.
    poly.handlesIn = [[-5, -2], [0, 0], [0, 0], [0, 0]];
    poly.handlesOut = [[8, 3], [0, 0], [0, 0], [0, 0]];
    region.bounds = poly;

    const json = plotUtilities.exportROIsToGeoJson([region]);
    const feature = JSON.parse(json).features[0];
    expect(feature.properties.bezierHandlesIn[0]).toEqual([-5, -2]);
    expect(feature.properties.bezierHandlesOut[0]).toEqual([8, 3]);

    const back = plotUtilities.importROIsFromGeoJson(json)[0].bounds as Polygon;
    expect(back.bezier).toBe(true);
    expect(back.handlesIn![0]).toEqual([-5, -2]);
    expect(back.handlesOut![0]).toEqual([8, 3]);
  });

  it('polygon with a hole round-trips through GeoJSON (extra ring) — jit-ui#85', () => {
    const region = new Region();
    region.name = 'shape0';
    region.label = 'legend';
    region.color = '#00ffff';
    const poly = new Polygon();
    poly.closed = true;
    poly.npoints = 4;
    poly.xpoints = [0, 30, 30, 0];
    poly.ypoints = [0, 0, 30, 30];
    poly.coordinates = [[0, 0], [30, 0], [30, 30], [0, 30]];
    poly.holes = [[[10, 10], [20, 10], [20, 20], [10, 20]]];
    region.bounds = poly;

    const json = plotUtilities.exportROIsToGeoJson([region]);
    const feature = JSON.parse(json).features[0];
    // GeoJSON Polygon: exterior ring + one interior (hole) ring.
    expect(feature.geometry.type).toBe('Polygon');
    expect(feature.geometry.coordinates.length).toBe(2);
    expect(feature.geometry.coordinates[1][0]).toEqual([10, 10]); // hole closed ring

    const back = plotUtilities.importROIsFromGeoJson(json)[0].bounds as Polygon;
    expect(back).toBeInstanceOf(Polygon);
    expect(back.holes?.length).toBe(1);
    expect(back.holes![0]).toEqual([[10, 10], [20, 10], [20, 20], [10, 20]]);
  });

  it('a square with a hole is not collapsed to a rectangle on import — jit-ui#85', () => {
    // Exterior is a 5-point closed square (the rectangle-detection shape), but
    // the extra hole ring must keep it a Polygon.
    const geoJson = JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { classification: { name: 'legend', color: [0, 255, 255] } },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]],
            [[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]],
          ],
        },
      }],
    });
    const back = plotUtilities.importROIsFromGeoJson(geoJson)[0].bounds as Polygon;
    expect(back).toBeInstanceOf(Polygon);
    expect(back.holes?.length).toBe(1);
  });

  it('MultiPolygon round-trips through GeoJSON (jit-ui#85)', () => {
    const part = (x0: number, holes?: number[][][]) => {
      const p = new Polygon();
      p.xpoints = [x0, x0 + 10, x0 + 10, x0];
      p.ypoints = [0, 0, 10, 10];
      p.npoints = 4;
      p.coordinates = p.xpoints.map((x, i) => [x, p.ypoints[i]]);
      p.closed = true;
      if (holes) p.holes = holes;
      return p;
    };
    const region = new Region();
    region.label = 'legend';
    region.color = '#00ffff';
    const mp = new MultiPolygon();
    mp.polygons = [part(0, [[[2, 2], [5, 2], [5, 5], [2, 5]]]), part(20)];
    region.bounds = mp;

    const json = plotUtilities.exportROIsToGeoJson([region]);
    const feature = JSON.parse(json).features[0];
    expect(feature.geometry.type).toBe('MultiPolygon');
    expect(feature.geometry.coordinates.length).toBe(2);          // two parts
    expect(feature.geometry.coordinates[0].length).toBe(2);       // part A: exterior + hole

    const back = plotUtilities.importROIsFromGeoJson(json)[0].bounds as MultiPolygon;
    expect(back).toBeInstanceOf(MultiPolygon);
    expect(back.polygons.length).toBe(2);
    expect(back.polygons[0].xpoints).toEqual([0, 10, 10, 0]);
    expect(back.polygons[0].holes?.length).toBe(1);
    expect(back.polygons[1].xpoints).toEqual([20, 30, 30, 20]);
  });

  /**
   * QuPath z-stack plane interop (jit-ui#93). QuPath stores the image plane
   * inside the geometry (sibling of type/coordinates) as {c,z,t}, zero-based,
   * omitted for the default plane (z=0,t=0). These pin that read/write contract.
   */
  describe('QuPath geometry.plane z-index', () => {
    it('imports geometry.plane.z into region.z, defaulting to 0 when absent', () => {
      const geoJson = JSON.stringify({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { classification: { name: 'A', color: [1, 2, 3] } },
            geometry: { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]],
              plane: { c: -1, z: 3, t: 0 } } },
          { type: 'Feature', properties: { classification: { name: 'B', color: [1, 2, 3] } },
            geometry: { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]] } },
        ],
      });
      const regions = plotUtilities.importROIsFromGeoJson(geoJson);
      expect(regions[0].z).toBe(3);       // from geometry.plane.z
      expect(regions[1].z).toBe(0);       // no plane key → default slice 0
    });

    it('exports geometry.plane only for a non-default slice (QuPath omit-default)', () => {
      const onSlice2 = new Region();
      onSlice2.name = 'r2'; onSlice2.color = '#ff0000'; onSlice2.z = 2;
      onSlice2.bounds = Object.assign(new Rectangle(), { x: 0, y: 0, width: 4, height: 4 });
      const onSlice0 = new Region();
      onSlice0.name = 'r0'; onSlice0.color = '#ff0000'; // z defaults to 0
      onSlice0.bounds = Object.assign(new Rectangle(), { x: 0, y: 0, width: 4, height: 4 });

      const parsed = JSON.parse(plotUtilities.exportROIsToGeoJson([onSlice2, onSlice0]));
      // Non-default slice → plane written with QuPath's {c:-1,z,t:0} shape.
      expect(parsed.features[0].geometry.plane).toEqual({ c: -1, z: 2, t: 0 });
      // Default slice (z=0) → plane key omitted entirely.
      expect(parsed.features[1].geometry.plane).toBeUndefined();
    });

    it('round-trips the slice index through export → import', () => {
      const region = new Region();
      region.name = 'r'; region.color = '#00ff00'; region.label = 'Tumour'; region.z = 5;
      region.bounds = Object.assign(new Rectangle(), { x: 1, y: 1, width: 2, height: 2 });
      const back = plotUtilities.importROIsFromGeoJson(plotUtilities.exportROIsToGeoJson([region]));
      expect(back[0].z).toBe(5);
    });
  });

  it('test rgbToHex', () => {
    const result = plotUtilities.rgbToHex(255, 0, 0);
    expect(result).toBe('#ff0000');
    const result2 = plotUtilities.rgbToHex(0, 255, 255);
    expect(result2).toBe('#00ffff');
  });

  it('test Region getShape', () => {
    // Test for Rectangle bounds
    const region = new Region();
    region.name = 'region1';
    region.label = 'label1';
    region.color = '#ff0000';
    region.bounds = new Rectangle();
    region.bounds.x = 10;
    region.bounds.y = 20;
    region.bounds.width = 30;
    region.bounds.height = 40;

    const shape: ShapeSelection = region.getShape(true);
    expect(shape.name).toBe('region1');
    expect(shape.type).toBe('rect');
    expect(shape.x0).toBe(10);
    expect(shape.y0).toBe(20);
    expect(shape.x1).toBe(40);
    expect(shape.y1).toBe(60);

    // Test for Polygon bounds
    const region2 = new Region();
    region2.name = 'region1';
    region2.label = 'label1';
    region2.color = '#ff0000';
    region2.bounds = new Polygon();
    region2.bounds.npoints = 4;
    region2.bounds.xpoints = [10, 40, 40, 10];
    region2.bounds.ypoints = [20, 20, 60, 60];
    region2.bounds.coordinates = [[10, 20], [40, 20], [40, 60], [10, 60]];
    const shape2: ShapeSelection = region2.getShape(true);
    expect(shape2.name).toBe('region1');
    expect(shape2.type).toBe('path');
    expect(shape2.path).toBe('M10,20L40,20L40,60L10,60Z');

  })

  it('test Shape getRegion', () => {
    // Test for Rectangle bounds
    const shape = new ShapeSelection();
    shape.name = 'shape1';
    shape.fillcolor = '#ff0000';
    shape.type = 'rect';
    shape.x0 = 10;
    shape.y0 = 20;
    shape.x1 = 40;
    shape.y1 = 60;

    const region: Region = shape.getRegion();
    expect(region.name).toBe('shape1');
    expect(region.color).toBe('#ff0000');
    expect(region.bounds instanceof Rectangle).toBe(true);
    expect((<Rectangle>region.bounds).x).toBe(10);
    expect((<Rectangle>region.bounds).y).toBe(20);
    expect((<Rectangle>region.bounds).width).toBe(30);
    expect((<Rectangle>region.bounds).height).toBe(40);

    // Test for Polygon bounds
    const shape2 = new ShapeSelection();
    shape2.name = 'shape2';
    shape2.fillcolor = '#00ff00';
    shape2.type = 'path';
    shape2.path = 'M10,20L40,20L40,60L10,60Z';

    const region2: Region = shape2.getRegion();
    expect(region2.name).toBe('shape2');
    expect(region2.color).toBe('#00ff00');
    expect(region2.bounds instanceof Polygon).toBe(true);
    expect((<Polygon>region2.bounds).npoints).toBe(4);
    expect((<Polygon>region2.bounds).xpoints).toEqual([10, 40, 40, 10]);
    expect((<Polygon>region2.bounds).ypoints).toEqual([20, 20, 60, 60]);
    expect((<Polygon>region2.bounds).coordinates).toEqual([[10, 20], [40, 20], [40, 60], [10, 60]]);
  })
});
