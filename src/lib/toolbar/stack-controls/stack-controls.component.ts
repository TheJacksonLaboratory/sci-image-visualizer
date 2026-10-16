import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnDestroy, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SliderModule } from 'primeng/slider';
import { TooltipModule } from 'primeng/tooltip';

/** A stack-mode choice (`val` 'false' = single image, 'true' = stack). */
export interface StackOption {
  name: string;
  val: string;
}

/**
 * The toolbar's z-stack group: the slice bar, and (Plotly heatmap) the single-image / stack
 * toggle. The views that swap slices in place follow the bar as it moves; the heatmap's single
 * image is re-plotted at the slice it settles on. Presentational: the host owns `zIndex`.
 */
@Component({
  selector: 'toolbar-stack-controls',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SliderModule, TooltipModule],
  templateUrl: './stack-controls.component.html',
  styleUrls: ['./stack-controls.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StackControlsComponent implements OnDestroy {
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
  /** The heatmap's slice bar moved to a slice (the host shows its number). */
  @Output() zIndexInput = new EventEmitter<number>();
  /** The heatmap's slice bar settled: re-plot at that slice. */
  @Output() reloadAndPlot = new EventEmitter<void>();

  /** How long key steps on the heatmap's bar pause before the slice is re-plotted. */
  static readonly REPLOT_DELAY_MS = 400;

  /** A drag of the bar is under way (its end re-plots the heatmap, not each step). */
  protected dragging = false;
  private replot: ReturnType<typeof setTimeout> | null = null;

  /** The heatmap in single-image mode: its bar re-plots the slice it settles on. */
  protected get singleImage(): boolean {
    return this.stackToggle && !this.showStack;
  }

  /** The bar moved: a live view follows it; the heatmap shows the number, and re-plots after key steps pause. */
  protected onSliceChange(z: number | undefined): void {
    if (z === undefined) return;
    if (this.liveScrubber) {
      this.zScrub.emit(z);
      return;
    }
    this.zIndexInput.emit(z);
    if (this.dragging) return;
    this.cancelReplot();
    this.replot = setTimeout(() => {
      this.replot = null;
      this.reloadAndPlot.emit();
    }, StackControlsComponent.REPLOT_DELAY_MS);
  }

  /** The bar was let go (a drag's end, or a click on its track). */
  protected onSliceEnd(z: number | undefined): void {
    this.dragging = false;
    if (this.liveScrubber) {
      this.zSlide.emit(z);
      return;
    }
    if (z !== undefined) this.zIndexInput.emit(z);
    this.cancelReplot();
    this.reloadAndPlot.emit();
  }

  private cancelReplot(): void {
    if (this.replot !== null) clearTimeout(this.replot);
    this.replot = null;
  }

  ngOnDestroy(): void {
    this.cancelReplot();
  }
}
