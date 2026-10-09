import type { Repulsion } from './tsne';

/**
 * t-SNE's all-pairs term on the GPU, via jax-js.
 *
 * This is the only part of t-SNE worth accelerating. The attractive term is sparse — a
 * few hundred thousand pairs — while the repulsion is genuinely every pair against every
 * other: 25 million of them at the panel's 5,000-observation cap
 * (`SpatialChartsComponent.BROWSER_TSNE_MAX_OBSERVATIONS`), on every iteration.
 *
 * jax-js is loaded DYNAMICALLY. It is ~670 kB of JS and WebAssembly, and a host that
 * never computes an embedding should not pay for it, so nothing imports it until someone
 * asks for a t-SNE.
 *
 * WebGPU where available, WebAssembly SIMD otherwise. Both are far ahead of a plain loop,
 * and the fallback matters: WebGPU is absent in older Safari and behind a flag in some
 * Firefox builds, and an embedding that refuses to compute is worse than a slower one.
 *
 * WORKS IN TILES, and that is not a tuning choice. A tile of `rows` holds about three
 * `rows x nObs x dims` float32 tensors (the differences, the weighted differences and the
 * kernel), so its memory grows with `nObs` as well as with the rows. jax-js's WebAssembly
 * backend has a hard 4 GiB ceiling, and 2,048 rows was measured as the largest tile that
 * fits with room to spare at 19,416 points. At the 5,000 cap a 2,048-row 3-D tile is about
 * 0.4 GB, which sets the budget below: the rows are derived from it, so a larger `nObs`
 * gets shorter tiles instead of a larger working set.
 */

/** Most rows per tile — the measured ceiling above; never raised by the budget. */
const MAX_TILE_ROWS = 2048;
/** Fewest rows per tile, so a huge `nObs` still advances in useful steps. */
const MIN_TILE_ROWS = 64;
/** Working-set budget per tile: a 2,048-row 3-D tile at the 5,000-observation cap. */
const TILE_BUDGET_BYTES = MAX_TILE_ROWS * 5000 * 3 * 4 * 3;

/** Rows per tile for `nObs` observations embedded into `dims` dimensions. */
export function tileRows(nObs: number, dims: number): number {
  const perRow = Math.max(1, nObs * dims * 4 * 3);
  return Math.max(MIN_TILE_ROWS, Math.min(MAX_TILE_ROWS, Math.floor(TILE_BUDGET_BYTES / perRow)));
}

/** A t-SNE repulsion step that runs on the GPU through jax-js (or its WASM fallback). */
export interface GpuRepulsion extends Repulsion {
  /** Which backend actually initialised: callers surface this, since it changes the wait. */
  readonly backend: 'webgpu' | 'wasm';
}

/**
 * Build a GPU-backed repulsion, or throw if jax-js cannot start at all.
 *
 * Throwing rather than silently returning the plain loop: at these sizes the plain loop is
 * hours, so falling back to it quietly would look like a hang. The caller decides what to
 * do with the failure.
 */
export async function createGpuRepulsion(): Promise<GpuRepulsion> {
  const jax = await import('@jax-js/jax');
  const np = jax.numpy;

  // Ask for WebGPU first. In Node this silently yields cpu+wasm, which is why the result
  // is read back rather than assumed — reporting "webgpu" for a Wasm run would misexplain
  // every timing that follows.
  let backend: 'webgpu' | 'wasm' = 'wasm';
  try {
    const devices = await jax.init('webgpu');
    if (Array.isArray(devices) && devices.includes('webgpu')) backend = 'webgpu';
  } catch {
    /* fall through to wasm */
  }
  if (backend !== 'webgpu') await jax.init('wasm');

  return {
    backend,
    async compute(y: Float64Array, nObs: number, dims: number) {
      const flat = new Float32Array(y.length);
      for (let i = 0; i < y.length; i++) flat[i] = y[i];
      // `{ shape, dtype }` is the typed signature — a positional dtype works at runtime
      // but is not what the types describe — and `DType` is a real enum, not a string
      // union, so the member is required rather than the literal it equals.
      const Y = np.array(flat, { shape: [nObs, dims], dtype: jax.DType.Float32 });

      const rep = new Float64Array(nObs * dims);
      let z = 0;
      const tile = tileRows(nObs, dims);
      for (let s = 0; s < nObs; s += tile) {
        const rows = Math.min(tile, nObs - s);
        const yb = Y.ref.slice([s, s + rows]);
        // (rows, 1, dims) - (1, nObs, dims), broadcast to every pair in the tile.
        const diff = np.subtract(
          np.reshape(yb, [rows, 1, dims]),
          np.reshape(Y.ref, [1, nObs, dims]),
        );
        const w = np.divide(1, np.add(1, np.sum(np.square(diff.ref), 2)));
        // Z counts ordered pairs i≠j. The diagonal contributes w_ii = 1 per row and is
        // removed by subtracting the row count — masking it would cost another
        // full-size tensor for the same answer.
        z += Number(await np.sum(w.ref).item()) - rows;
        const weighted = np.multiply(np.reshape(np.square(w), [rows, nObs, 1]), diff);
        const contrib = await np.sum(weighted, 1).data();
        for (let r = 0; r < rows; r++) {
          for (let d = 0; d < dims; d++) rep[(s + r) * dims + d] = contrib[r * dims + d];
        }
      }
      (Y as { dispose?: () => void }).dispose?.();
      return { rep, z };
    },
  };
}
