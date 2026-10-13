import type * as OpenSeadragon from 'openseadragon';

import { OSD } from './osd-lib';
import { silenceOsdMultiImageAdvisory } from './openseadragon-viewer-options';

/** How long a mount waits for OSD's `open`/`open-failed` before giving up. */
export const OSD_OPEN_TIMEOUT_MS = 8000;

/** Create an OpenSeadragon viewer (synchronously: a throwing factory throws here). */
export function createViewer(options: Record<string, unknown>): OpenSeadragon.Viewer {
  silenceOsdMultiImageAdvisory();
  return (OSD as unknown as (o: Record<string, unknown>) => OpenSeadragon.Viewer)(options);
}

/**
 * Open `tileSource` in `viewer`. `onOpen` wires the freshly opened viewer
 * (overlays, handlers); the promise resolves true once it ran, false on
 * `open-failed` — and ALWAYS settles: if OSD never emits either (a bad tile
 * source, a viewer torn down mid-open), the render pipeline must not hang, since
 * a hang leaves imageLoading=true, sticking the spinner and the 500ms
 * cache-progress poll forever (NS_BINDING_ABORTED storm).
 */
export function openViewer(
  viewer: OpenSeadragon.Viewer,
  tileSource: unknown,
  onOpen: (viewer: OpenSeadragon.Viewer) => void,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    viewer.addOnceHandler('open', () => {
      onOpen(viewer);
      done(true);
    });
    viewer.addOnceHandler('open-failed', (e) => {
      const err = e as { message?: string } | undefined;
      console.warn('[OSD] open-failed', err?.message ?? e);
      done(false);
    });
    setTimeout(() => {
      if (!settled) console.warn('[OSD] viewer open timed out');
      done(false);
    }, OSD_OPEN_TIMEOUT_MS);
    viewer.open(tileSource as Parameters<OpenSeadragon.Viewer['open']>[0]);
  });
}
