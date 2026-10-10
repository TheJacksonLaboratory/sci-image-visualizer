import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

/**
 * A GeoJSON filename dialog, used by the Region Editor for both "Save Regions
 * As" (server save: overwrite warning, progress + Cancel while busy) and
 * "Export Regions" (download). Presentational — the editor owns the state and
 * the I/O ({@link RegionPersistenceService}).
 */
@Component({
  selector: 'region-save-regions-dialog',
  templateUrl: './save-regions-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SaveRegionsDialogComponent {
  @Input() header = 'Save Regions As';
  @Input() confirmLabel = 'Save';
  @Input() confirmIcon = 'pi pi-save';
  /** id of the filename input (unique per dialog instance). */
  @Input() inputId = 'geojson-filename';

  @Input() visible = false;
  @Output() visibleChange = new EventEmitter<boolean>();

  @Input() filename = '';
  @Output() filenameChange = new EventEmitter<string>();

  /** Shows the "will be overwritten" warning. */
  @Input() fileExists = false;
  /** True while the save runs (the form is replaced by progress). */
  @Input() busy = false;

  /** Save/Export clicked with a non-blank filename. */
  @Output() confirm = new EventEmitter<void>();
  /** Cancel clicked while the save runs. */
  @Output() cancelSave = new EventEmitter<void>();

  close(): void {
    this.visibleChange.emit(false);
  }
}
