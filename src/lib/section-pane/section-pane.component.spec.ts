import { ComponentFixture, TestBed } from '@angular/core/testing';

import type { SectionView } from '../contracts/section-view.contract';
import { SectionPaneComponent } from './section-pane.component';

const VIEW: SectionView = {
  axis: 'x',
  at: 228.4,
  image: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
  size: [10, 100], // 10 slices across, 100 px down
  scale: [10, 1], // a slice is 10 px deep: the section is square in the volume
  regions: [],
  crosshair: { u: 4.5, v: 50 },
};

describe('SectionPaneComponent', () => {
  let fixture: ComponentFixture<SectionPaneComponent>;
  let canvas: HTMLCanvasElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [SectionPaneComponent] }).compileComponents();
    fixture = TestBed.createComponent(SectionPaneComponent);
    fixture.componentRef.setInput('axis', 'x');
    fixture.componentRef.setInput('view', VIEW);
    fixture.detectChanges();
    canvas = fixture.nativeElement.querySelector('canvas');
    // A 200 × 200 pane: the 100 × 100 world section fits at 1.88 px per unit, centred.
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 }) as DOMRect;
  });

  const at = (type: string, x: number, y: number) =>
    canvas.dispatchEvent(
      Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0 }), { pointerId: 1 }),
    );

  it('names its plane in its axis colour', () => {
    const badge: HTMLElement = fixture.nativeElement.querySelector('.section-badge');
    expect(badge.textContent).toBe('X · 228 px');
    expect(badge.style.background).toBe('rgb(255, 92, 92)');
  });

  it('picks the point clicked in section coordinates, not one dragged or outside the section', () => {
    const picks: Array<{ u: number; v: number }> = [];
    fixture.componentInstance.pick.subscribe((p) => picks.push(p));
    at('pointerdown', 100, 100);
    at('pointerup', 101, 100);
    expect(picks.length).toBe(1);
    expect(picks[0].u).toBeCloseTo(5, 0);
    expect(picks[0].v).toBeCloseTo(50, 0);
    // A drag pans.
    at('pointerdown', 100, 100);
    at('pointermove', 140, 100);
    at('pointerup', 140, 100);
    // Outside the section (the margin).
    at('pointerdown', 2, 2);
    at('pointerup', 2, 2);
    expect(picks.length).toBe(1);
  });
});
