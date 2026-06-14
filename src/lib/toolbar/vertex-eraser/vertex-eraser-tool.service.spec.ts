import { VertexEraserToolService } from './vertex-eraser-tool.service';
import { WandService } from '../wand/wand.service';
import { Region, Polygon } from '../../models/region';
import { ICoordinateTransform } from '../../contracts/coordinate-transform.contract';

/**
 * The eraser is decoupled from any backend's shape format: it reads/writes the
 * neutral Region model through its host. These tests mock the host with an
 * identity coordinate transform (client px == image coords) and verify the tool
 * produces Region objects, not Plotly dicts.
 */
function squareRegion(): Region {
  const r = new Region();
  r.id = 1;
  const p = new Polygon();
  p.npoints = 4;
  p.xpoints = [0, 10, 10, 0];
  p.ypoints = [0, 0, 10, 10];
  p.coordinates = [[0, 0], [10, 0], [10, 10], [0, 10]];
  p.closed = true;
  r.bounds = p;
  return r;
}

const identityTransform: ICoordinateTransform = {
  clientToData: (x, y) => ({ x, y }),
  dataLengthToScreen: (l) => l,
  isReady: () => true,
};

describe('VertexEraserToolService (neutral Region)', () => {
  let tool: VertexEraserToolService;
  let regions: Region[];
  let committed: Region[] | null;
  let container: HTMLDivElement;
  let invalidated: number;

  beforeEach(() => {
    tool = new VertexEraserToolService(new WandService());
    regions = [squareRegion()];
    committed = null;
    invalidated = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    tool.bindHost({
      getOverlayContainer: () => container,
      getCoordinateTransform: () => identityTransform,
      getRegions: () => regions.slice(),
      setRegions: (rs) => { committed = rs; },
      invalidateWandRegion: () => { invalidated++; },
      getCachedImageRatio: () => 1,
    });
    tool.setMode(true);
    tool.setRadius(2);
  });

  afterEach(() => {
    tool.setMode(false);
    container.remove();
  });

  it('removes the clicked vertex and commits neutral Region objects', () => {
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 0, button: 0 }));

    expect(committed).not.toBeNull();
    expect(committed!.length).toBe(1);
    const bounds = committed![0].bounds;
    expect(bounds).toBeInstanceOf(Polygon); // neutral model, not a Plotly dict
    expect((bounds as Polygon).xpoints.length).toBe(3); // the (10,0) vertex was dropped
    expect(committed![0].id).toBe(1); // identity preserved
    expect(invalidated).toBe(1); // wand stroke invalidated after the edit
  });

  it('does not commit when the click misses every vertex', () => {
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 5, clientY: 5, button: 0 }));
    expect(committed).toBeNull();
  });

  it('ignores non-left mouse buttons', () => {
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 0, button: 2 }));
    expect(committed).toBeNull();
  });

  it('erases while dragging (mousedown then mousemove with the button held)', () => {
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 5, clientY: 5, button: 0 })); // miss
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 0, buttons: 1 })); // hits (10,0)
    expect(committed).not.toBeNull();
    expect((committed![0].bounds as Polygon).xpoints.length).toBe(3);
  });

  it('a bare hover (no button) just redraws the cursor and commits nothing', () => {
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    expect(() => canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 0, buttons: 0 })))
      .not.toThrow();
    expect(committed).toBeNull();
  });

  it('removes a region outright once it drops below three vertices', () => {
    tool.setRadius(50); // large enough to catch every corner of the 10×10 square
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 5, clientY: 5, button: 0 }));
    expect(committed).not.toBeNull();
    expect(committed!.length).toBe(0); // degenerate → region removed
  });

  it('setRadius ignores non-positive / non-finite values', () => {
    tool.setRadius(0);
    tool.setRadius(NaN);
    tool.setRadius(-3);
    // Still erases a single nearby vertex with the prior valid radius (2).
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 0, button: 0 }));
    expect((committed![0].bounds as Polygon).xpoints.length).toBe(3);
  });
});
