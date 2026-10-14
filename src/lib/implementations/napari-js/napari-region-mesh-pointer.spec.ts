import { RegionMeshPointer } from './napari-region-mesh-pointer';
import type { RegionMesh3D } from './napari-volume-region-meshes';

describe('RegionMeshPointer', () => {
  const hit: RegionMesh3D = {
    key: 'HPF',
    label: 'HPF · Hippocampal formation',
    color: '#7ed04b',
    vertices: new Float32Array(0),
    faces: new Uint32Array(0),
  };
  let canvas: HTMLDivElement;
  let host: HTMLDivElement;
  let picks: Array<[string | null, boolean]>;
  let active: boolean;
  let hoverable: boolean;
  let pointer: RegionMeshPointer;

  const fire = (type: string, x: number, y: number, init: PointerEventInit = {}) => {
    const e = new MouseEvent(type, { clientX: x, clientY: y, button: 0, ...init }) as unknown as PointerEvent;
    canvas.dispatchEvent(e);
  };

  beforeEach(() => {
    jest.useFakeTimers();
    host = document.createElement('div');
    canvas = document.createElement('div');
    host.appendChild(canvas);
    picks = [];
    active = true;
    hoverable = true;
    pointer = new RegionMeshPointer(canvas, host, {
      pickAt: (x) => (x < 100 ? hit : null),
      active: () => active,
      hoverable: () => hoverable,
      onPick: (key, additive) => picks.push([key, additive]),
    });
  });

  afterEach(() => {
    pointer.destroy();
    jest.useRealTimers();
  });

  it('a click picks the surface under it, or none; a drag (an orbit) picks nothing', () => {
    fire('pointerdown', 10, 10);
    fire('pointerup', 12, 11, { shiftKey: true });
    fire('pointerdown', 150, 10);
    fire('pointerup', 150, 10);
    fire('pointerdown', 10, 10);
    fire('pointerup', 60, 10);
    expect(picks).toEqual([
      ['HPF', true],
      [null, false],
    ]);
  });

  it('only while active (the selection tool armed, surfaces shown)', () => {
    active = false;
    fire('pointerdown', 10, 10);
    fire('pointerup', 10, 10);
    expect(picks).toEqual([]);
  });

  it('names the surface the pointer rests on', () => {
    const tip = host.querySelector('.napari-region-mesh-tip') as HTMLElement;
    fire('pointermove', 10, 10);
    jest.runAllTimers();
    expect(tip.style.display).toBe('block');
    expect(tip.textContent).toBe('HPF · Hippocampal formation');
    expect(canvas.style.cursor).toBe('pointer');
    fire('pointermove', 150, 10);
    jest.runAllTimers();
    expect(tip.style.display).toBe('none');

    // Without the selection tool the name still shows, but no pointer cursor (a click does nothing).
    active = false;
    fire('pointermove', 10, 10);
    jest.runAllTimers();
    expect(tip.style.display).toBe('block');
    expect(canvas.style.cursor).toBe('');

    hoverable = false;
    fire('pointermove', 10, 10);
    jest.runAllTimers();
    expect(tip.style.display).toBe('none');
  });
});
