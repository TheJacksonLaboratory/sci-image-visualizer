import { ToolSliderComponent } from './tool-slider.component';

describe('ToolSliderComponent', () => {
  it('reports the single value, or both values of a range', () => {
    const s = new ToolSliderComponent();
    const out: unknown[] = [];
    s.valueChange.subscribe((v) => out.push(v));
    s['onChange']({ value: 5 });
    s.range = true;
    s['onChange']({ values: [10, 20] });
    expect(out).toEqual([5, [10, 20]]);
  });
});
