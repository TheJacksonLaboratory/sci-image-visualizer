import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SharedModule } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressBarModule } from 'primeng/progressbar';
import { RadioButtonModule } from 'primeng/radiobutton';

import { MaskMode } from '../mask-export.service';

/**
 * The Region Editor's "Save mask" dialog: filename + mask type while idle, a
 * progress bar (rasterize, then encode) with a Cancel button while the export
 * runs. Presentational — the editor owns the state and the export
 * ({@link MaskExportService}); the dialog only reports edits and clicks.
 */
@Component({
  selector: 'region-save-mask-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule, SharedModule, ButtonModule, DialogModule, InputTextModule, ProgressBarModule,
    RadioButtonModule,
  ],
  templateUrl: './save-mask-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SaveMaskDialogComponent {
  /** The dialog is open. */
  @Input() visible = false;
  /** The dialog was closed (`false`); two-way with {@link visible}. */
  @Output() visibleChange = new EventEmitter<boolean>();

  /** The PNG filename. */
  @Input() filename = '';
  /** The filename was edited; two-way with {@link filename}. */
  @Output() filenameChange = new EventEmitter<string>();

  /** The mask type: binary, or one label value per class. */
  @Input() mode: MaskMode = 'binary';
  /** The mask type was changed; two-way with {@link mode}. */
  @Output() modeChange = new EventEmitter<MaskMode>();

  /** True while the export runs (the form is replaced by progress). */
  @Input() busy = false;
  /** 0–100 rasterization progress. */
  @Input() progress = 0;
  /** True once rasterizing is done and the PNG is being encoded. */
  @Input() encoding = false;

  /** Download clicked with a non-blank filename. */
  @Output() confirm = new EventEmitter<void>();
  /** Cancel clicked while the export runs. */
  @Output() cancelExport = new EventEmitter<void>();

  protected close(): void {
    this.visibleChange.emit(false);
  }
}
