import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SharedModule } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TooltipModule } from 'primeng/tooltip';

import { ClassPreset, MatchMode, PresetSet } from '../../models/class-preset';
import { HexColorPickerComponent } from '../../hex-color-picker/hex-color-picker.component';

/**
 * "Manage annotation classes" (jit-ui#70): edit the classes, the fallback
 * palette, auto-add and label matching of a working copy of the preset set,
 * plus reset / import / export. The editor owns the draft (`[(draft)]`); every
 * edit here emits a new draft object (nothing is changed in place), and Apply
 * asks the editor to persist it.
 */
@Component({
  selector: 'region-manage-classes-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SharedModule,
    ButtonModule,
    CheckboxModule,
    DialogModule,
    InputTextModule,
    SelectButtonModule,
    TooltipModule,
    HexColorPickerComponent,
  ],
  templateUrl: './manage-classes-dialog.component.html',
  styleUrls: ['./manage-classes-dialog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ManageClassesDialogComponent {
  /** The dialog is open. */
  @Input() visible = false;
  /** The dialog was closed (`false`); two-way with {@link visible}. */
  @Output() visibleChange = new EventEmitter<boolean>();

  /** The working copy being edited (null until the dialog is opened). */
  @Input() draft: PresetSet | null = null;
  /** Every edit: the new draft object; two-way with {@link draft}. */
  @Output() draftChange = new EventEmitter<PresetSet>();

  /** Apply clicked: persist the draft and close. */
  @Output() apply = new EventEmitter<void>();
  /** Reset clicked: restore the default classes. */
  @Output() resetDefaults = new EventEmitter<void>();
  /** A preset JSON file was chosen (the input's change event). */
  @Output() importFile = new EventEmitter<Event>();
  /** Export clicked. */
  @Output() export = new EventEmitter<void>();

  protected readonly matchModeOptions = [
    { label: 'Exact', value: 'exact' },
    { label: 'Normalized', value: 'normalized' },
  ];

  /** Rows keep their DOM (and input focus) while their class object is replaced. */
  protected readonly trackByIndex = (i: number): number => i;

  protected addClass(): void {
    this.update((d) => ({ classes: [...d.classes, { name: '', color: '#888888', source: 'user' }] }));
  }

  protected removeClass(i: number): void {
    this.update((d) => ({ classes: d.classes.filter((_, k) => k !== i) }));
  }

  protected patchClass(i: number, patch: Partial<ClassPreset>): void {
    this.update((d) => ({ classes: d.classes.map((c, k) => (k === i ? { ...c, ...patch } : c)) }));
  }

  protected addFallbackColor(): void {
    this.update((d) => ({ fallbackPalette: [...d.fallbackPalette, '#888888'] }));
  }

  protected removeFallbackColor(i: number): void {
    this.update((d) => ({ fallbackPalette: d.fallbackPalette.filter((_, k) => k !== i) }));
  }

  protected setFallbackColor(i: number, color: string): void {
    this.update((d) => ({ fallbackPalette: d.fallbackPalette.map((c, k) => (k === i ? color : c)) }));
  }

  protected setAutoPromote(autoPromote: boolean): void {
    this.update(() => ({ autoPromote }));
  }

  protected setMatchMode(matchMode: MatchMode): void {
    this.update(() => ({ matchMode }));
  }

  private update(change: (d: PresetSet) => Partial<PresetSet>): void {
    if (!this.draft) return;
    this.draft = { ...this.draft, ...change(this.draft) };
    this.draftChange.emit(this.draft);
  }
}
