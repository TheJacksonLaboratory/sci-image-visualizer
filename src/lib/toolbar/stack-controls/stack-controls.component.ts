import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

/** A stack-mode choice (`val` 'false' = single image, 'true' = stack). */
export interface StackOption {
  name: string;
  val: string;
}

/**
 * The toolbar's z-stack group: a live slice scrubber for the views that swap
 * slices in place, or (Plotly heatmap) the single-image / stack toggle with a
 * slice-number field. Presentational: the host owns `zIndex`.
 */
@Component({
  selector: 'toolbar-stack-controls',
  templateUrl: './stack-controls.component.html',
  styleUrls: ['./stack-controls.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StackControlsComponent {
  /** Show the live slice scrubber. */
  @Input() liveScrubber = false;
  /** Show the single-image / stack toggle (Plotly heatmap). */
  @Input() stackToggle = false;
  /** Stack mode is on (the toggle's state). */
  @Input() showStack = false;
  @Input() stackOptions: StackOption[] = [{ name: 'Single image', val: 'false' }, { name: 'Stack', val: 'true' }];
  @Input() zIndex = 0;
  @Input() maxIndex = 0;

  @Output() zScrub = new EventEmitter<number | undefined>();
  @Output() zSlide = new EventEmitter<number | undefined>();
  @Output() selectStackOption = new EventEmitter<StackOption>();
  @Output() zIndexInput = new EventEmitter<number>();
  @Output() reloadAndPlot = new EventEmitter<void>();

  /** The slice field reports what was typed (blank keeps the current slice). */
  onSliceInput(value: string | number | null): void {
    this.zIndexInput.emit(value == null || value === '' ? this.zIndex : Number(value));
  }
}
