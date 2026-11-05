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
import type { TranscriptsInSelection } from '../../contracts/display-types';

/**
 * "Transcripts in selection", in the Transcripts section: the transcripts of what is selected, by
 * gene, most frequent first — through the volume in spatial 3D (a cell, or a cell type picked on the
 * canvas), on the plane shown in 2D (the selected cells or regions). See
 * `ISpatialControls.getTranscriptsInSelection$`.
 *
 * Collapsible; counted only while expanded (and while the Transcripts section, which holds it, is
 * open): the counts read the finest transcript tiles of the selection.
 */
@Component({
  selector: 'spatial-selection-transcripts',
  standalone: true,
  imports: [CommonModule, ButtonModule, TooltipModule],
  templateUrl: './spatial-selection-transcripts.component.html',
  styleUrls: ['./spatial-selection-transcripts.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpatialSelectionTranscriptsComponent implements OnChanges, OnDestroy {
  /** The spatial controls the list is read through; null without a `SPATIAL_DATA_PORT`. */
  @Input() controls: ISpatialControls | null = null;
  /** In spatial 3D: the list is of the whole volume. */
  @Input() is3d = false;

  /** Expanded: the list is counted and shown. */
  protected expanded = true;
  /** The selection's transcripts by gene (null until the first answer). */
  protected list: TranscriptsInSelection | null = null;
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

  /** Whether there is a list to offer: the controls count transcripts. */
  protected get available(): boolean {
    return !!this.controls?.getTranscriptsInSelection$;
  }

  /** The largest gene count, for the bars. */
  protected get max(): number {
    return this.list?.genes?.[0]?.count ?? 0;
  }

  protected toggle(): void {
    this.expanded = !this.expanded;
    this.watch();
  }

  /** Subscribe while expanded, else not (a collapsed list reads nothing). */
  private watch(): void {
    this.sub?.unsubscribe();
    this.sub = null;
    if (!this.expanded) return;
    const list$ = this.controls?.getTranscriptsInSelection$?.();
    if (!list$) return;
    this.sub = list$.subscribe((state) =>
      // The controls' streams may emit outside the zone.
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

  /** The list as tab-separated text (gene, count), for a spreadsheet. */
  protected copy(): void {
    const genes = this.list?.genes;
    if (!genes?.length) return;
    const text = ['gene\ttranscripts', ...genes.map((g) => `${g.name}\t${g.count}`)].join('\n');
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  protected trackGene(_i: number, g: { name: string }): string {
    return g.name;
  }
}
