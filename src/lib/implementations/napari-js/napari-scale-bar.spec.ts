import { NapariScaleBar } from './napari-scale-bar';

/**
 * Fake napari Camera whose `zoom` (CSS screen px per image pixel) is fixed by the
 * test, so the bar's chosen "nice" length is fully determined. `changed.connect`
 * records the listener (and returns a disconnect fn) so the tests can re-fire it
 * and assert teardown.
 */
function fakeCamera(zoom: number) {
  const listeners: Array<() => void> = [];
  return {
    zoom,
    changed: {
      connect(fn: () => void) {
        listeners.push(fn);
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    },
    listeners,
  };
}

function host(): HTMLElement {
  return document.createElement('div');
}

function barEl(h: HTMLElement): HTMLDivElement {
  return h.querySelector('div') as HTMLDivElement;
}
function label(h: HTMLElement): string {
  return (barEl(h).querySelector('span') as HTMLSpanElement).textContent ?? '';
}
function visible(h: HTMLElement): boolean {
  return barEl(h).style.display !== 'none';
}
function lineEl(h: HTMLElement): HTMLElement {
  return barEl(h).children[1] as HTMLElement;
}

describe('NapariScaleBar', () => {
  it('renders a bar and a label when the image has a physical pixel size', () => {
    const h = host();
    const cam = fakeCamera(1); // 1 screen-px/image-px
    new NapariScaleBar(h, cam, 1); // 1 µm/px → ~120px target → nice 100 µm
    expect(visible(h)).toBe(true);
    expect(label(h)).toBe('100 µm');
    // width = round(niceUm / umPerScreenPx) = round(100 / 1)
    expect(lineEl(h).style.width).toBe('100px');
  });

  it('hides the bar when mppX is unknown (≤ 0)', () => {
    const h = host();
    new NapariScaleBar(h, fakeCamera(1), 0);
    expect(visible(h)).toBe(false);
  });

  it('hides the bar when the camera zoom collapses to zero', () => {
    const h = host();
    new NapariScaleBar(h, fakeCamera(0), 1);
    expect(visible(h)).toBe(false);
  });

  // Covers the niceLength 1/2/5/10 tiers and every formatUm unit (nm…m).
  it.each<[number, string]>([
    [1, '100 µm'], // nice ×1
    [2.0833, '200 µm'], // nice ×2  (target ~250 → 200)
    [5, '500 µm'], // nice ×5  (target 600 → 500)
    [7.5, '1 mm'], // nice ×10 (target 900 → 1000) + mm unit
    [1000, '10 cm'], // cm unit
    [10000, '1 m'], // m unit
    [0.0001, '10 nm'], // nm unit
  ])('picks a nice length + unit for mppX=%p → %p', (mppX, expected) => {
    const h = host();
    new NapariScaleBar(h, fakeCamera(1), mppX);
    expect(label(h)).toBe(expected);
  });

  it('promotes a statically-positioned host to relative so the bar can anchor', () => {
    const h = host();
    h.style.position = 'static';
    new NapariScaleBar(h, fakeCamera(1), 1);
    expect(h.style.position).toBe('relative');
  });

  it('recomputes on camera change and tears down on destroy', () => {
    const h = host();
    const cam = fakeCamera(1);
    const sb = new NapariScaleBar(h, cam, 1);
    expect(cam.listeners).toHaveLength(1);

    // Re-firing the camera listener keeps the bar consistent (no throw, still labelled).
    expect(() => cam.listeners[0]()).not.toThrow();
    expect(label(h)).toBe('100 µm');

    sb.destroy();
    expect(cam.listeners).toHaveLength(0); // camera disconnect called
    expect(h.children).toHaveLength(0); // bar removed from the host
  });
});
