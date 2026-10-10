import { Directive, Input, forwardRef } from '@angular/core';
import { ComponentFixture } from '@angular/core/testing';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { BehaviorSubject, Subscription, isObservable } from 'rxjs';

import type { ISpatialControls } from '../contracts/visualizer.contract';
import type { SpatialDataset } from '../contracts/spatial-dataset.contract';
import { DEFAULT_SPATIAL_VIEW, SpatialViewState } from '../contracts/display-types';
import { SpatialSelectionMask, emptySelection } from '../spatial/spatial-selection';

/**
 * Test-only stand-in for the PrimeNG form controls of the spatial-omics panels.
 *
 * The panel specs render under `NO_ERRORS_SCHEMA` rather than importing PrimeNG, so a
 * `p-dropdown [ngModel]` is an unknown element and `NgModel` finds no value accessor
 * (NG01203). This directive is that accessor: it records what the template wrote into the
 * control ({@link value}) and lets a spec play the user ({@link pick}), which emits the
 * element's `(ngModelChange)` exactly as the real control would. Everything else a
 * PrimeNG control emits (`onChange`, `onClick`, `onFilter`, …) is a plain DOM event under
 * the schema, which {@link fire} dispatches.
 */
@Directive({
  // eslint-disable-next-line @angular-eslint/directive-selector
  selector: 'p-checkbox[ngModel],p-dropdown[ngModel],p-selectButton[ngModel],p-slider[ngModel],'
    + 'p-inputNumber[ngModel],p-multiSelect[ngModel],p-treeSelect[ngModel]',
  providers: [{
    provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => StubValueAccessorDirective), multi: true,
  }],
})
export class StubValueAccessorDirective implements ControlValueAccessor {
  /** Claimed here so the binding does not reach the DOM property of the same name, which
   *  jsdom makes read-only. */
  @Input() scrollHeight: unknown;
  /** What the template last bound into the control. */
  value: unknown;
  private onChange: (value: unknown) => void = () => undefined;

  writeValue(value: unknown): void {
    this.value = value;
  }

  registerOnChange(fn: (value: unknown) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(): void {
    // Not observed by the panels.
  }

  /** The user picks `value`: the control reports it, as PrimeNG's would. */
  pick(value: unknown): void {
    this.value = value;
    this.onChange(value);
  }
}

/** The one element matching `selector` under `root`; throws (naming it) when there is none. */
export function one(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`no element matches ${selector}`);
  return el;
}

/** The collapsible `.sc-panel` whose title is `title`. */
export function panelNamed(root: ParentNode, title: string): HTMLElement {
  const panel = Array.from(root.querySelectorAll<HTMLElement>('.sc-panel'))
    .find((p) => p.querySelector('.sc-panel-title')?.textContent?.trim() === title);
  if (!panel) throw new Error(`no panel titled ${title}`);
  return panel;
}

/** The `.sc-row` whose `.sc-lbl` reads `label` (the first, when several do). */
export function rowLabelled(root: ParentNode, label: string): HTMLElement {
  const row = Array.from(root.querySelectorAll<HTMLElement>('.sc-row'))
    .find((r) => r.querySelector('.sc-lbl')?.textContent?.trim() === label);
  if (!row) throw new Error(`no row labelled ${label}`);
  return row;
}

/** The control element directly after the `.sc-lbl` reading `label`, for unrowed labels. */
export function afterLabel(root: ParentNode, label: string, selector: string): HTMLElement {
  const lbl = Array.from(root.querySelectorAll<HTMLElement>('.sc-lbl'))
    .find((l) => l.textContent?.trim() === label);
  let el = lbl?.nextElementSibling ?? null;
  // Lower-cased: jsdom matches element names case-sensitively, and `p-selectButton` is
  // created as `p-selectbutton`.
  while (el && !el.matches(selector.toLowerCase())) el = el.nextElementSibling;
  if (!el) throw new Error(`no ${selector} after label ${label}`);
  return el as HTMLElement;
}

/** The stub accessor on `el`, to read what was bound into it or to {@link StubValueAccessorDirective.pick}. */
export function accessorOf<T>(fixture: ComponentFixture<T>, el: Element): StubValueAccessorDirective {
  const de = fixture.debugElement.query((d) => d.nativeElement === el)
    ?? fixture.debugElement.queryAll(By.directive(StubValueAccessorDirective)).find((d) => d.nativeElement === el);
  if (!de) throw new Error('element is not under the fixture');
  return de.injector.get(StubValueAccessorDirective);
}

/** Dispatch a PrimeNG-style output: a DOM event carrying `detail`'s fields as properties. */
export function fire(el: Element, name: string, detail: Record<string, unknown> = {}): void {
  el.dispatchEvent(Object.assign(new Event(name), detail));
}

/** Click a native element. */
export function click(el: Element): void {
  (el as HTMLElement).click();
}

/**
 * Feed a child panel its inputs the way the dialog does: a plain value is set once, an
 * observable's every emission is set and rendered. Returns the subscription to end it.
 */
export function bindInputs<T>(
  fixture: ComponentFixture<T>, inputs: Record<string, unknown>, render = true,
): Subscription {
  const subs = new Subscription();
  for (const [name, value] of Object.entries(inputs)) {
    if (isObservable(value)) {
      subs.add(value.subscribe((v) => {
        fixture.componentRef.setInput(name, v);
        if (render) fixture.detectChanges();
      }));
    } else {
      fixture.componentRef.setInput(name, value);
    }
  }
  if (render) fixture.detectChanges();
  return subs;
}

/** A fake `ISpatialControls` whose writes land in its own subjects, like the real store. */
export interface SpatialControlsFake {
  controls: jest.Mocked<ISpatialControls>;
  dataset$: BehaviorSubject<SpatialDataset | null>;
  view$: BehaviorSubject<SpatialViewState>;
  selection$: BehaviorSubject<SpatialSelectionMask>;
}

/** {@link SpatialControlsFake} over `dataset`, with the default view and no selection. */
export function fakeSpatialControls(dataset: SpatialDataset | null): SpatialControlsFake {
  const dataset$ = new BehaviorSubject<SpatialDataset | null>(dataset);
  const view$ = new BehaviorSubject<SpatialViewState>({ ...DEFAULT_SPATIAL_VIEW });
  const selection$ = new BehaviorSubject<SpatialSelectionMask>(emptySelection());
  const controls = {
    getDataset$: jest.fn(() => dataset$),
    getViewState$: jest.fn(() => view$),
    viewState: jest.fn(() => view$.value),
    setViewState: jest.fn((partial: Partial<SpatialViewState>) => view$.next({ ...view$.value, ...partial })),
    colorByColumn: jest.fn((name: string) => view$.next({ ...view$.value, colorBy: { kind: 'column', name } })),
    colorByFeature: jest.fn((name: string) => view$.next({ ...view$.value, colorBy: { kind: 'feature', name } })),
    clearColorBy: jest.fn(() => view$.next({ ...view$.value, colorBy: null })),
    searchFeatures: jest.fn(async () => ['Ttr']),
    categoryColors: jest.fn(async () => ['#ff0000', '#0000ff']),
    getSelection$: jest.fn(() => selection$),
    selectFromRegions: jest.fn(() => 0),
    selectCategory: jest.fn(async () => 0),
    clearSelection: jest.fn(() => selection$.next(emptySelection())),
    sampledSections: jest.fn(() => Float32Array.from([0, 10, 20])),
  } as unknown as jest.Mocked<ISpatialControls>;
  return { controls, dataset$, view$, selection$ };
}
