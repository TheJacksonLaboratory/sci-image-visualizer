/**
 * Factory for the t-SNE Web Worker, isolated in its own module so the `import.meta.url`
 * reference — which the bundler needs in order to locate the worker — is never pulled
 * into the ts-jest CommonJS compile of anything that uses it. Unit tests `jest.mock` this
 * module, or pass their own factory. Same arrangement as `mask-worker.ts`.
 */
export function createTsneWorker(): Worker {
  return new Worker(new URL('./tsne.worker', import.meta.url), { type: 'module' });
}
