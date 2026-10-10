import { PlotTypeSelectorComponent } from './plot-type-selector.component';

describe('PlotTypeSelectorComponent', () => {
  it('isPiIcon distinguishes PrimeNG glyphs from SVG asset paths', () => {
    const c = new PlotTypeSelectorComponent();
    expect(c['isPiIcon']('pi pi-image')).toBe(true);
    expect(c['isPiIcon']('assets/plotting/surface.svg')).toBe(false);
    expect(c['isPiIcon'](undefined)).toBe(false);
  });

  it('reports the iso band as a pair', () => {
    const c = new PlotTypeSelectorComponent();
    const out: unknown[] = [];
    c.isoRangeChange.subscribe((v) => out.push(v));
    c['onIsoRange']([10, 90]);
    c['onIsoRange'](5);
    expect(out).toEqual([[10, 90], undefined]);
  });
});
