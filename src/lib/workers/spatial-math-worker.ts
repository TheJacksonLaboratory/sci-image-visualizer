/**
 * Factory for the spatial-math Web Worker, isolated in its own module so the
 * `import.meta.url` reference — which the bundler needs in order to locate the worker —
 * is never pulled into the ts-jest CommonJS compile of anything that uses it. Same
 * arrangement as `spatial/tsne-worker.ts` and `region-editor/mask-worker.ts`.
 */
export function createSpatialMathWorker(): Worker {
  return new Worker(new URL('./spatial-math.worker', import.meta.url), { type: 'module' });
}
