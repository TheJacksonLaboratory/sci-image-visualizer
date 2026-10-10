import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SharedModule } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';

import { HexColorPickerComponent } from '../../hex-color-picker/hex-color-picker.component';

/** One class's colour in the dialog; `label` '' groups unclassified regions. */
export interface ClassColorEdit {
  label: string;
  color: string;
}

/**
 * "Edit colour of selected regions": one picker per class among the selection.
 * Edits a private copy of `edits` and reports the result on Apply; the editor
 * applies it to the regions (copy-on-write) and commits.
 */
@Component({
  selector: 'region-color-dialog',
  standalone: true,
  imports: [CommonModule, SharedModule, ButtonModule, DialogModule, HexColorPickerComponent],
  templateUrl: './region-color-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegionColorDialogComponent {
  /** The dialog is open. */
  @Input() visible = false;
  /** The dialog was closed (`false`); two-way with {@link visible}. */
  @Output() visibleChange = new EventEmitter<boolean>();

  /** Number of selected regions, for the caption. */
  @Input() selectedCount = 0;

  /** The seeded colours; the dialog edits a copy. */
  @Input() set edits(value: ClassColorEdit[] | null | undefined) {
    this.draft = (value ?? []).map((e) => ({ ...e }));
  }

  /** Apply clicked: the edited colours per class. */
  @Output() apply = new EventEmitter<ClassColorEdit[]>();

  protected draft: ClassColorEdit[] = [];

  protected setColor(i: number, color: string): void {
    this.draft = this.draft.map((e, k) => (k === i ? { ...e, color } : e));
  }

  protected close(): void {
    this.visibleChange.emit(false);
  }
}
