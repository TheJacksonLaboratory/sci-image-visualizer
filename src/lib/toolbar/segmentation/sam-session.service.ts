import { Inject, Injectable, OnDestroy, Optional } from '@angular/core';

import type { CachedImageData } from '../wand/wand-tool.service';
import { frameToRgba } from './sam-prompt';
import { getSamModel, isSamModelReady } from './sam-model-registry';
import { ISamSession, SamEmbedding, SamModelDef } from '../../contracts/sam.contract';
import { MODEL_RESIDENCY, ModelResidency, modelResidency } from '../../models/model-residency';

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
 *
 * Scope: root, on purpose, and deliberately NOT in `provideVisualization()`. The
 * chain-scoped SAM tools of a second viewer (jit-ui's pipeline preview) resolve
 * this root instance, so the model (14–172 MB) is downloaded and its Worker/GPU
 * session built once per app, not once per viewer, and the embedding cache is
 * keyed by image + model so viewers don't confuse each other's images. The cost
 * is that a model picked in one viewer is the model of all of them. A host that
 * wants a session per viewer can provide this service at the viewer's component:
 * {@link ngOnDestroy} then disposes that viewer's session (and Worker) with it.
 *
 * Takes part in {@link ModelResidency}: {@link ensureSession} releases any other
 * loaded model before SAM loads, and the session registers so it is released
 * in turn when another model is used.
 */
@Injectable({ providedIn: 'root' })
export class SamSessionService implements OnDestroy {
  private model: SamModelDef = getSamModel();
  private session: ISamSession | null = null;
  private loading: Promise<ISamSession> | null = null;
  /** Bumped on every model switch; a load started under an older value is stale. */
  private generation = 0;
  private readonly progressListeners = new Set<(fraction: number) => void>();
  private createSession: SamSessionFactory = onnxSessionFactory;

  /** Set by {@link ngOnDestroy}: no session is loaded any more. */
  private destroyed = false;

  /** Cached encoder embedding + the key (image identity + model) it was computed for. */
  private embedding: SamEmbedding | null = null;
  private embeddingKey: string | null = null;
  private readonly residency: ModelResidency;
  /**
   * Distinguishes independently owned instances (one per viewer when a host
   * provides the service at the component), so two sessions of the same
   * checkpoint are two resident models rather than one id overwriting the other.
   */
  private static instances = 0;
  private readonly instance = ++SamSessionService.instances;

  constructor(@Optional() @Inject(MODEL_RESIDENCY) residency: ModelResidency | null = null) {
    this.residency = residency ?? modelResidency;
  }

  /** The current model's id in the {@link ModelResidency} registry (unique per service instance). */
  residencyId(model: SamModelDef = this.model): string {
    return `sam:${model.id}#${this.instance}`;
  }

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
    this.residency.unregister(this.residencyId());
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
   *
   * The load is a tracked {@link ModelResidency} use: any other large model is
   * released first, and a switch away from SAM waits for the load. To keep SAM
   * held while the session is then used, prefer {@link withSession}.
   */
  async ensureSession(onProgress?: (fraction: number) => void): Promise<ISamSession> {
    if (this.destroyed) throw new Error('The SAM session was disposed with its viewer.');
    return this.residency.use(this.residencyId(), () => this.acquire(onProgress));
  }

  /**
   * Run `fn` as ONE {@link ModelResidency} use of SAM — from acquiring the
   * session through every encode and decode — so a switch to another model
   * cannot dispose the session mid-run. `fn` gets `acquire`, which loads the
   * session (reporting progress) without opening a second use.
   */
  withSession<T>(
    fn: (acquire: (onProgress?: (fraction: number) => void) => Promise<ISamSession>) => Promise<T>,
  ): Promise<T> {
    return this.residency.use(this.residencyId(), () => fn((onProgress) => this.acquire(onProgress)));
  }

  /** Load (or reuse) the session. Callers hold a residency use around it. */
  private async acquire(onProgress?: (fraction: number) => void): Promise<ISamSession> {
    for (;;) {
      // Checked again here, after the residency switch: the viewer may have
      // been destroyed while it waited, and must not start a fresh load.
      if (this.destroyed) throw new Error('The SAM session was disposed with its viewer.');
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
        // Superseded by a model switch (or teardown): go round again.
        if (!(err instanceof SupersededLoad)) throw err;
      } finally {
        if (onProgress) this.progressListeners.delete(onProgress);
      }
    }
  }

  /**
   * The encoder embedding of a cached frame, reused while `key` (the image's
   * identity: file, frame, readback frame) and the model are unchanged.
   * `onEncode` is called only when the encoder actually runs.
   */
  async embed(
    session: ISamSession,
    cached: CachedImageData,
    frameIndex: number,
    key: string,
    onEncode?: () => void,
  ): Promise<SamEmbedding> {
    const fullKey = `${key}|${this.model.id}`;
    if (this.embedding && this.embeddingKey === fullKey) return this.embedding;
    onEncode?.();
    const generation = this.generation;
    // Not a residency use of its own: callers hold one across the whole run
    // (see withSession), so the session cannot be released mid-encode.
    const embedding = await session.embed({
      data: frameToRgba(cached, frameIndex),
      width: cached.width,
      height: cached.height,
    });
    if (generation === this.generation) {
      this.embedding = embedding;
      this.embeddingKey = fullKey;
    }
    return embedding;
  }

  /**
   * Dispose the session (and its Worker), drop the embedding and discard an
   * in-flight load. Angular calls this when the injector providing the service
   * is destroyed: the app for the root instance, or a viewer component that
   * provides its own.
   */
  ngOnDestroy(): void {
    this.residency.unregister(this.residencyId());
    this.destroyed = true;
    this.generation++; // an in-flight load disposes its session when it lands
    this.loading = null;
    this.invalidateEmbedding();
    this.session?.dispose();
    this.session = null;
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
      this.residency.register({ id: this.residencyId(model), release: () => this.release(session) });
      return session;
    })();
    load
      .catch(() => undefined)
      .finally(() => {
        if (this.loading === load) this.loading = null;
      });
    return load;
  }

  /** Residency release: drop the session so the next use rebuilds it. */
  private release(session: ISamSession): void {
    if (this.session !== session) return; // already replaced (model switch)
    this.session = null;
    this.invalidateEmbedding();
    session.dispose();
  }
}
