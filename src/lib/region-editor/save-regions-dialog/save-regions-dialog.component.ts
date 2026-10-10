import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SharedModule } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressBarModule } from 'primeng/progressbar';

/**
 * A GeoJSON filename dialog, used by the Region Editor for both "Save Regions
 * As" (server save: overwrite warning, progress + Cancel while busy) and
 * "Export Regions" (download). Presentational — the editor owns the state and
 * the I/O ({@link RegionPersistenceService}).
 */
@Component({
  selector: 'region-save-regions-dialog',
  standalone: true,
  imports: [
    CommonModule, FormsModule, SharedModule, ButtonModule, DialogModule, InputTextModule, ProgressBarModule,
  ],
  templateUrl: './save-regions-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SaveRegionsDialogComponent {
  /** The dialog title. */
  @Input() header = 'Save Regions As';
  /** The confirm button's label. */
  @Input() confirmLabel = 'Save';
  /** The confirm button's PrimeIcons class. */
  @Input() confirmIcon = 'pi pi-save';
  /** id of the filename input (unique per dialog instance). */
  @Input() inputId = 'geojson-filename';

  /** The dialog is open. */
  @Input() visible = false;
  /** The dialog was closed (`false`); two-way with {@link visible}. */
  @Output() visibleChange = new EventEmitter<boolean>();

  /** The GeoJSON filename. */
  @Input() filename = '';
  /** The filename was edited; two-way with {@link filename}. */
  @Output() filenameChange = new EventEmitter<string>();

  /** Shows the "will be overwritten" warning. */
  @Input() fileExists = false;
  /** True while the save runs (the form is replaced by progress). */
  @Input() busy = false;

  /** Save/Export clicked with a non-blank filename. */
  @Output() confirm = new EventEmitter<void>();
  /** Cancel clicked while the save runs. */
  @Output() cancelSave = new EventEmitter<void>();

  protected close(): void {
    this.visibleChange.emit(false);
  }
}
