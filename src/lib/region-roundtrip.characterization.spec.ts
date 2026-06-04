import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { InjectionToken } from '@angular/core';
import { MessageService } from 'primeng/api';
import * as Plotly from 'plotly.js-dist-min';

import { PlotlyService } from './implementations/plotly/plotly.service';
import { VIZ_PORT_STUBS } from './testing/viz-port-stubs';
import { Region, Rectangle, Polygon } from './models/region';

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
    rect.x = x; rect.y = y; rect.width = w; rect.height = h;
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
      providers: [
        PlotlyService, ...VIZ_PORT_STUBS,
        MessageService,
      ],
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
      false, true, '#ffffff',
    );

    const polys = service.getRegionPolygons();
    // Only the rectangle survives; the open polyline is filtered out.
    expect(polys.length).toBe(1);
    expect(polys[0].xpoints).toEqual([0, 10, 10, 0]);
  });

  it('append mode does not duplicate a region with identical geometry', () => {
    service.setRegions([makeRectRegion(1, 0, 0, 50, 50)], false, true, '#ffffff', false);
    expect(service.getShapes().length).toBe(1);

    // Pressing "find" again hands back the same geometry (different id) — the
    // append path must reject it as a duplicate.
    service.setRegions([makeRectRegion(2, 0, 0, 50, 50)], false, true, '#ffffff', true);
    expect(service.getShapes().length).toBe(1);

    // A genuinely different region does get appended.
    service.setRegions([makeRectRegion(3, 100, 100, 20, 20)], false, true, '#ffffff', true);
    expect(service.getShapes().length).toBe(2);
  });
});
