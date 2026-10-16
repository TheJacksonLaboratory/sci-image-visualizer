/// <reference lib="webworker" />
import { RegionSourceMessage, RegionSourceReply, RegionSourceTables } from './region-source-ops';

/**
 * Region-source Web Worker: parses large GeoJSON region sets and serves their level-of-detail
 * tiles, so the main thread never parses or holds a whole set. One worker holds every open
 * source (by handle); the client in `worker-region-source.ts` falls back to the main thread
 * where no worker can start.
 *
 * Protocol: see `region-source-ops`.
 */

const tables = new RegionSourceTables();

self.onmessage = (event: MessageEvent<RegionSourceMessage>) => {
  const { id } = event.data;
  let reply: RegionSourceReply;
  try {
    reply = { id, ok: true, result: tables.run(event.data) };
  } catch (err) {
    reply = { id, ok: false, error: (err as Error)?.message ?? String(err) };
  }
  (self as unknown as Worker).postMessage(reply);
};
