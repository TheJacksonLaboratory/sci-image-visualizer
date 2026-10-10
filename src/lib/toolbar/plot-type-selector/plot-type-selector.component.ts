import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

import { PlotType, PlotTypeId } from '../../contracts/plot-type';
import { PlotTypeOption } from '../../contracts/plot-type-contribution.contract';

/**
 * The toolbar's plot-type group: the plot-type dropdown, the isosurface band
 * slider for the isosurface modes, and the add-intensity-line button for the
 * views that draw profile lines. Presentational: the host owns the values.
 */
@Component({
  selector: 'toolbar-plot-type-selector',
  templateUrl: './plot-type-selector.component.html',
  styleUrls: ['./plot-type-selector.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlotTypeSelectorComponent {
  /** Plot types the active backend advertises, then any contributed modes. */
  @Input() options: PlotTypeOption[] = [];
  /** The selected built-in type or contributed mode id. */
  @Input() selected: PlotTypeId = PlotType.IMAGE;
  /** An isosurface mode: show the iso band slider. */
  @Input() isosurface = false;
  /** Isosurface band as a 0–255 slider position. */
  @Input() isoRange: number[] = [0, 255];
  /** The view draws intensity profile lines: show the add-line button. */
  @Input() intensityLines = false;

  @Output() selectPlotType = new EventEmitter<PlotTypeId>();
  @Output() isoRangeChange = new EventEmitter<number[] | undefined>();
  /** Add another coloured intensity line ROI + inset trace. */
  @Output() addProfileLine = new EventEmitter<void>();

  /** Iso slider bounds — UI constants (the band is host-owned). */
  readonly isoValueMin = 0;
  readonly isoValueMax = 255;
  readonly isoValueStep = 1;

  /** A plot-type icon is a PrimeNG font glyph (e.g. `pi pi-image`) rather than an
   *  SVG asset path — drives which element the item template renders. */
  isPiIcon(icon: string | undefined): boolean {
    return !!icon && icon.startsWith('pi ');
  }

  /** The iso band slider reports its `[low, high]` pair (or nothing). */
  onIsoRange(value: number | number[] | undefined): void {
    this.isoRangeChange.emit(Array.isArray(value) ? value : undefined);
  }
}
