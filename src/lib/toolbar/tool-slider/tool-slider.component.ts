import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

/**
 * A labelled toolbar slider: label, p-slider, value readout. Used for the
 * brush size, wand sensitivity, vertex-eraser radius and the isosurface band
 * (`range`). Presentational: the host owns the value.
 */
@Component({
  selector: 'toolbar-tool-slider',
  templateUrl: './tool-slider.component.html',
  styleUrls: ['./tool-slider.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolSliderComponent {
  @Input() label = '';
  /** A number, or `[low, high]` with {@link range}. */
  @Input() value: number | number[] = 0;
  @Input() min = 0;
  @Input() max = 100;
  @Input() step = 1;
  @Input() range = false;
  /** Tooltip (HTML). */
  @Input() tooltip = '';
  /** The readout after the slider. */
  @Input() valueText = '';
  /** Slider moved: its value (or values with {@link range}); PrimeNG may report none. */
  @Output() valueChange = new EventEmitter<number | number[] | undefined>();

  onChange(event: { value?: number; values?: number[] }): void {
    this.valueChange.emit(this.range ? event.values : event.value);
  }
}
