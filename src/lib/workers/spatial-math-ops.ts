import type { SpatialObservations } from '../contracts/spatial-dataset.contract';
import { DensityGrid, DensityOptions, rasterizeDensity } from '../spatial/spatial-density';
import {
  ExpressionField,
  ExpressionFieldOptions,
  ExpressionVolumeField,
  ExpressionVolumeOptions,
  expressionField,
  expressionVolume,
} from '../spatial/spatial-expression';
import {
  HeatmapGene,
  HeatmapGroups,
  HeatmapMatrix,
  HeatmapMatrixOptions,
  heatmapMatrix,
} from '../spatial/spatial-heatmap';

/**
 * The pure spatial field and density math, as messages: what crosses into
 * `spatial-math.worker` and what comes back, and the one dispatcher both the worker and
 * the main-thread fallback run. DOM-free and Angular-free, because the worker bundles it.
 */

/**
 * Just the coordinates of {@link SpatialObservations}: all the math reads. Cloning the
 * full observations would also copy `ids` — millions of strings on a large dataset.
 */
export type SpatialMathObservations = Pick<SpatialObservations, 'count' | 'x' | 'y' | 'z'>;

/** One computation, by name, with the arguments of the synchronous function it runs. */
export type SpatialMathRequest =
  | { op: 'expressionField'; obs: SpatialMathObservations; opts: ExpressionFieldOptions }
  | {
      op: 'expressionVolume';
      obs: SpatialMathObservations;
      grid: DensityGrid;
      opts: ExpressionVolumeOptions;
    }
  | { op: 'rasterizeDensity'; obs: SpatialMathObservations; grid: DensityGrid; opts: DensityOptions }
  | {
      op: 'heatmapMatrix';
      genes: readonly HeatmapGene[];
      groups: HeatmapGroups;
      opts: HeatmapMatrixOptions;
    };

/** What each {@link SpatialMathRequest} op resolves to. */
export interface SpatialMathResults {
  expressionField: ExpressionField | null;
  expressionVolume: ExpressionVolumeField | null;
  rasterizeDensity: Uint8Array | null;
  heatmapMatrix: HeatmapMatrix | null;
}

/** A request on the wire: the computation plus the id its answer is matched by. */
export type SpatialMathMessage = SpatialMathRequest & { id: number };

/** The worker's answer to one {@link SpatialMathMessage}. */
export type SpatialMathReply =
  | { id: number; ok: true; result: SpatialMathResults[keyof SpatialMathResults] }
  | { id: number; ok: false; error: string };

/** The coordinates of `obs`, without the per-observation strings the math never reads. */
export function slimObservations(obs: SpatialMathObservations): SpatialMathObservations {
  return obs.z ? { count: obs.count, x: obs.x, y: obs.y, z: obs.z } : { count: obs.count, x: obs.x, y: obs.y };
}

/** Run one request synchronously — in the worker, or on the main thread as the fallback. */
export function runSpatialMath<R extends SpatialMathRequest>(request: R): SpatialMathResults[R['op']] {
  const r = request as SpatialMathRequest;
  switch (r.op) {
    case 'expressionField':
      return expressionField(r.obs as SpatialObservations, r.opts) as SpatialMathResults[R['op']];
    case 'expressionVolume':
      return expressionVolume(r.obs as SpatialObservations, r.grid, r.opts) as SpatialMathResults[R['op']];
    case 'rasterizeDensity':
      return rasterizeDensity(r.obs as SpatialObservations, r.grid, r.opts) as SpatialMathResults[R['op']];
    case 'heatmapMatrix':
      return heatmapMatrix(r.genes, r.groups, r.opts) as SpatialMathResults[R['op']];
    default:
      throw new Error(`unknown spatial-math op "${(r as { op: string }).op}"`);
  }
}

/**
 * The buffers of a result, to transfer rather than copy back: the worker made them and
 * never reads them again. Deduplicated, since a transfer list may not name one twice.
 */
export function resultTransferables(result: unknown): ArrayBuffer[] {
  const found = new Set<ArrayBuffer>();
  const visit = (v: unknown) => {
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer) found.add(v.buffer);
    } else if (v && typeof v === 'object') {
      for (const value of Object.values(v)) visit(value);
    }
  };
  visit(result);
  return [...found];
}
