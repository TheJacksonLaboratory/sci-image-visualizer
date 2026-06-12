import { OsdScaleBar } from './osd-scale-bar';

/**
 * Fake OSD viewer whose image→element mapping is a fixed linear scale, so the
 * bar's screen-px-per-image-px (and therefore the chosen "nice" length) is fully
 * determined by the test. update() also fires from the registered handlers.
 */
function fakeViewer(pxPerImagePx: number, itemCount = 1) {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    canvas: document.createElement('div'),
    world: { getItemCount: () => itemCount },
    viewport: {
      imageToViewerElementCoordinates: (pt: any) => ({ x: pt.x * pxPerImagePx, y: 0 }),
    },
    addHandler: (ev: string, fn: () => void) => { (handlers[ev] ||= []).push(fn); },
    removeHandler: (ev: string, fn: () => void) => { handlers[ev] = (handlers[ev] || []).filter(f => f !== fn); },
    handlers,
  };
}

function barEl(viewer: any): HTMLDivElement { return viewer.canvas.firstChild as HTMLDivElement; }
function label(viewer: any): string { return barEl(viewer).querySelector('span')!.textContent ?? ''; }
function visible(viewer: any): boolean { return barEl(viewer).style.display !== 'none'; }

describe('OsdScaleBar', () => {
  it('renders a bar and a label when the image has a physical pixel size', () => {
    const v = fakeViewer(1);
    new OsdScaleBar(v, 1); // 1 µm/px, 1 screen-px/image-px → ~120px target → nice 100 µm
    expect(visible(v)).toBe(true);
    expect(label(v)).toBe('100 µm');
    // width = round(niceUm / umPerScreenPx) = round(100 / 1)
    expect((barEl(v).children[1] as HTMLElement).style.width).toBe('100px');
  });

  it('hides the bar when mppX is unknown (≤ 0)', () => {
    const v = fakeViewer(1);
    new OsdScaleBar(v, 0);
    expect(visible(v)).toBe(false);
  });

  it('hides the bar when the world has no image', () => {
    const v = fakeViewer(1, /* itemCount */ 0);
    new OsdScaleBar(v, 1);
    expect(visible(v)).toBe(false);
  });

  it('hides the bar when the image→screen scale collapses to zero', () => {
    const v = fakeViewer(0); // imageToViewerElementCoordinates maps both points to x=0
    new OsdScaleBar(v, 1);
    expect(visible(v)).toBe(false);
  });

  // Covers the niceLength 1/2/5/10 tiers and every formatUm unit (nm…m).
  it.each<[number, string]>([
    [1, '100 µm'],          // nice ×1
    [2.0833, '200 µm'],     // nice ×2  (target ~250 → 200)
    [5, '500 µm'],          // nice ×5  (target 600 → 500)
    [7.5, '1 mm'],          // nice ×10 (target 900 → 1000) + mm unit
    [1000, '10 cm'],        // cm unit
    [10000, '1 m'],         // m unit
    [0.0001, '10 nm'],      // nm unit
  ])('picks a nice length + unit for mppX=%p → %p', (mppX, expected) => {
    const v = fakeViewer(1);
    new OsdScaleBar(v, mppX);
    expect(label(v)).toBe(expected);
  });

  it('recomputes on viewport handlers and tears down on destroy', () => {
    const v = fakeViewer(1);
    const sb = new OsdScaleBar(v, 1);
    expect(v.handlers['animation']).toHaveLength(1);

    // Re-firing a handler keeps the bar consistent (no throw, still labelled).
    expect(() => v.handlers['animation'][0]()).not.toThrow();
    expect(label(v)).toBe('100 µm');

    sb.destroy();
    expect(v.handlers['animation']).toHaveLength(0);
    expect(v.canvas.children).toHaveLength(0); // bar removed from the canvas
  });
});
