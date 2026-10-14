import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ClassTreeComponent, ClassTreePick } from './class-tree.component';

describe('ClassTreeComponent', () => {
  let fixture: ComponentFixture<ClassTreeComponent>;
  let picks: ClassTreePick[];

  const rows = () => Array.from(fixture.nativeElement.querySelectorAll('.tree-row')) as HTMLElement[];
  const names = () => rows().map((r) => r.querySelector('.tree-name')!.textContent!.trim());

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ClassTreeComponent] }).compileComponents();
    fixture = TestBed.createComponent(ClassTreeComponent);
    picks = [];
    fixture.componentInstance.pick.subscribe((p) => picks.push(p));
    fixture.componentRef.setInput('nodes', [
      { name: 'grey', title: 'Basic cell groups' },
      { name: 'CTX', title: 'Cerebral cortex', parent: 'grey' },
      { name: 'MO', title: 'Somatomotor areas', parent: 'CTX' },
      { name: 'AUD', title: 'Auditory areas', parent: 'CTX' },
    ]);
    fixture.componentRef.setInput('counts', new Map([['MO', 2]]));
    fixture.detectChanges();
  });

  it('opens with the roots expanded and greys classes with no region', () => {
    expect(names()).toEqual(['grey', 'CTX']);
    expect(rows()[0].classList).not.toContain('absent');
    (rows()[1].querySelector('.tree-toggle') as HTMLElement).click();
    fixture.detectChanges();
    expect(names()).toEqual(['grey', 'CTX', 'MO', 'AUD']);
    expect(rows()[3].classList).toContain('absent');
    expect(rows()[1].querySelector('.tree-count')!.textContent!.trim()).toBe('2');
  });

  it('picks a class with its subtree', () => {
    rows()[1].click();
    expect(picks[0]).toEqual({
      name: 'CTX',
      classes: expect.arrayContaining(['CTX', 'MO', 'AUD']),
      additive: false,
    });
    expect(picks[0].classes).toHaveLength(3);
  });

  it('searches names and long names, and Enter picks the first match', () => {
    const input = fixture.nativeElement.querySelector('.tree-search') as HTMLInputElement;
    input.value = 'auditory';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(names()).toEqual(['grey', 'CTX', 'AUD']);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(picks.map((p) => p.name)).toEqual(['AUD']);
  });

  it('shows the picked class and opens its path', () => {
    fixture.componentRef.setInput('picked', 'AUD');
    fixture.detectChanges();
    expect(names()).toContain('AUD');
    expect(fixture.nativeElement.querySelector('.tree-picked').textContent).toContain('Auditory areas');
  });
});
