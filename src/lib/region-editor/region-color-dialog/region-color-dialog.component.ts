import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

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
  templateUrl: './region-color-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegionColorDialogComponent {
  @Input() visible = false;
  @Output() visibleChange = new EventEmitter<boolean>();

  /** Number of selected regions, for the caption. */
  @Input() selectedCount = 0;

  /** The seeded colours; the dialog edits a copy. */
  @Input() set edits(value: ClassColorEdit[] | null | undefined) {
    this.draft = (value ?? []).map((e) => ({ ...e }));
  }

  /** Apply clicked: the edited colours per class. */
  @Output() apply = new EventEmitter<ClassColorEdit[]>();

  draft: ClassColorEdit[] = [];

  setColor(i: number, color: string): void {
    this.draft = this.draft.map((e, k) => (k === i ? { ...e, color } : e));
  }

  close(): void {
    this.visibleChange.emit(false);
  }
}
