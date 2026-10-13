import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { SliderModule } from 'primeng/slider';
import { TooltipModule } from 'primeng/tooltip';

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
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputNumberModule, SliderModule, TooltipModule],
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
  /** The two stack-mode choices of the toggle. */
  @Input() stackOptions: StackOption[] = [
    { name: 'Single image', val: 'false' },
    { name: 'Stack', val: 'true' },
  ];
  /** The current slice (0-based). */
  @Input() zIndex = 0;
  /** The last slice index. */
  @Input() maxIndex = 0;

  /** The live scrubber moved (fires while dragging). */
  @Output() zScrub = new EventEmitter<number | undefined>();
  /** The live scrubber was released on a slice. */
  @Output() zSlide = new EventEmitter<number | undefined>();
  /** A stack-mode choice was picked. */
  @Output() selectStackOption = new EventEmitter<StackOption>();
  /** A slice number was typed (blank reports the current slice). */
  @Output() zIndexInput = new EventEmitter<number>();
  /** Enter in the slice field / the reload button: re-plot at the typed slice. */
  @Output() reloadAndPlot = new EventEmitter<void>();

  /** The slice field reports what was typed (blank keeps the current slice). */
  protected onSliceInput(value: string | number | null): void {
    this.zIndexInput.emit(value == null || value === '' ? this.zIndex : Number(value));
  }
}
