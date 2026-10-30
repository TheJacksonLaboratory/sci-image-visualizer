import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SpatialGeneStyleComponent } from './spatial-gene-style.component';

describe('SpatialGeneStyleComponent', () => {
  let fixture: ComponentFixture<SpatialGeneStyleComponent>;
  let component: SpatialGeneStyleComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [SpatialGeneStyleComponent] }).compileComponents();
    fixture = TestBed.createComponent(SpatialGeneStyleComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('gene', 'A1CF');
    fixture.componentRef.setInput('what', 'Observation');
    fixture.componentRef.setInput('color', '#aabbcc');
    fixture.componentRef.setInput('glyph', 'star');
    fixture.detectChanges();
  });

  it('titles the icons and colour for what they style, and marks the chosen icon', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Observation Icon');
    expect(el.textContent).toContain('Observation Color');
    expect(el.querySelector('.sc-style-icon.active')?.getAttribute('title')).toBe('star');
  });

  it('reports an icon picked', () => {
    const picked = jest.fn();
    component.glyphChange.subscribe(picked);
    (fixture.nativeElement.querySelector('.sc-style-icon[title="square"]') as HTMLButtonElement).click();
    expect(picked).toHaveBeenCalledWith('square');
  });

  it('reports a typed hex colour, with or without #, and ignores anything else', () => {
    const picked = jest.fn();
    component.colorChange.subscribe(picked);
    component['onHex']('ff8800');
    component['onHex']('#00FF00');
    component['onHex']('red');
    expect(picked.mock.calls.map((c) => c[0])).toEqual(['#ff8800', '#00ff00']);
  });

  it('reports a preset, and a reset', () => {
    const picked = jest.fn();
    const reset = jest.fn();
    component.colorChange.subscribe(picked);
    component.resetStyle.subscribe(reset);
    (fixture.nativeElement.querySelector('.sc-style-preset') as HTMLButtonElement).click();
    expect(picked).toHaveBeenCalledTimes(1);
    component.resetStyle.emit();
    expect(reset).toHaveBeenCalled();
  });
});
