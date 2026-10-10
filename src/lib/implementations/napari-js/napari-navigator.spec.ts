import { Viewer } from 'napari-js';

import {
  NAVIGATOR_SIZE_RATIO,
  NapariNavigator,
  NavigatorCamera,
  navigatorLayout,
  navigatorToWorld,
} from './napari-navigator';

/** A camera that behaves like napari's: setting `center` emits `changed`, zoom untouched. */
function fakeCamera(center: [number, number], zoom: number) {
  const listeners = new Set<() => void>();
  const cam = {
    _center: center,
    zoom,
    get center() {
      return this._center;
    },
    set center(v: readonly [number, number]) {
      this._center = [v[0], v[1]];
      listeners.forEach((l) => l());
    },
    changed: {
      connect: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
  };
  return cam as NavigatorCamera & { _center: [number, number]; zoom: number };
}

function host(w: number, h: number): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: w });
  Object.defineProperty(el, 'clientHeight', { value: h });
  document.body.appendChild(el);
  return el;
}

describe('navigator geometry', () => {
  it('sizes the box like OSD (a fraction of the host width) and keeps the aspect ratio', () => {
    const l = navigatorLayout(1250, 42000, 21000)!;
    expect(l.width).toBeCloseTo(1250 * NAVIGATOR_SIZE_RATIO, 6);
    expect(l.height).toBeCloseTo(l.width / 2, 6);
  });

  it('keeps the box within sensible pixel bounds', () => {
    expect(navigatorLayout(300, 1000, 1000)!.width).toBe(110);
    expect(navigatorLayout(5000, 1000, 1000)!.width).toBe(300);
    expect(navigatorLayout(1000, 0, 10)).toBeNull();
  });

  it('maps a navigator point to the world, clamped to the image', () => {
    const l = { width: 200, height: 100, scale: 0.01 };
    expect(navigatorToWorld(100, 50, l, 20000, 10000)).toEqual([10000, 5000]);
    expect(navigatorToWorld(-5, 500, l, 20000, 10000)).toEqual([0, 10000]);
  });
});

describe('NapariNavigator', () => {
  let nav: NapariNavigator | null = null;
  afterEach(() => {
    nav?.destroy();
    nav = null;
    document.body.innerHTML = '';
  });

  const pointer = (type: string, x: number, y: number) => {
    const e = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    return e;
  };

  it('re-centres the view on a click, at the same zoom', () => {
    const cam = fakeCamera([100, 100], 0.5);
    const h = host(1000, 800);
    nav = new NapariNavigator(h, cam, 2000, 1000);
    const box = h.querySelector('.napari-navigator') as HTMLElement;
    // jsdom has no layout: the box sits at (0, 0), so client coordinates are box coordinates.
    const scale = parseFloat(box.style.width) / 2000;
    box.dispatchEvent(pointer('pointerdown', 1500 * scale, 250 * scale));
    box.dispatchEvent(pointer('pointerup', 1500 * scale, 250 * scale));
    expect(cam.center[0]).toBeCloseTo(1500, 3);
    expect(cam.center[1]).toBeCloseTo(250, 3);
    expect(cam.zoom).toBe(0.5);
  });

  it('pans continuously while dragging, and stops on release', () => {
    const cam = fakeCamera([0, 0], 1);
    const h = host(1000, 800);
    nav = new NapariNavigator(h, cam, 1000, 1000);
    const box = h.querySelector('.napari-navigator') as HTMLElement;
    const scale = parseFloat(box.style.width) / 1000;
    box.dispatchEvent(pointer('pointerdown', 100 * scale, 100 * scale));
    box.dispatchEvent(pointer('pointermove', 600 * scale, 300 * scale));
    expect(cam.center[0]).toBeCloseTo(600, 3);
    box.dispatchEvent(pointer('pointerup', 600 * scale, 300 * scale));
    box.dispatchEvent(pointer('pointermove', 900 * scale, 900 * scale));
    expect(cam.center[0]).toBeCloseTo(600, 3);
  });

  it('keeps its gestures from reaching the canvas underneath', () => {
    const cam = fakeCamera([0, 0], 1);
    const h = host(1000, 800);
    const seen = jest.fn();
    h.addEventListener('pointerdown', seen);
    h.addEventListener('wheel', seen);
    nav = new NapariNavigator(h, cam, 1000, 1000);
    const box = h.querySelector('.napari-navigator') as HTMLElement;
    box.dispatchEvent(pointer('pointerdown', 10, 10));
    box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true }));
    expect(seen).not.toHaveBeenCalled();
  });

  it('does not pass hovers through to the canvas, and reports entering', () => {
    const h = host(1000, 800);
    const moved = jest.fn();
    const entered = jest.fn();
    h.addEventListener('pointermove', moved);
    nav = new NapariNavigator(h, fakeCamera([0, 0], 1), 1000, 1000, entered);
    const box = h.querySelector('.napari-navigator') as HTMLElement;
    box.dispatchEvent(new MouseEvent('pointerenter'));
    box.dispatchEvent(pointer('pointermove', 5, 5));
    expect(entered).toHaveBeenCalled();
    expect(moved).not.toHaveBeenCalled();
  });

  it('moves the viewport rectangle with the camera', () => {
    const cam = fakeCamera([500, 500], 1);
    const h = host(1000, 800);
    nav = new NapariNavigator(h, cam, 4000, 4000);
    const region = h.querySelector('.napari-navigator > div') as HTMLElement;
    const before = parseFloat(region.style.left);
    cam.center = [2500, 2500];
    expect(parseFloat(region.style.left)).toBeGreaterThan(before);
  });

  it('draws the viewport from the host size when given only a camera', () => {
    const h = host(800, 600);
    nav = new NapariNavigator(h, fakeCamera([500, 400], 2), 1000, 1000);
    const region = h.querySelector('.napari-navigator > div') as HTMLElement;
    const scale = parseFloat((h.querySelector('.napari-navigator') as HTMLElement).style.width) / 1000;
    // 800 x 600 px at zoom 2 is 400 x 300 world units around (500, 400).
    expect(parseFloat(region.style.left)).toBeCloseTo(300 * scale, 3);
    expect(parseFloat(region.style.width)).toBeCloseTo(400 * scale, 3);
  });

  it('draws the viewport the viewer reports, sized from its canvas rather than the host', () => {
    // A host holding more than the canvas (here 200 px wider): napari-js's own rect is right.
    const h = host(1000, 600);
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'clientWidth', { value: 800 });
    Object.defineProperty(canvas, 'clientHeight', { value: 600 });
    const viewer = new Viewer({ canvas });
    viewer.camera.set([500, 400], 2);
    nav = new NapariNavigator(h, viewer, 1000, 1000);
    const region = h.querySelector('.napari-navigator > div') as HTMLElement;
    const scale = parseFloat((h.querySelector('.napari-navigator') as HTMLElement).style.width) / 1000;
    expect(parseFloat(region.style.left)).toBeCloseTo(300 * scale, 3);
    expect(parseFloat(region.style.width)).toBeCloseTo(400 * scale, 3);
    viewer.camera.center = [600, 400]; // follows the viewer's camera
    expect(parseFloat(region.style.left)).toBeCloseTo(400 * scale, 3);
  });

  it('releases its listeners on destroy', () => {
    const cam = fakeCamera([100, 100], 1);
    const h = host(1000, 800);
    nav = new NapariNavigator(h, cam, 1000, 1000);
    const box = h.querySelector('.napari-navigator') as HTMLElement;
    nav.destroy();
    nav = null;
    box.dispatchEvent(pointer('pointerdown', 50, 50));
    box.dispatchEvent(pointer('pointerup', 50, 50));
    expect(cam.center).toEqual([100, 100]);
  });

  it('hides and shows', () => {
    const h = host(1000, 800);
    nav = new NapariNavigator(h, fakeCamera([0, 0], 1), 100, 100);
    const box = h.querySelector('.napari-navigator') as HTMLElement;
    nav.setVisible(false);
    expect(box.style.display).toBe('none');
    nav.setVisible(true);
    expect(box.style.display).toBe('block');
  });
});
