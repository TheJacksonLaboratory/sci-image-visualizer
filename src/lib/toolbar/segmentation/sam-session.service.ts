import { Injectable } from '@angular/core';

import type { CachedImageData } from '../wand/wand-tool.service';
import { frameToRgba } from './sam-prompt';
import { getSamModel, isSamModelReady } from './sam-model-registry';
import { ISamSession, SamEmbedding, SamModelDef } from '../../contracts/sam.contract';

/** Creates an unloaded inference session. */
export type SamSessionFactory = () => Promise<ISamSession>;

/** Lazy-import so onnxruntime-web is never pulled into unit tests or the
 *  initial bundle — only when segmentation actually runs. */
const onnxSessionFactory: SamSessionFactory = async () => {
  const { OnnxSamSession } = await import('./onnx-sam-session');
  return new OnnxSamSession();
};

/** Thrown inside a load that a model switch superseded. */
class SupersededLoad extends Error {}

/**
 * The one SAM inference session for the active model, shared by the box- and
 * point-prompt tools (RT-10): one download, one Worker/GPU session and one
 * cached image embedding instead of one per tool.
 *
 * - Concurrent {@link ensureSession} calls share a single load, and each caller
 *   receives its download progress.
 * - A load that fails disposes its half-built session (and Worker) and is not
 *   cached; the next call retries (RT-7).
 * - {@link setModel} during a load discards that load's session, and the
 *   waiting callers get the newly picked model instead (RT-9).
 */
@Injectable({ providedIn: 'root' })
export class SamSessionService {
  private model: SamModelDef = getSamModel();
  private session: ISamSession | null = null;
  private loading: Promise<ISamSession> | null = null;
  /** Bumped on every model switch; a load started under an older value is stale. */
  private generation = 0;
  private readonly progressListeners = new Set<(fraction: number) => void>();
  private createSession: SamSessionFactory = onnxSessionFactory;

  /** Cached encoder embedding + the key (image identity + model) it was computed for. */
  private embedding: SamEmbedding | null = null;
  private embeddingKey: string | null = null;

  /** The model the next run uses. */
  getModel(): SamModelDef {
    return this.model;
  }

  /** True when a session is loaded (or injected) for the current model. */
  hasSession(): boolean {
    return this.session !== null;
  }

  /** Choose the registered model; drops the loaded session and cached embedding. */
  setModel(id: string): void {
    const next = getSamModel(id);
    if (next.id === this.model.id) return;
    this.model = next;
    this.generation++;
    this.loading = null;
    this.invalidateEmbedding();
    this.session?.dispose();
    this.session = null;
  }

  /** Drop the cached embedding (e.g. after the image/slice changes). */
  invalidateEmbedding(): void {
    this.embedding = null;
    this.embeddingKey = null;
  }

  /** Test seam: use this session (already loaded) for the current model. */
  useSession(session: ISamSession): void {
    this.session = session;
  }

  /** Test seam: how sessions are created (default: lazy onnxruntime-web). */
  useSessionFactory(factory: SamSessionFactory): void {
    this.createSession = factory;
  }

  /**
   * The loaded session for the current model, loading it if needed.
   * `onProgress` receives the download fraction while this call waits.
   */
  async ensureSession(onProgress?: (fraction: number) => void): Promise<ISamSession> {
    if (this.session) return this.session;
    if (!isSamModelReady(this.model)) {
      throw new Error(
        `SAM model "${this.model.id}" is not configured yet (no ONNX URLs). ` +
        'Host it and call setSamModelUrls(), then retry.',
      );
    }
    if (onProgress) {
      this.progressListeners.add(onProgress);
      onProgress(0);
    }
    try {
      return await (this.loading ??= this.load());
    } catch (err) {
      if (err instanceof SupersededLoad) return this.ensureSession(onProgress);
      throw err;
    } finally {
      if (onProgress) this.progressListeners.delete(onProgress);
    }
  }

  /**
   * The encoder embedding of a cached frame, reused while `key` (the image's
   * identity: file, frame, readback frame) and the model are unchanged.
   * `onEncode` is called only when the encoder actually runs.
   */
  async embed(session: ISamSession, cached: CachedImageData, frameIndex: number, key: string,
              onEncode?: () => void): Promise<SamEmbedding> {
    const fullKey = `${key}|${this.model.id}`;
    if (this.embedding && this.embeddingKey === fullKey) return this.embedding;
    onEncode?.();
    const generation = this.generation;
    const embedding = await session.embed({
      data: frameToRgba(cached, frameIndex), width: cached.width, height: cached.height,
    });
    if (generation === this.generation) {
      this.embedding = embedding;
      this.embeddingKey = fullKey;
    }
    return embedding;
  }

  private load(): Promise<ISamSession> {
    const generation = this.generation;
    const model = this.model;
    const load = (async () => {
      const session = await this.createSession();
      try {
        await session.loadModel(model, (f) => this.progressListeners.forEach((l) => l(f)));
      } catch (err) {
        session.dispose(); // don't leak the half-built session / Worker
        throw err;
      }
      if (generation !== this.generation) {
        session.dispose(); // the user picked another model meanwhile
        throw new SupersededLoad();
      }
      this.session = session;
      return session;
    })();
    load.catch(() => undefined).finally(() => {
      if (this.loading === load) this.loading = null;
    });
    return load;
  }
}
