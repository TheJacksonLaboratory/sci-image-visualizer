import { NapariVolumeZHandle } from './napari-volume-z-handle';

/** Minimal Camera3D stub: identity view-projection + a no-op `changed` signal. */
const stubCamera = () => ({
  viewProjection: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  changed: { connect: () => () => undefined },
});

/** Dispatch a pointer event carrying a clientY (jsdom PointerEvent lacks the ctor fields we need). */
function pointer(type: string, clientY: number): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { clientY, pointerId: 1 });
  return e;
}

describe('NapariVolumeZHandle', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  it('maps an upward drag to a taller Z (scale > start) and downward to flatter', () => {
    let scale = 1;
    const handle = new NapariVolumeZHandle(host, stubCamera(), {
      topAnchor: () => [0, 0, 1],
      getScale: () => scale,
      setScale: (s) => (scale = s),
      pixelsPerDouble: 100,
    });
    const grip = host.querySelector('div') as HTMLElement;

    // Drag UP 100px (clientY 200 → 100) → one doubling: scale ≈ 2.
    grip.dispatchEvent(pointer('pointerdown', 200));
    grip.dispatchEvent(pointer('pointermove', 100));
    expect(scale).toBeCloseTo(2, 5);
    grip.dispatchEvent(pointer('pointerup', 100));

    // New drag DOWN 100px → one halving from the current scale (2 → 1).
    grip.dispatchEvent(pointer('pointerdown', 100));
    grip.dispatchEvent(pointer('pointermove', 200));
    expect(scale).toBeCloseTo(1, 5);
    grip.dispatchEvent(pointer('pointerup', 200));

    handle.destroy();
  });

  it('clamps the scale to [minScale, maxScale]', () => {
    let scale = 1;
    const handle = new NapariVolumeZHandle(host, stubCamera(), {
      topAnchor: () => [0, 0, 1],
      getScale: () => scale,
      setScale: (s) => (scale = s),
      pixelsPerDouble: 100,
      minScale: 0.5,
      maxScale: 4,
    });
    const grip = host.querySelector('div') as HTMLElement;

    // Drag far up → would exceed maxScale, clamped to 4.
    grip.dispatchEvent(pointer('pointerdown', 1000));
    grip.dispatchEvent(pointer('pointermove', 0));
    expect(scale).toBe(4);
    grip.dispatchEvent(pointer('pointerup', 0));

    handle.destroy();
  });

  it('resets to 1 on double-click', () => {
    let scale = 3;
    const handle = new NapariVolumeZHandle(host, stubCamera(), {
      topAnchor: () => [0, 0, 1],
      getScale: () => scale,
      setScale: (s) => (scale = s),
    });
    (host.querySelector('div') as HTMLElement).dispatchEvent(
      new Event('dblclick', { bubbles: true, cancelable: true }),
    );
    expect(scale).toBe(1);
    handle.destroy();
  });

  it('removes its DOM element on destroy', () => {
    const handle = new NapariVolumeZHandle(host, stubCamera(), {
      topAnchor: () => [0, 0, 1],
      getScale: () => 1,
      setScale: () => undefined,
    });
    expect(host.querySelector('div')).not.toBeNull();
    handle.destroy();
    expect(host.querySelector('div')).toBeNull();
  });
});
