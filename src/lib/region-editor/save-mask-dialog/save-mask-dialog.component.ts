import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

import { MaskMode } from '../mask-export.service';

/**
 * The Region Editor's "Save mask" dialog: filename + mask type while idle, a
 * progress bar (rasterize, then encode) with a Cancel button while the export
 * runs. Presentational — the editor owns the state and the export
 * ({@link MaskExportService}); the dialog only reports edits and clicks.
 */
@Component({
  selector: 'region-save-mask-dialog',
  templateUrl: './save-mask-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SaveMaskDialogComponent {
  @Input() visible = false;
  @Output() visibleChange = new EventEmitter<boolean>();

  @Input() filename = '';
  @Output() filenameChange = new EventEmitter<string>();

  @Input() mode: MaskMode = 'binary';
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

  close(): void {
    this.visibleChange.emit(false);
  }
}
