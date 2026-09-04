import { NapariSpatialTooltip } from './napari-spatial-tooltip';

describe('NapariSpatialTooltip', () => {
  let host: HTMLElement;
  let tip: NapariSpatialTooltip;

  /** jsdom lays nothing out, so the sizes the flip logic reads are stubbed. */
  const size = (el: HTMLElement, w: number, h: number) => {
    Object.defineProperty(el, 'offsetWidth', { value: w, configurable: true });
    Object.defineProperty(el, 'offsetHeight', { value: h, configurable: true });
  };

  beforeEach(() => {
    host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 400, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 300, configurable: true });
    document.body.appendChild(host);
    tip = new NapariSpatialTooltip(host);
  });

  afterEach(() => {
    tip.dispose();
    host.remove();
  });

  const box = () => host.querySelector('div') as HTMLElement;

  it('gives the host a containing block, since the box is absolutely positioned', () => {
    expect(host.style.position).toBe('relative');
  });

  it('never eats pointer events', () => {
    // The canvas underneath has to keep receiving them, or the tooltip would stop
    // the orbit the moment it appeared.
    expect(box().style.pointerEvents).toBe('none');
  });

  it('starts hidden and shows the class over the column it came from', () => {
    expect(tip.visible).toBe(false);
    size(box(), 100, 34);
    tip.show(['18 TH Glut', 'class'], 50, 60);

    expect(tip.visible).toBe(true);
    expect(box().textContent).toContain('18 TH Glut');
    expect(box().textContent).toContain('class');
    expect(box().style.left).toBe('64px'); // 50 + 14 gap
    expect(box().style.top).toBe('74px');
  });

  it('flips near an edge rather than being clipped', () => {
    size(box(), 120, 40);
    // 380 + 14 + 120 runs past the 400px host, so it goes to the left instead.
    tip.show(['a', 'b'], 380, 280);
    expect(box().style.left).toBe('246px'); // 380 - 14 - 120
    expect(box().style.top).toBe('226px'); // 280 - 14 - 40
  });

  it('does not push itself off the near edge when it cannot fit either way', () => {
    size(box(), 600, 500); // wider and taller than the host
    tip.show(['a'], 10, 10);
    expect(box().style.left).toBe('0px');
    expect(box().style.top).toBe('0px');
  });

  it('drops the second line when there is only one', () => {
    size(box(), 60, 20);
    tip.show(['just this'], 10, 10);
    expect(box().textContent).toBe('just this');
  });

  it('hides on an empty line list, and on hide()', () => {
    size(box(), 60, 20);
    tip.show(['x'], 10, 10);
    tip.show([], 10, 10);
    expect(tip.visible).toBe(false);
    tip.show(['x'], 10, 10);
    tip.hide();
    expect(tip.visible).toBe(false);
  });

  it('removes itself from the host on dispose', () => {
    expect(host.children.length).toBe(1);
    tip.dispose();
    expect(host.children.length).toBe(0);
  });
});
