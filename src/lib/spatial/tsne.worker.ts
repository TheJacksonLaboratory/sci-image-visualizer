/// <reference lib="webworker" />
import { createGpuRepulsion } from './tsne-gpu';
import { plainRepulsion, tsneEmbed } from './tsne';

/**
 * t-SNE Web Worker.
 *
 * A t-SNE run is seconds to minutes — 95 s for 2,688 points, an hour for 19,416 — so it
 * cannot share a thread with the UI. Not merely "should not": the work is a tight
 * numerical loop with no natural yield point, so on the main thread the tab would be
 * unresponsive for the whole run, including the progress bar meant to show it working.
 *
 * WebGPU is available inside a worker (verified in Firefox: `navigator.gpu` and
 * `requestAdapter()` both resolve here), so moving off the main thread costs no
 * acceleration.
 *
 * The input is PCA scores, not expression. That is what makes this practical: the scores
 * for a whole-transcriptome dataset are 0.51 MB against 185 MB for the matrix they came
 * from, so the server reduces and the browser embeds.
 */

interface StartMessage {
  type: 'start';
  scores: ArrayBuffer;
  nObs: number;
  nDims: number;
  dims: 2 | 3;
  perplexity: number;
  iterations: number;
  seed: number;
}

type Incoming = StartMessage | { type: 'cancel' };

let cancelled = false;

self.onmessage = async (event: MessageEvent<Incoming>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (message.type !== 'start') return;

  cancelled = false;
  const { scores, nObs, nDims, dims, perplexity, iterations, seed } = message;
  const x = new Float32Array(scores);

  try {
    // The plain loop is the fallback, not a silent one: which backend ran is reported, so
    // a slow run has a visible reason rather than looking like a bad machine.
    let repulsion;
    let backend: string;
    try {
      const gpu = await createGpuRepulsion();
      repulsion = gpu;
      backend = gpu.backend;
    } catch (err) {
      repulsion = plainRepulsion;
      backend = 'cpu';
      self.postMessage({
        type: 'warning',
        message: `GPU acceleration unavailable (${(err as Error)?.message ?? err}); `
          + 'falling back to a plain loop, which is far slower at this size.',
      });
    }
    self.postMessage({ type: 'backend', backend });

    const result = await tsneEmbed(x, nObs, nDims, {
      dims,
      perplexity,
      iterations,
      seed,
      repulsion,
      onProgress: (done, total) => self.postMessage({ type: 'progress', done, total }),
      shouldStop: () => cancelled,
    });

    if (!result.completed) {
      self.postMessage({ type: 'cancelled' });
      return;
    }
    // The coordinates are f32 on the wire: the embedding is drawn, not measured, and this
    // halves a transfer that can be megabytes. Sent as a transferable so it is moved
    // rather than structured-cloned.
    const out = new Float32Array(result.embedding.length);
    for (let i = 0; i < out.length; i++) out[i] = result.embedding[i];
    self.postMessage(
      {
        type: 'done',
        embedding: out.buffer,
        dims,
        perplexity: result.perplexity,
        neighbours: result.neighbours,
      },
      { transfer: [out.buffer] },
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: (err as Error)?.message ?? String(err) });
  }
};
