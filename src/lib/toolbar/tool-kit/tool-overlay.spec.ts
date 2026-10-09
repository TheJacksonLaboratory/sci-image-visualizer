import { ToolOverlayCanvas } from './tool-overlay';

/** A pointer event (jsdom has no PointerEvent constructor). */
interface PointerInit { button?: number; clientX?: number; clientY?: number; pointerId?: number }

function pointer(type: string, init: PointerInit = {}) {
  const e = new MouseEvent(type, { button: init.button ?? 0, clientX: init.clientX, clientY: init.clientY });
  Object.defineProperty(e, 'pointerId', { value: init.pointerId ?? 1 });
  return e;
}

describe('ToolOverlayCanvas (RT-31)', () => {
  let container: HTMLDivElement;
  let overlay: ToolOverlayCanvas;

  beforeEach(() => {
    container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 200 });
    Object.defineProperty(container, 'clientHeight', { value: 100 });
    document.body.appendChild(container);
    overlay = new ToolOverlayCanvas();
  });

  afterEach(() => {
    overlay.detach();
    container.remove();
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
  });

  it('attaches one full-size canvas above the plot and detaches it', () => {
    const canvas = overlay.attach(container, {});
    expect(container.querySelectorAll('canvas')).toHaveLength(1);
    expect(overlay.attach(container, {})).toBe(canvas);
    expect(canvas.style.zIndex).toBe('100');
    overlay.detach();
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('sizes the backing store by devicePixelRatio and reports CSS size', () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    const canvas = overlay.attach(container, {});
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(200);
    expect(overlay.cssWidth).toBe(200);
    expect(overlay.cssHeight).toBe(100);
  });

  it('starts a gesture on the primary button only, and captures the pointer', () => {
    const down = jest.fn();
    const canvas = overlay.attach(container, { down });
    const capture = jest.fn();
    (canvas as unknown as { setPointerCapture: jest.Mock }).setPointerCapture = capture;
    canvas.dispatchEvent(pointer('pointerdown', { button: 2 }));
    expect(down).not.toHaveBeenCalled();
    canvas.dispatchEvent(pointer('pointerdown', { button: 0, pointerId: 7 }));
    expect(down).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(7);
  });

  it('a captured drag does not end when the pointer leaves the canvas', () => {
    const up = jest.fn();
    const canvas = overlay.attach(container, { up });
    (canvas as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () => true;
    (canvas as unknown as { releasePointerCapture: jest.Mock }).releasePointerCapture = jest.fn();
    canvas.dispatchEvent(pointer('pointerleave'));
    expect(up).not.toHaveBeenCalled();
    canvas.dispatchEvent(pointer('pointerup'));
    expect(up).toHaveBeenCalledTimes(1);
  });

  it('removes its listeners on detach', () => {
    const move = jest.fn();
    const canvas = overlay.attach(container, { move });
    overlay.detach();
    canvas.dispatchEvent(pointer('pointermove'));
    expect(move).not.toHaveBeenCalled();
  });
});
