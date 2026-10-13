import { Injectable } from '@angular/core';

import { CanvasToolHost } from '../tool-kit/canvas-tool';
import { SamSessionService } from './sam-session.service';
import { ISamSession } from '../../contracts/sam.contract';
import { Region, Polygon, Rectangle } from '../../models/region';
import { makePolygon } from '../../models/polygon-factory';
import { maskToPolygons } from '../../geometry/contour';
import { MatrixFrame } from '../tool-kit/matrix-frame';
import { AsyncToolStatus } from '../tool-kit/async-tool-status';
import { withoutRegions } from './segmentation-commit';

/** @deprecated The SAM tool runs against the backend's canvas-tool host:
 *  use {@link CanvasToolHost}. */
export type SamToolHost = CanvasToolHost;

/**
 * Box-prompted SAM segmentation tool (jit-ui#90, P0). On `segmentBoxes()` it
 * reads every rectangle region, runs the (cached) encoder once for the image,
 * then runs the decoder per box, traces each mask to a polygon and replaces
 * the prompt rectangles with the masks.
 *
 * Inference goes through the shared {@link SamSessionService} (one session and
 * embedding for both SAM tools); tests inject a fake session via
 * {@link useSession}.
 */
@Injectable({ providedIn: 'root' })
export class SamToolService {
  private readonly state = new AsyncToolStatus();

  /** Status text + busy flag for a spinner / toast in the host. */
  readonly status$ = this.state.status$;
  readonly busy$ = this.state.busy$;
  /** Encoder-download progress: -1 = not downloading, 0..1 = downloading. */
  readonly progress$ = this.state.progress$;

  constructor(private readonly sessions: SamSessionService = new SamSessionService()) {}

  /** Choose the registered model to use (shared with the point tool). */
  setModel(id: string): void {
    this.sessions.setModel(id);
  }

  /** Drop the cached embedding (e.g. after the image/slice changes). */
  invalidateEmbedding(): void {
    this.sessions.invalidateEmbedding();
  }

  /** Test seam: inject a fake/alternate inference session. */
  useSession(session: ISamSession): void {
    this.sessions.useSession(session);
  }

  /**
   * Segment every rectangle region of the backend behind `host` with a box
   * prompt and replace each prompt that produced a mask with the mask's polygon
   * region. Returns how many regions were added; 0 (ignored) while a previous
   * run is still going. The host is passed per run, so no backend's host
   * outlives its call.
   */
  async segmentBoxes(host: CanvasToolHost): Promise<number> {
    if (this.state.busy) return 0;
    const cached = host.getCachedImageData();
    if (!cached || cached.frames.length === 0) {
      this.status$.next('No image loaded.');
      return 0;
    }
    const rects = host.getRegions().filter((r) => r.bounds instanceof Rectangle);
    if (rects.length === 0) {
      this.status$.next('Draw one or more rectangles, then press Segment.');
      return 0;
    }
    const frame = MatrixFrame.from(cached);
    const frameIdx = host.getActiveFrameIndex();

    // Busy from here on — including the model download, so a second press
    // can't start a second download/encode (which can freeze the tab on a heavy
    // WebGPU ViT-B).
    const added = await this.state.run(async () => {
      let session: ISamSession;
      try {
        session = await this.sessions.ensureSession((f) => this.progress$.next(f));
      } catch (err) {
        this.status$.next(err instanceof Error ? err.message : 'SAM model unavailable.');
        return 0;
      }
      try {
        // Encode once per image; reuse the embedding across all boxes.
        const key = [host.getFileName() ?? '', frameIdx, `${cached.width}x${cached.height}`, frame.sig].join('|');
        const embedding = await this.sessions.embed(session, cached, frameIdx, key, () =>
          this.status$.next('Encoding image…'),
        );

        const masks: Region[] = [];
        const consumed: Region[] = []; // prompt rectangles that produced a mask
        for (let i = 0; i < rects.length; i++) {
          this.status$.next(`Segmenting ${i + 1}/${rects.length}…`);
          const b = rects[i].bounds as Rectangle;
          // Rectangle is in data coords → convert to image (matrix) coords.
          const box = {
            x0: frame.toMatrixX(b.x),
            y0: frame.toMatrixY(b.y),
            x1: frame.toMatrixX(b.x + b.width),
            y1: frame.toMatrixY(b.y + b.height),
          };
          const res = await session.decode(embedding, { box });
          // Keep the largest connected piece (maskToPolygons returns largest-first).
          const poly = maskToPolygons(res.mask, res.width, res.height, 0, 0)[0];
          if (!poly) continue;
          // Inherit the prompt rectangle's colour.
          masks.push(makeSamRegion(poly, frame, rects[i].color || host.getShapeColor()));
          consumed.push(rects[i]);
        }

        // Commit against the regions as they are NOW: the user may have drawn,
        // edited or deleted regions during the (possibly minutes-long) run.
        // Prompts that produced a mask are replaced; the rest stay for a retry.
        host.setRegions(withoutRegions(host.getRegions(), consumed).concat(masks));
        this.status$.next(masks.length > 0 ? `Added ${masks.length} region(s).` : 'No masks found.');
        return masks.length;
      } catch (err) {
        this.status$.next(err instanceof Error ? err.message : 'Segmentation failed.');
        return 0;
      }
    });
    return added ?? 0;
  }
}

function makeSamRegion(poly: Polygon, frame: MatrixFrame, color: string): Region {
  const ring = frame.ringToData(poly.xpoints, poly.ypoints);
  const region = new Region();
  region.bounds = makePolygon(ring.xs, ring.ys, { holes: frame.holesToData(poly.holes) });
  // The source prompt rectangle's color, else the host default.
  region.color = color;
  // Default class/annotation name, matching the wand/brush + overlay-drawn regions.
  region.label = 'sam';
  return region;
}
