import { ChangeDetectorRef, NgZone } from '@angular/core';

/**
 * Mark an OnPush view for check, from wherever the change came from.
 *
 * `markForCheck()` only flags the view; a change-detection pass runs when the zone next
 * settles. A change that arrives outside the zone — a store emission from an overlay's
 * pointer handler, an OpenSeadragon or napari-js callback, a host stream — settles no
 * zone, so the view would keep showing stale state until some unrelated event runs
 * change detection. Re-entering the zone in that case schedules the pass.
 */
export function markForCheckInZone(cdr: ChangeDetectorRef, zone: NgZone): void {
  if (NgZone.isInAngularZone()) cdr.markForCheck();
  else zone.run(() => cdr.markForCheck());
}
