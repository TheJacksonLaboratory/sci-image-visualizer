import { NapariAxesLabels, projectPoint, AxisLabelSpec } from './napari-axes-labels';

/** Column-major identity 4×4. */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('projectPoint', () => {
  it('maps the origin to the viewport centre (identity MVP)', () => {
    const s = projectPoint(IDENTITY, [0, 0, 0], 200, 100);
    expect(s.visible).toBe(true);
    expect(s.x).toBeCloseTo(100, 5);
    expect(s.y).toBeCloseTo(50, 5);
  });

  it('maps +x to the right edge', () => {
    const s = projectPoint(IDENTITY, [1, 0, 0], 200, 100);
    expect(s.x).toBeCloseTo(200, 5);
  });

  it('reports points at/behind the camera (w ≤ 0) as not visible', () => {
    const behind = [...IDENTITY];
    behind[15] = -1; // w = -1 for any point
    expect(projectPoint(behind, [0, 0, 0], 200, 100).visible).toBe(false);
  });
});

describe('NapariAxesLabels', () => {
  let host: HTMLElement;
  let connected: Array<() => void>;
  const camera3d = {
    viewProjection: (): number[] => IDENTITY,
    changed: {
      connect: (l: () => void): (() => void) => {
        connected.push(l);
        return () => undefined;
      },
    },
  };
  const labels: AxisLabelSpec[] = [
    { anchor: [0, 0, 0], text: 'X · 512 px', color: '#ed4545' },
    { anchor: [1, 0, 0], text: 'Y · 256 px', color: '#4dd959' },
    { anchor: [0, 1, 0], text: 'Z · 30 px', color: '#668cff' },
  ];

  beforeEach(() => {
    connected = [];
    host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 200, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 100, configurable: true });
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  it('renders one positioned label per spec with its text + colour', () => {
    const overlay = new NapariAxesLabels(host, camera3d, labels);
    const spans = host.querySelectorAll('span');
    expect(spans.length).toBe(3);
    expect(spans[0].textContent).toBe('X · 512 px');
    expect(spans[0].style.color).toBe('rgb(237, 69, 69)'); // #ed4545
    // Origin → viewport centre (100, 50).
    expect(spans[0].style.left).toBe('100px');
    expect(spans[0].style.top).toBe('50px');
    expect(spans[0].style.display).not.toBe('none');
    overlay.destroy();
  });

  it('hides all labels when toggled off and removes them on destroy', () => {
    const overlay = new NapariAxesLabels(host, camera3d, labels);
    overlay.setVisible(false);
    expect(Array.from(host.querySelectorAll('span')).every((s) => s.style.display === 'none')).toBe(
      true,
    );
    overlay.setVisible(true);
    expect(host.querySelectorAll('span')[0].style.display).not.toBe('none');
    overlay.destroy();
    expect(host.querySelectorAll('span').length).toBe(0);
  });

  it('repositions on camera change', () => {
    const overlay = new NapariAxesLabels(host, camera3d, labels);
    expect(connected.length).toBe(1); // subscribed to camera3d.changed
    connected[0](); // simulate an orbit
    expect(host.querySelectorAll('span')[1].style.left).toBe('200px'); // +x anchor → right edge
    overlay.destroy();
  });
});
