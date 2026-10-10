import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

import { ClassPreset, MatchMode, PresetSet } from '../../models/class-preset';

/**
 * "Manage annotation classes" (jit-ui#70): edit the classes, the fallback
 * palette, auto-add and label matching of a working copy of the preset set,
 * plus reset / import / export. The editor owns the draft (`[(draft)]`); every
 * edit here emits a new draft object (nothing is changed in place), and Apply
 * asks the editor to persist it.
 */
@Component({
  selector: 'region-manage-classes-dialog',
  templateUrl: './manage-classes-dialog.component.html',
  styleUrls: ['./manage-classes-dialog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ManageClassesDialogComponent {
  @Input() visible = false;
  @Output() visibleChange = new EventEmitter<boolean>();

  /** The working copy being edited (null until the dialog is opened). */
  @Input() draft: PresetSet | null = null;
  @Output() draftChange = new EventEmitter<PresetSet>();

  /** Apply clicked: persist the draft and close. */
  @Output() apply = new EventEmitter<void>();
  /** Reset clicked: restore the default classes. */
  @Output() resetDefaults = new EventEmitter<void>();
  /** A preset JSON file was chosen (the input's change event). */
  @Output() importFile = new EventEmitter<Event>();
  /** Export clicked. */
  @Output() export = new EventEmitter<void>();

  readonly matchModeOptions = [
    { label: 'Exact', value: 'exact' },
    { label: 'Normalized', value: 'normalized' },
  ];

  /** Rows keep their DOM (and input focus) while their class object is replaced. */
  readonly trackByIndex = (i: number): number => i;

  addClass(): void {
    this.update((d) => ({ classes: [...d.classes, { name: '', color: '#888888', source: 'user' }] }));
  }

  removeClass(i: number): void {
    this.update((d) => ({ classes: d.classes.filter((_, k) => k !== i) }));
  }

  patchClass(i: number, patch: Partial<ClassPreset>): void {
    this.update((d) => ({ classes: d.classes.map((c, k) => (k === i ? { ...c, ...patch } : c)) }));
  }

  addFallbackColor(): void {
    this.update((d) => ({ fallbackPalette: [...d.fallbackPalette, '#888888'] }));
  }

  removeFallbackColor(i: number): void {
    this.update((d) => ({ fallbackPalette: d.fallbackPalette.filter((_, k) => k !== i) }));
  }

  setFallbackColor(i: number, color: string): void {
    this.update((d) => ({ fallbackPalette: d.fallbackPalette.map((c, k) => (k === i ? color : c)) }));
  }

  setAutoPromote(autoPromote: boolean): void {
    this.update(() => ({ autoPromote }));
  }

  setMatchMode(matchMode: MatchMode): void {
    this.update(() => ({ matchMode }));
  }

  private update(change: (d: PresetSet) => Partial<PresetSet>): void {
    if (!this.draft) return;
    this.draft = { ...this.draft, ...change(this.draft) };
    this.draftChange.emit(this.draft);
  }
}
