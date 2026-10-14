import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  Inject,
  OnInit,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';
import { Subject, debounceTime } from 'rxjs';

import { IRegionEditorApi, REGION_EDITOR_API } from '../../contracts/region-editor-api.contract';
import type { RegionSourceView } from '../../region-source/region-source';
import type { RegionIndexRow } from '../../region-source/region-tiles';

/** Rows per page of the list. */
export const SOURCE_LIST_ROWS = 25;

/**
 * The Region Editor's view of the image's region source: the features still in it (those not
 * yet taken into the regions table), a page at a time, filterable by class. Picking a row takes
 * that feature into the regions and selects it, so it can be edited like any region; the bin
 * deletes it without taking it. Shown only while the slice has a source.
 */
@Component({
  selector: 'region-source-list',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, TooltipModule],
  templateUrl: './region-source-list.component.html',
  styleUrls: ['./region-source-list.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegionSourceListComponent implements OnInit {
  protected view: RegionSourceView | null = null;
  protected rows: RegionIndexRow[] = [];
  protected total = 0;
  protected first = 0;
  protected filter = '';
  protected loading = false;
  protected readonly pageSize = SOURCE_LIST_ROWS;
  private readonly filter$ = new Subject<string>();
  /** Bumped per request, so an older page that answers late is dropped. */
  private request = 0;
  private readonly destroyRef = inject(DestroyRef);

  constructor(
    @Inject(REGION_EDITOR_API) private readonly api: IRegionEditorApi,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.api
      .getRegionSourceView$?.()
      ?.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((view) => {
        if (view?.source !== this.view?.source || view?.plane !== this.view?.plane) this.first = 0;
        this.view = view;
        void this.load();
      });
    this.filter$.pipe(debounceTime(250), takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.first = 0;
      void this.load();
    });
  }

  protected onFilter(value: string): void {
    this.filter = value;
    this.filter$.next(value);
  }

  protected page(delta: number): void {
    const next = this.first + delta * this.pageSize;
    if (next < 0 || next >= this.total) return;
    this.first = next;
    void this.load();
  }

  protected take(row: RegionIndexRow, event: MouseEvent): void {
    void this.api.selectSourceFeatures?.([row.id], event.shiftKey || event.metaKey || event.ctrlKey);
  }

  protected remove(row: RegionIndexRow, event: MouseEvent): void {
    event.stopPropagation();
    this.api.deleteSourceFeatures?.([row.id]);
  }

  protected colorOf(row: RegionIndexRow): string {
    return this.view?.colorOf(row) ?? row.color ?? '#00FFFF';
  }

  protected trackRow(_: number, row: RegionIndexRow): string {
    return row.id;
  }

  protected get lastShown(): number {
    return Math.min(this.first + this.pageSize, this.total);
  }

  private async load(): Promise<void> {
    const request = ++this.request;
    if (!this.view || !this.api.getRegionSourceIndex) {
      this.rows = [];
      this.total = 0;
      this.cdr.markForCheck();
      return;
    }
    this.loading = true;
    this.cdr.markForCheck();
    try {
      const page = await this.api.getRegionSourceIndex({
        offset: this.first,
        limit: this.pageSize,
        label: this.filter || undefined,
      });
      if (request !== this.request) return;
      this.rows = page?.rows ?? [];
      this.total = page?.total ?? 0;
      // Taking or deleting the last rows of the last page: show the page before.
      if (!this.rows.length && this.first > 0 && this.first >= this.total) {
        this.first = Math.max(0, Math.floor((this.total - 1) / this.pageSize) * this.pageSize);
        void this.load();
        return;
      }
    } catch (err) {
      if (request !== this.request) return;
      console.warn('[regions] could not list the region source', err);
      this.rows = [];
      this.total = 0;
    }
    this.loading = false;
    this.cdr.markForCheck();
  }
}
