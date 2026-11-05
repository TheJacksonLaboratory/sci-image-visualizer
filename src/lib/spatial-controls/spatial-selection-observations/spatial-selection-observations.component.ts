import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { Subscription } from 'rxjs';

import type { ISpatialControls } from '../../contracts/visualizer.contract';
import type { ObservationsInSelection } from '../../contracts/display-types';

/**
 * "Observations in selection", in the Observations section: the observations of what is selected —
 * a cell, a cell type picked on the canvas, the selected regions — by the grouping they are coloured
 * by (else the cell types), with a few measurements' means, or one cell's id, groupings and values.
 * Every observation in spatial 3D; in 2D those on the plane shown. See
 * `ISpatialControls.getObservationsInSelection$`.
 *
 * Collapsible; followed only while expanded (and while the Observations section, which holds it, is
 * open).
 */
@Component({
  selector: 'spatial-selection-observations',
  standalone: true,
  imports: [CommonModule, ButtonModule, TooltipModule],
  templateUrl: './spatial-selection-observations.component.html',
  styleUrls: ['./spatial-selection-observations.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialSelectionObservationsComponent implements OnChanges, OnDestroy {
  /** The spatial controls the list is read through; null without a `SPATIAL_DATA_PORT`. */
  @Input() controls: ISpatialControls | null = null;
  /** In spatial 3D: the list is of the whole volume. */
  @Input() is3d = false;

  /** Expanded: the list is followed and shown. */
  protected expanded = true;
  /** The selection's observations (null until the first answer). */
  protected list: ObservationsInSelection | null = null;
  private sub: Subscription | null = null;

  constructor(
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['controls']) this.watch();
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.sub = null;
  }

  /** Whether there is a list to offer. */
  protected get available(): boolean {
    return !!this.controls?.getObservationsInSelection$;
  }

  /** The largest group, for the bars. */
  protected get max(): number {
    return this.list?.groups?.[0]?.count ?? 0;
  }

  protected toggle(): void {
    this.expanded = !this.expanded;
    this.watch();
  }

  private watch(): void {
    this.sub?.unsubscribe();
    this.sub = null;
    if (!this.expanded) return;
    const list$ = this.controls?.getObservationsInSelection$?.();
    if (!list$) return;
    this.sub = list$.subscribe((state) =>
      this.zone.run(() => {
        // Keep the last list on screen while the next one loads, so it does not flicker.
        this.list =
          state.state === 'loading' && this.list?.state === 'ready'
            ? { ...this.list, state: 'loading', label: state.label ?? this.list.label }
            : state;
        this.cdr.markForCheck();
      }),
    );
  }

  /** A measurement as shown: a number to 3 significant figures (with its unit), text as it is. */
  protected format(m: { value: string | number; unit?: string }): string {
    if (typeof m.value === 'string') return m.value;
    const v = m.value;
    const text = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Number(v.toPrecision(3)).toString();
    return m.unit ? `${text} ${m.unit}` : text;
  }

  /** The groups as tab-separated text (group, observations), for a spreadsheet. */
  protected copy(): void {
    const groups = this.list?.groups;
    if (!groups?.length) return;
    const head = this.list?.groupColumn ?? 'group';
    const text = [`${head}\tobservations`, ...groups.map((g) => `${g.name}\t${g.count}`)].join('\n');
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  protected trackGroup(_i: number, g: { name: string }): string {
    return g.name;
  }
}
