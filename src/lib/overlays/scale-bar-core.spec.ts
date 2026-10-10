import { createScaleBarElement, formatUm, niceLength, scaleBarFor } from './scale-bar-core';

describe('scale-bar-core', () => {
  it.each<[number, number]>([
    [1.4, 1], // nearest, not "round up": 1.4 → 1
    [1.6, 2],
    [3.4, 2],
    [3.6, 5],
    [7.4, 5],
    [7.6, 10],
    [140, 100],
    [0.016, 0.02],
  ])('snaps %p to the nearest 1/2/5 × 10ⁿ (%p)', (x, nice) => {
    expect(niceLength(x)).toBeCloseTo(nice, 10);
  });

  it('formats µm lengths in the unit that suits them', () => {
    expect(formatUm(0.01)).toBe('10 nm');
    expect(formatUm(2.5)).toBe('2.5 µm');
    expect(formatUm(500)).toBe('500 µm');
    expect(formatUm(2000)).toBe('2 mm');
    expect(formatUm(2e4)).toBe('2 cm');
    expect(formatUm(3e6)).toBe('3 m');
  });

  it('sizes the bar to the nice length nearest the target', () => {
    // 1 µm/px at 1 screen px/image px: 120 µm → 100 µm, drawn 100 px wide.
    expect(scaleBarFor(1, 1)).toEqual({ widthPx: 100, label: '100 µm' });
    // Zoomed in ×4: 30 µm on screen → 20 µm, drawn 80 px wide.
    expect(scaleBarFor(4, 1)).toEqual({ widthPx: 80, label: '20 µm' });
    expect(scaleBarFor(1, 1, 300)).toEqual({ widthPx: 200, label: '200 µm' });
  });

  it('has no bar without a physical pixel size or a usable zoom', () => {
    expect(scaleBarFor(1, 0)).toBeNull();
    expect(scaleBarFor(0, 1)).toBeNull();
    expect(scaleBarFor(NaN, 1)).toBeNull();
  });

  it('renders into its host, hides for null, and removes itself', () => {
    const host = document.createElement('div');
    const el = createScaleBarElement(host);
    const bar = host.firstChild as HTMLDivElement;
    expect(bar.style.display).toBe('none'); // hidden until the first render
    el.render({ widthPx: 42, label: '5 µm' });
    expect(bar.style.display).toBe('');
    expect(bar.querySelector('span')!.textContent).toBe('5 µm');
    expect((bar.children[1] as HTMLElement).style.width).toBe('42px');
    el.render(null);
    expect(bar.style.display).toBe('none');
    el.destroy();
    expect(host.children).toHaveLength(0);
  });
});
