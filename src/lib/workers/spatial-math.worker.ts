/// <reference lib="webworker" />
import {
  SpatialMathMessage, SpatialMathReply, resultTransferables, runSpatialMath,
} from './spatial-math-ops';

/**
 * Spatial field and density math Web Worker.
 *
 * `expressionField`, `expressionVolume`, `rasterizeDensity` and `heatmapMatrix` are pure,
 * typed arrays in and out, and O(N + voxels × kernel) with N in the millions: run on the
 * main thread they hold the frame for as long as they take. Here they run off it; the
 * client in `spatial-math.ts` falls back to the main thread where no worker can start.
 *
 * Protocol: `{ id, op, ...args }` → `{ id, ok: true, result }` | `{ id, ok: false, error }`.
 * The result's buffers are transferred back, not copied.
 */

self.onmessage = (event: MessageEvent<SpatialMathMessage>) => {
  const { id } = event.data;
  let reply: SpatialMathReply;
  let transfer: ArrayBuffer[] = [];
  try {
    const result = runSpatialMath(event.data);
    reply = { id, ok: true, result };
    transfer = resultTransferables(result);
  } catch (err) {
    reply = { id, ok: false, error: (err as Error)?.message ?? String(err) };
  }
  (self as unknown as Worker).postMessage(reply, transfer);
};
