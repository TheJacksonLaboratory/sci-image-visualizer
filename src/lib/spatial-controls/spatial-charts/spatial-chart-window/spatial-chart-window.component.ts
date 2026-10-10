import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { DialogModule } from 'primeng/dialog';

/**
 * The detached chart window: a non-modal, draggable, resizable dialog beside the
 * spatial-omics dialog, holding the plot div (by {@link divId}) and whatever is projected
 * under it (the chart's hints).
 *
 * Presentational: the charts panel draws into the div, and decides what closing,
 * showing and resizing the window mean.
 */
@Component({
  selector: 'spatial-chart-window',
  standalone: true,
  imports: [DialogModule],
  templateUrl: './spatial-chart-window.component.html',
  styleUrls: ['./spatial-chart-window.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialChartWindowComponent {
  /** The window's header — what it is showing. */
  @Input() title = '';
  /** The id of the div the chart is drawn into. */
  @Input() divId = '';
  /** Whether the drawn layout fixed its own height (and so the window scrolls). */
  @Input() fixedHeight = false;
  /** The window was closed: put the chart back. */
  @Output() readonly closed = new EventEmitter<void>();
  /** The window is up and its div exists: the chart can be drawn into it. */
  @Output() readonly shown = new EventEmitter<void>();
  /** The window was resized: re-fit the chart. */
  @Output() readonly resizeEnd = new EventEmitter<void>();
}
