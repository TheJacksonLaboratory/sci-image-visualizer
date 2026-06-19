/**
 * Factory for the mask-export Web Worker, isolated in its own module so the
 * `import.meta.url` reference (required by the bundler to locate the worker) is
 * never pulled into the ts-jest CommonJS compile of the component — the unit
 * tests `jest.mock` this module instead.
 */
export function createMaskWorker(): Worker {
  return new Worker(new URL('./mask.worker', import.meta.url), { type: 'module' });
}
