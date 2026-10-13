import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SliderModule } from 'primeng/slider';
import { TooltipModule } from 'primeng/tooltip';

/**
 * A labelled toolbar slider: label, p-slider, value readout. Used for the
 * brush size, wand sensitivity, vertex-eraser radius and the isosurface band
 * (`range`). Presentational: the host owns the value.
 */
@Component({
  selector: 'toolbar-tool-slider',
  standalone: true,
  imports: [FormsModule, SliderModule, TooltipModule],
  templateUrl: './tool-slider.component.html',
  styleUrls: ['./tool-slider.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolSliderComponent {
  /** The label before the slider. */
  @Input() label = '';
  /** A number, or `[low, high]` with {@link range}. */
  @Input() value: number | number[] = 0;
  /** Lower bound of the slider. */
  @Input() min = 0;
  /** Upper bound of the slider. */
  @Input() max = 100;
  /** Slider step. */
  @Input() step = 1;
  /** A two-handle range slider: {@link value} is `[low, high]`. */
  @Input() range = false;
  /** Tooltip (HTML). */
  @Input() tooltip = '';
  /** The readout after the slider. */
  @Input() valueText = '';
  /** Slider moved: its value (or values with {@link range}); PrimeNG may report none. */
  @Output() valueChange = new EventEmitter<number | number[] | undefined>();

  protected onChange(event: { value?: number; values?: number[] }): void {
    this.valueChange.emit(this.range ? event.values : event.value);
  }
}
