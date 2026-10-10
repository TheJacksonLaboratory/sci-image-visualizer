import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, Inject, Input, NgZone, OnDestroy, OnInit,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';

import { IImageInfo } from '../contracts/image.contract';
import { IntensityProfile, IVisualizer, VISUALIZER } from '../contracts/visualizer.contract';
import { Region } from '../models/region';
import { FloatingDragDirective, FloatingPos } from '../visualizer/floating-drag.directive';

/**
 * The floating, draggable intensity-profile inset: shown while any intensity line
 * exists, charting one trace per line as lines are added, moved or removed.
 *
 * Owns the profile and viewport-change subscriptions, the window-resize reflow, the
 * drag and the per-instance chart div id it is given. The chart itself is drawn by the
 * backend (`IVisualizer.renderIntensityInset`) so this never reaches a charting
 * library. Fixed to the viewport, outside the plot div, so it is not clipped to the
 * canvas.
 *
 * OnPush, with its view state in signals: the profile stream may fire outside the zone.
 */
@Component({
  selector: 'viz-intensity-inset',
  standalone: true,
  imports: [CommonModule, FloatingDragDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './intensity-inset.component.html',
  styleUrls: ['./intensity-inset.component.scss'],
})
export class IntensityInsetComponent implements OnInit, OnDestroy {
  /** Id of the chart div — unique per viewer: the backend resolves it by id. */
  @Input() divId = '';
  /** Id of the viewer's plot div: the inset parks near its top-right corner. */
  @Input() plotDivName = '';
  /** The displayed slice, re-sampled at when the view settles. */
  @Input() zIndex = 0;
  /** The Image view (OSD), whose line sampling is fed from preview frames. */
  @Input() imageView = false;
  /** The image shown (the Image view samples its lines from it). */
  @Input() imageInfo: IImageInfo | undefined;

  /** True whenever any intensity-profile line exists (whatever the plot type). */
  protected readonly hasProfiles = signal(false);
  protected readonly pos = signal<FloatingPos>({ x: 20, y: 70 });
  /** Where a header drag starts from. */
  protected readonly dragOrigin = (): FloatingPos => this.pos();

  private profiles: IntensityProfile[] = [];
  private readonly onResize = () => {
    // Reflow to the (fixed) panel size once layout has settled: a mid-reflow resize
    // can leave the chart at a stale or zero size.
    if (this.hasProfiles()) requestAnimationFrame(() => this.render());
  };

  constructor(
    @Inject(VISUALIZER) private readonly visualizer: IVisualizer,
    private readonly cdr: ChangeDetectorRef,
    private readonly zone: NgZone,
    private readonly destroyRef: DestroyRef,
  ) {}

  ngOnInit(): void {
    this.visualizer.getIntensityProfile$().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((profiles) => {
      this.profiles = profiles;
      this.hasProfiles.set(profiles.length > 0);
      // The panel is behind *ngIf. detectChanges() materializes it synchronously (the
      // stream may fire outside the zone, e.g. from an OSD drag). Render on the next
      // frame, AFTER layout: drawn synchronously, Plotly sizes a fresh chart to a zero
      // box and keeps it, so the inset stays blank.
      this.cdr.detectChanges();
      requestAnimationFrame(() => this.render());
    });
    // When the OSD view settles at a new zoom/pan, re-sample from a crop of the
    // visible region so the inset reflects the zoom-level resolution (Plotly's own
    // high-def zoom updates the sampling cache inline).
    this.visualizer.getViewportChange$().pipe(takeUntilDestroyed(this.destroyRef)).subscribe((roi) => {
      if (this.hasProfiles() && this.imageView) {
        this.visualizer.refreshIntensitySamplingForRoi(roi.x, roi.y, roi.width, roi.height, this.zIndex);
      }
    });
    this.zone.runOutsideAngular(() => window.addEventListener('resize', this.onResize));
  }

  /** Removes the window resize listener; the streams end through `takeUntilDestroyed`. */
  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
  }

  /** The canvas was resized: reflow the chart a tick later, once the panel has settled. */
  reflow(): void {
    if (this.hasProfiles()) setTimeout(() => this.render(), 0);
  }

  /** A slice was committed: keep the lines sampled from it (Image view). */
  sliceCommitted(z: number): void {
    if (this.hasProfiles() && this.imageView && this.imageInfo) {
      void this.visualizer.ensureIntensitySampling(this.imageInfo, z);
    }
  }

  /**
   * Add another line ROI (next bright colour) and select it on the active backend so
   * it is ready to move or delete. The first line parks the inset near the plot's
   * top-right. Resolves the new line, or null when no image extent is known yet.
   */
  async addProfileLine(): Promise<Region | null> {
    if (!this.hasProfiles()) {
      const rect = document.getElementById(this.plotDivName)?.getBoundingClientRect();
      this.pos.set(rect ? { x: Math.max(10, rect.right - 300), y: rect.top + 10 } : { x: 20, y: 70 });
    }
    // Image (OSD) view: Plotly never rendered, so it has no pixel cache / extent. Load
    // the current slice's frames for sampling + line placement first.
    if (this.imageView && this.imageInfo) {
      await this.visualizer.ensureIntensitySampling(this.imageInfo, this.zIndex);
    }
    const region = this.visualizer.getIntensityControls()?.addProfileLine() ?? null;
    if (region) this.visualizer.selectRegion(region);
    return region;
  }

  private render(): void {
    if (this.hasProfiles()) this.visualizer.renderIntensityInset(this.divId, this.profiles);
  }
}
