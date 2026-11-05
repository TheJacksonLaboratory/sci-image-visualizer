import { SpatialHover, type SpatialHoverHost } from './napari-spatial-hover';
import type { SpatialDataset } from '../../contracts/spatial-dataset.contract';

describe('SpatialHover', () => {
  let el: HTMLElement;
  let pick: jest.Mock;
  let hover: SpatialHover;
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    frames = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    el = document.createElement('div');
    document.body.appendChild(el);
    pick = jest.fn(() => -1);
    const host = {
      is3d: true,
      viewer: {} as SpatialHoverHost['viewer'],
      port: null,
      selection: null,
      dataset: () => ({ observations: {} }) as unknown as SpatialDataset,
      pick,
      tiles: () => null,
      toolActive: () => false,
      outsideZone: <T>(fn: () => T) => fn(),
      inZone: <T>(fn: () => T) => fn(),
    } satisfies SpatialHoverHost;
    hover = new SpatialHover(host);
    hover.install(el);
  });

  afterEach(() => {
    hover.dispose();
    el.remove();
    jest.restoreAllMocks();
  });

  const move = (buttons: number) => {
    const e = new MouseEvent('pointermove', { clientX: 10, clientY: 20, buttons, bubbles: true });
    el.dispatchEvent(e);
    frames.splice(0).forEach((cb) => cb(0));
  };

  it('hit-tests a hover once per frame', () => {
    move(0);
    expect(pick).toHaveBeenCalledTimes(1);
    expect(pick).toHaveBeenCalledWith(10, 20, expect.any(Number));
  });

  it('does not hit-test while a button is held: an orbit or a pan moves the camera every frame', () => {
    for (let i = 0; i < 5; i++) move(1);
    expect(pick).not.toHaveBeenCalled();
    // The first move after the drag hit-tests again.
    move(0);
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it('drops a hover pending when a drag starts', () => {
    const e = new MouseEvent('pointermove', { clientX: 10, clientY: 20, buttons: 0, bubbles: true });
    el.dispatchEvent(e);
    el.dispatchEvent(new MouseEvent('pointermove', { clientX: 12, clientY: 20, buttons: 1, bubbles: true }));
    frames.splice(0).forEach((cb) => cb(0));
    expect(pick).not.toHaveBeenCalled();
  });

  it('a click on an individual cell selects that cell, and again clears it', () => {
    hover.dispose();
    let current: any = { count: 0, mask: new Uint8Array(3) };
    const selection = {
      current: () => current,
      set: jest.fn((m) => (current = m)),
      clear: jest.fn(() => (current = { count: 0, mask: new Uint8Array(3) })),
    };
    const pickCell = jest.fn(() => 2);
    const host = {
      is3d: true,
      viewer: {} as SpatialHoverHost['viewer'],
      port: null,
      selection: selection as unknown as SpatialHoverHost['selection'],
      dataset: () => ({ observations: { count: 3 } }) as unknown as SpatialDataset,
      pick: jest.fn(() => -1),
      pickCell,
      tiles: () => null,
      toolActive: () => false,
      outsideZone: <T>(fn: () => T) => fn(),
      inZone: <T>(fn: () => T) => fn(),
    } satisfies SpatialHoverHost;
    hover = new SpatialHover(host);
    hover.install(el);
    const click = () => {
      el.dispatchEvent(new MouseEvent('pointerdown', { clientX: 5, clientY: 5, bubbles: true }));
      el.dispatchEvent(new MouseEvent('pointerup', { clientX: 5, clientY: 5, bubbles: true }));
    };
    click();
    expect(selection.set).toHaveBeenCalledTimes(1);
    expect(Array.from(current.mask)).toEqual([0, 0, 1]);
    click();
    expect(selection.clear).toHaveBeenCalledTimes(1);
  });
});
