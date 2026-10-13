/**
 * Factory for the region-source Web Worker, isolated in its own module so the `import.meta.url`
 * reference — which the bundler needs in order to locate the worker — is never pulled into the
 * ts-jest CommonJS compile of anything that uses it. Same arrangement as
 * `workers/spatial-math-worker.ts`.
 */
export function createRegionSourceWorker(): Worker {
  return new Worker(new URL('./region-source.worker', import.meta.url), { type: 'module' });
}
