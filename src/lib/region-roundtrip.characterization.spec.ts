import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { InjectionToken } from '@angular/core';
import { MessageService } from 'primeng/api';
import * as Plotly from 'plotly.js-dist-min';

import { saveAs } from 'file-saver';

import { PlotlyService } from './implementations/plotly/plotly.service';
import { VIZ_PORT_STUBS } from './testing/viz-port-stubs';
import { Region, Rectangle, Polygon, MultiPolygon } from './models/region';
import { RegionStore } from './store/region-store.service';
import { VisualizerStore } from './store/visualizer-store.service';
import { PlotUtilities } from './plot.utilities';
import { regionsFromGeoJson, regionsToGeoJson } from './models/region-geojson';

jest.mock('file-saver', () => ({ saveAs: jest.fn() }));

/**
 * CHARACTERIZATION TESTS (Phase 0 of the plotting-backend abstraction).
 *
 * These lock the CURRENT behaviour of the public Region pipeline
 * (`setRegions` -> internal shapes -> `getRegionPolygons`) before the
 * refactor that turns Plotly into one implementation of an `IImageViewer`
 * contract. They intentionally exercise the framework-neutral public API
 * (`Region` in, `Polygon` out) so they should survive the refactor and catch
 * any behavioural drift introduced while extracting the interfaces.
 */
describe('PlotlyService region round-trip (characterization)', () => {
  let service: PlotlyService;

  function makeRectRegion(id: number, x: number, y: number, w: number, h: number): Region {
    const r = new Region();
    r.id = id;
    r.name = `rect${id}`;
    const rect = new Rectangle();
    rect.x = x;
    rect.y = y;
    rect.width = w;
    rect.height = h;
    r.bounds = rect;
    return r;
  }

  function makePolyRegion(id: number, xs: number[], ys: number[], closed: boolean): Region {
    const r = new Region();
    r.id = id;
    r.name = `poly${id}`;
    const poly = new Polygon();
    poly.npoints = xs.length;
    poly.xpoints = xs.slice();
    poly.ypoints = ys.slice();
    poly.coordinates = xs.map((x, i) => [x, ys[i]]);
    poly.closed = closed;
    r.bounds = poly;
    return r;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PlotlyService, ...VIZ_PORT_STUBS, MessageService],
    });
    service = TestBed.inject(PlotlyService);

    (service as any).plotDiv = 'plot';
    document.body.innerHTML = '<div id="plot"></div>';
    // setRegions pushes to Plotly via relayout — stub it so the round-trip is
    // exercised purely through the service's own shape conversion.
    jest.spyOn(Plotly, 'relayout').mockResolvedValue({} as any);
  });

  afterEach(() => jest.restoreAllMocks());

  it('converts a Rectangle region to a 4-point polygon with corner ordering preserved', () => {
    service.setRegions([makeRectRegion(1, 10, 20, 30, 40)], false, true, '#ffffff');

    const polys = service.getRegionPolygons();
    expect(polys.length).toBe(1);
    // getPolygon for a rect uses xpoints=[x0,x1,x1,x0], ypoints=[y1,y1,y0,y0]
    // where x1=x+width (40), y0=y (20), y1=y+height (60).
    expect(polys[0].xpoints).toEqual([10, 40, 40, 10]);
    expect(polys[0].ypoints).toEqual([60, 60, 20, 20]);
  });

  it('round-trips a closed polygon region back to a closed polygon', () => {
    service.setRegions([makePolyRegion(2, [0, 10, 5], [0, 0, 10], true)], false, true, '#ffffff');

    const polys = service.getRegionPolygons();
    expect(polys.length).toBe(1);
    expect(polys[0].closed).toBe(true);
    expect(polys[0].xpoints).toEqual([0, 10, 5]);
    expect(polys[0].ypoints).toEqual([0, 0, 10]);
  });

  it('excludes open polylines (closed === false) from getRegionPolygons', () => {
    service.setRegions(
      [
        makeRectRegion(1, 0, 0, 10, 10),
        makePolyRegion(3, [0, 10, 5], [0, 0, 10], false), // open — annotation only
      ],
      false,
      true,
      '#ffffff',
    );

    const polys = service.getRegionPolygons();
    // Only the rectangle survives; the open polyline is filtered out.
    expect(polys.length).toBe(1);
    expect(polys[0].xpoints).toEqual([0, 10, 10, 0]);
  });

  it('append mode does not duplicate a region with identical geometry', () => {
    service.setRegions([makeRectRegion(1, 0, 0, 50, 50)], false, true, '#ffffff', false);
    expect(service.getRegions().length).toBe(1);

    // Pressing "find" again hands back the same geometry (different id) — the
    // append path must reject it as a duplicate.
    service.setRegions([makeRectRegion(2, 0, 0, 50, 50)], false, true, '#ffffff', true);
    expect(service.getRegions().length).toBe(1);

    // A genuinely different region does get appended.
    service.setRegions([makeRectRegion(3, 100, 100, 20, 20)], false, true, '#ffffff', true);
    expect(service.getRegions().length).toBe(2);
  });
});

/**
 * GeoJSON round trip through the region model (review CORE-25, OSD-PLOTLY-35).
 *
 * GeoJSON I/O lives in `models/region-geojson`; `RegionStore`, `PlotUtilities`
 * and `PlotlyService` must all agree with it, and a store export must keep the
 * file name it is given (Plotly used to name the file, the store ignored it).
 */
describe('Region GeoJSON round trip (characterization)', () => {
  function region(bounds: Region['bounds'], extra: Partial<Region> = {}): Region {
    return Object.assign(new Region(), { name: 'r', label: 'Tumor', color: '#ff8000', bounds }, extra);
  }
  function poly(xs: number[], ys: number[], extra: Partial<Polygon> = {}): Polygon {
    return Object.assign(
      new Polygon(),
      {
        npoints: xs.length,
        xpoints: xs,
        ypoints: ys,
        coordinates: xs.map((x, i) => [x, ys[i]]),
        closed: true,
      },
      extra,
    );
  }
  const rect = Object.assign(new Rectangle(), { x: 10, y: 20, width: 30, height: 40 });
  const donut = poly([0, 20, 20, 0], [0, 0, 20, 20], {
    holes: [
      [
        [7, 7],
        [13, 7],
        [13, 13],
        [7, 13],
      ],
    ],
  });
  const multi = Object.assign(new MultiPolygon(), {
    polygons: [poly([0, 10, 10, 0], [0, 0, 10, 10]), poly([20, 30, 30, 20], [0, 0, 10, 10])],
  });
  const open = poly([0, 10, 20], [0, 5, 0], { closed: false });
  const bezier = poly([0, 10, 5], [0, 0, 10], {
    bezier: true,
    handlesIn: [
      [-1, 0],
      [0, -1],
      [1, 1],
    ],
    handlesOut: [
      [1, 0],
      [0, 1],
      [-1, -1],
    ],
  });

  const fixture = (): Region[] => [
    region(rect),
    region(donut),
    region(multi),
    region(open, { label: 'Line' }),
    region(bezier, { z: 3 }),
    region(rect, { kind: 'profile' }),
  ];

  it('reads back every geometry kind it writes (profile lines are not exported)', () => {
    const back = regionsFromGeoJson(regionsToGeoJson(fixture()));
    expect(back).toHaveLength(5);
    expect(back[0].bounds).toEqual(rect);
    expect((back[1].bounds as Polygon).holes).toEqual(donut.holes);
    expect((back[1].bounds as Polygon).xpoints).toEqual(donut.xpoints);
    expect((back[2].bounds as MultiPolygon).polygons.map((p) => p.xpoints)).toEqual([
      [0, 10, 10, 0],
      [20, 30, 30, 20],
    ]);
    expect((back[3].bounds as Polygon).closed).toBe(false);
    expect((back[3].bounds as Polygon).xpoints).toEqual([0, 10, 20]);
    const b = back[4].bounds as Polygon;
    expect([b.bezier, b.xpoints, b.handlesIn, b.handlesOut]).toEqual([
      true,
      [0, 10, 5],
      bezier.handlesIn,
      bezier.handlesOut,
    ]);
    expect(back[4].z).toBe(3);
    expect(back.map((r) => [r.label, r.color])).toEqual([
      ['Tumor', '#ff8000'],
      ['Tumor', '#ff8000'],
      ['Tumor', '#ff8000'],
      ['Line', '#ff8000'],
      ['Tumor', '#ff8000'],
    ]);
  });

  it('RegionStore, PlotUtilities and PlotlyService produce the same GeoJSON', () => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PlotlyService, ...VIZ_PORT_STUBS, MessageService],
    });
    const plotly = TestBed.inject(PlotlyService);
    const store = new RegionStore(new VisualizerStore());
    const expected = regionsToGeoJson(fixture());
    expect(store.getGeoJsonString(fixture())).toBe(expected);
    expect(new PlotUtilities().exportROIsToGeoJson(fixture())).toBe(expected);
    expect(plotly.getGeoJsonString(fixture())).toBe(expected);
    expect(plotly.importRegions(expected)).toEqual(store.importRegions(expected));
  });

  it('reads every classification form, and a one-ring rectangle only without holes', () => {
    const ring = (pts: number[][]) => [...pts, pts[0]];
    const square = ring([
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ]);
    const hole = ring([
      [1, 1],
      [2, 1],
      [2, 2],
    ]);
    const feature = (properties: unknown, coordinates: number[][][]) => ({
      type: 'Feature',
      properties,
      geometry: { type: 'Polygon', coordinates },
    });
    const back = regionsFromGeoJson(
      JSON.stringify({
        features: [
          feature(undefined, [square]),
          feature({ classification: 'Tumor' }, [square]),
          feature({ classification: { name: 'Stroma' } }, [square, hole]),
          feature({ classification: { name: 'Immune', color: [255, 128, 0] } }, [square]),
        ],
      }),
    );
    expect(back.map((r) => [r.name, r.label, r.color, r.bounds?.constructor.name])).toEqual([
      ['shape0', 'Cell', new Region().color, 'Rectangle'],
      ['shape1', 'Tumor', new Region().color, 'Rectangle'],
      ['shape2', 'Stroma', new Region().color, 'Polygon'],
      ['shape3', 'Immune', '#ff8000', 'Rectangle'],
    ]);
    expect((back[2].bounds as Polygon).holes).toEqual([
      [
        [1, 1],
        [2, 1],
        [2, 2],
      ],
    ]);
  });

  it('writes a bezier donut as its flattened curves, its anchors and handles in properties', () => {
    const donut = poly([0, 10, 5], [0, 0, 10], {
      bezier: true,
      holes: [
        [
          [4, 2],
          [6, 2],
          [5, 4],
        ],
      ],
    });
    const [f] = JSON.parse(regionsToGeoJson([region(donut)])).features;
    expect(f.geometry.type).toBe('Polygon');
    expect(f.geometry.coordinates).toHaveLength(2);
    expect(f.geometry.coordinates.every((r: number[][]) => r.length > 3)).toBe(true);
    expect(f.properties).toEqual({
      classification: { name: 'Tumor', color: [255, 128, 0] },
      isBezier: true,
      bezierAnchors: donut.coordinates,
      holes: donut.holes,
    });
    const back = regionsFromGeoJson(regionsToGeoJson([region(donut)]))[0].bounds as Polygon;
    expect([back.bezier, back.closed, back.xpoints, back.holes]).toEqual([true, true, [0, 10, 5], donut.holes]);
  });

  it('rejects input it cannot read', () => {
    expect(() => regionsFromGeoJson('{')).toThrow('Error parsing json string');
    expect(() => regionsFromGeoJson('{}')).toThrow("must contain the 'features' key");
    expect(() => regionsFromGeoJson(JSON.stringify({ features: [{ geometry: {} }] }))).toThrow(
      "must contain the 'coordinates' key",
    );
  });

  it('RegionStore.exportRegions names the download after the given file', () => {
    const store = new RegionStore(new VisualizerStore());
    const save = saveAs as unknown as jest.Mock;
    save.mockClear();
    store.exportRegions(fixture(), 'slide-01.svs');
    store.exportRegions(fixture());
    expect(save.mock.calls.map((c) => c[1])).toEqual(['slide-01.geojson', 'rois.geojson']);
  });

  it('PlotlyService.exportRegions goes through the store with its file name', () => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [PlotlyService, ...VIZ_PORT_STUBS, MessageService],
    });
    const plotly = TestBed.inject(PlotlyService);
    const store = TestBed.inject(RegionStore);
    const spy = jest.spyOn(store, 'exportRegions').mockImplementation(() => undefined);
    (plotly as unknown as { fileName: string }).fileName = 'stack.tif';
    const regions = fixture();
    plotly.exportRegions(regions);
    expect(spy).toHaveBeenCalledWith(regions, 'stack.tif');
  });
});
