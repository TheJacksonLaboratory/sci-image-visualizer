import { PlotType, PlotTypeId, isBuiltinPlotType } from '../contracts/plot-type';
import {
  ContributedPlotTypeDescriptor,
  PlotModeContext,
  PlotModeSession,
  PlotTypeContribution,
} from '../contracts/plot-type-contribution.contract';

/**
 * Lifecycle of the contributed plot modes ({@link PlotTypeContribution}) for one
 * visualizer instance. Package-internal: the visualizer component owns one and
 * drives it from its render pipeline.
 *
 * Owns three things the component should not have to reason about:
 *  - which contributions are usable (validated and de-duplicated once);
 *  - the single live session, so `deactivate()` runs exactly once per session
 *    however many exits race each other (type change, image change, destroy,
 *    a superseded async activation);
 *  - isolation: nothing a contribution throws or rejects escapes this class.
 *    A failure is logged and reported through `onFailed`, and the component
 *    falls back to the mode's base type.
 */

/** The live activation of a contributed mode, as the component renders it. */
export interface ActivePlotMode {
  readonly contribution: PlotTypeContribution;
  readonly ctx: PlotModeContext;
  readonly session: PlotModeSession;
  /** Host element handed to a `mount` panel, or null for a component / no panel. */
  readonly panelHost: HTMLElement | null;
}

export interface PlotModeControllerHooks {
  /** A session is live (and a `mount` panel, if any, has been mounted). */
  onActivated(active: ActivePlotMode): void;
  /** The live session is about to end. Called BEFORE any teardown, so a
   *  component panel can be destroyed while its session is still valid. */
  onDeactivating(active: ActivePlotMode): void;
  /** Activation failed (threw, rejected, never got a ready viewport, or its
   *  panel failed to mount). The component falls back to the base type. */
  onFailed(contribution: PlotTypeContribution, error: unknown): void;
}

/** Minimal logger, injectable for tests. */
export interface PlotModeLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Base types a contributed mode can ride on in this version. */
export const SUPPORTED_CONTRIBUTION_BASE_TYPES: readonly PlotType[] = [PlotType.IMAGE];

/** How many animation frames to wait for the viewport before giving up. */
const MAX_READY_FRAMES = 180;

const TAG = '[visualizer] plot-type contribution';

/**
 * Validate what arrived on `PLOT_TYPE_CONTRIBUTIONS`. A malformed or clashing
 * contribution is dropped with a warning rather than breaking the selector:
 *  - a nested array (`useValue: [a, b], multi: true`) is flattened one level;
 *  - `type` must be a non-empty string that is not a built-in `PlotType` value;
 *  - the first contribution with a given `type` wins;
 *  - `baseType` must be one of {@link SUPPORTED_CONTRIBUTION_BASE_TYPES};
 *  - `activate` must be a function.
 */
export function normalizeContributions(
  raw: readonly unknown[] | null | undefined,
  log: PlotModeLogger = console,
): PlotTypeContribution[] {
  const out: PlotTypeContribution[] = [];
  const seen = new Set<string>();
  const flat = (raw ?? []).flatMap((c) => (Array.isArray(c) ? c : [c]));
  for (const c of flat as PlotTypeContribution[]) {
    const d = c?.descriptor as ContributedPlotTypeDescriptor | undefined;
    const id = d?.type;
    if (!d || typeof id !== 'string' || !id || typeof c.activate !== 'function') {
      log.warn(`${TAG} ignored: it needs a descriptor with a string \`type\` and an \`activate\` function.`, c);
      continue;
    }
    if (isBuiltinPlotType(id)) {
      log.warn(`${TAG} '${id}' ignored: the id clashes with a built-in plot type.`);
      continue;
    }
    if (seen.has(id)) {
      log.warn(`${TAG} '${id}' ignored: another contribution already uses that id.`);
      continue;
    }
    if (!SUPPORTED_CONTRIBUTION_BASE_TYPES.includes(d.baseType)) {
      log.warn(`${TAG} '${id}' ignored: baseType '${String(d.baseType)}' is not supported `
        + `(supported: ${SUPPORTED_CONTRIBUTION_BASE_TYPES.join(', ')}).`);
      continue;
    }
    seen.add(id);
    out.push(c);
  }
  return out;
}

export class PlotModeController {
  readonly contributions: readonly PlotTypeContribution[];
  private readonly byId: ReadonlyMap<string, PlotTypeContribution>;

  private active: ActivePlotMode | null = null;
  private teardown: (() => void) | null = null;
  /** Bumped by every activate/deactivate, so a pending async activation can
   *  tell it has been superseded. */
  private generation = 0;
  private readyFrame: number | null = null;
  private readyCb: ((ready: boolean) => void) | null = null;

  constructor(
    raw: readonly unknown[] | null | undefined,
    private readonly hooks: PlotModeControllerHooks,
    private readonly log: PlotModeLogger = console,
  ) {
    this.contributions = normalizeContributions(raw, log);
    this.byId = new Map(this.contributions.map((c) => [c.descriptor.type, c]));
  }

  /** Descriptors of the usable contributions, in registration order. */
  descriptors(): ContributedPlotTypeDescriptor[] {
    return this.contributions.map((c) => c.descriptor);
  }

  /** The contribution for a selector id, if it is a contributed mode. */
  find(id: PlotTypeId | null | undefined): PlotTypeContribution | undefined {
    return typeof id === 'string' ? this.byId.get(id) : undefined;
  }

  /**
   * The built-in type that renders `id`: a built-in type is itself, a
   * contributed id is its `baseType`, and an id that is neither (a stale
   * contributed id whose provider is gone) resolves to `PlotType.IMAGE`, the
   * default view.
   */
  baseTypeOf(id: PlotTypeId | null | undefined): PlotType {
    if (isBuiltinPlotType(id)) return id;
    return this.find(id)?.descriptor.baseType ?? PlotType.IMAGE;
  }

  /** The live session, if any. */
  get current(): ActivePlotMode | null {
    return this.active;
  }

  /** Whether an activation is waiting on the contribution or the viewport. */
  get pending(): boolean {
    return this.pendingId !== null;
  }
  private pendingId: string | null = null;

  /**
   * Start a session for `contribution`. Ends any live one first. Resolves when
   * the attempt has finished (successfully or not); it never rejects.
   */
  activate(contribution: PlotTypeContribution, ctx: PlotModeContext): Promise<void> {
    this.deactivate();
    const gen = ++this.generation;
    this.pendingId = contribution.descriptor.type;
    return new Promise<void>((resolve) => {
      this.whenReady(ctx, gen, (ready) => {
        if (gen !== this.generation) return resolve();
        if (!ready) {
          this.fail(contribution, new Error('the viewport never became ready'));
          return resolve();
        }
        let result: PlotModeSession | Promise<PlotModeSession>;
        try {
          result = contribution.activate(ctx);
        } catch (err) {
          this.fail(contribution, err);
          return resolve();
        }
        if (isThenable(result)) {
          result.then(
            (session) => { this.start(contribution, ctx, session, gen); resolve(); },
            (err) => {
              if (gen === this.generation) this.fail(contribution, err);
              resolve();
            },
          );
        } else {
          this.start(contribution, ctx, result, gen);
          resolve();
        }
      });
    });
  }

  /**
   * End the live session, if any: the component panel is dropped (via
   * `onDeactivating`), a `mount` panel's teardown runs, then
   * `session.deactivate()`, then the mount host is removed. Each step is
   * isolated. A pending activation is cancelled; if it resolves later its
   * session is deactivated on arrival. Idempotent.
   */
  deactivate(): void {
    this.generation++;
    this.pendingId = null;
    this.cancelReadyWait();
    const a = this.active;
    if (!a) return;
    this.active = null;
    const teardown = this.teardown;
    this.teardown = null;
    const id = a.contribution.descriptor.type;
    this.guard(`'${id}' panel removal`, () => this.hooks.onDeactivating(a));
    if (teardown) this.guard(`'${id}' panel teardown`, teardown);
    this.guard(`'${id}' deactivate()`, () => a.session.deactivate());
    a.panelHost?.remove();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private start(contribution: PlotTypeContribution, ctx: PlotModeContext,
                session: PlotModeSession, gen: number): void {
    const id = contribution.descriptor.type;
    if (!session || typeof session.deactivate !== 'function') {
      if (gen === this.generation) {
        this.fail(contribution, new Error('activate() did not return a PlotModeSession'));
      }
      return;
    }
    if (gen !== this.generation) {
      // Superseded while activate() was in flight — the user already left. The
      // session still gets its single deactivate(), just late.
      this.guard(`'${id}' deactivate()`, () => session.deactivate());
      return;
    }
    this.pendingId = null;
    const panel = contribution.panel;
    let panelHost: HTMLElement | null = null;
    let teardown: (() => void) | null = null;
    if (panel && 'mount' in panel && typeof panel.mount === 'function') {
      panelHost = document.createElement('div');
      panelHost.className = 'plot-mode-panel-host';
      try {
        const t = panel.mount(panelHost, ctx, session);
        teardown = typeof t === 'function' ? t : null;
      } catch (err) {
        panelHost.remove();
        this.guard(`'${id}' deactivate()`, () => session.deactivate());
        this.fail(contribution, err);
        return;
      }
    }
    this.active = { contribution, ctx, session, panelHost };
    this.teardown = teardown;
    this.guard(`'${id}' panel`, () => this.hooks.onActivated(this.active!));
  }

  private fail(contribution: PlotTypeContribution, err: unknown): void {
    this.pendingId = null;
    this.log.error(`${TAG} '${contribution.descriptor.type}' failed to activate — `
      + `falling back to '${contribution.descriptor.baseType}'.`, err);
    try {
      this.hooks.onFailed(contribution, err);
    } catch (hookErr) {
      this.log.error(`${TAG} fallback failed.`, hookErr);
    }
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log.error(`${TAG} ${what} threw.`, err);
    }
  }

  /** Call `cb(true)` once the viewport reports ready (now, or on a later
   *  animation frame), or `cb(false)` after {@link MAX_READY_FRAMES}. */
  private whenReady(ctx: PlotModeContext, gen: number, cb: (ready: boolean) => void): void {
    const isReady = () => {
      try { return ctx.viewport.isReady(); } catch { return false; }
    };
    if (isReady()) return cb(true);
    let frames = 0;
    const settle = (ready: boolean) => {
      this.readyFrame = null;
      this.readyCb = null;
      cb(ready);
    };
    const tick = () => {
      this.readyFrame = null;
      if (gen !== this.generation) return settle(false);
      if (isReady()) return settle(true);
      if (++frames >= MAX_READY_FRAMES) return settle(false);
      this.readyFrame = requestAnimationFrame(tick);
    };
    this.readyCb = settle;
    this.readyFrame = requestAnimationFrame(tick);
  }

  /** Stop waiting for the viewport; the waiting activation resolves as superseded. */
  private cancelReadyWait(): void {
    if (this.readyFrame !== null) cancelAnimationFrame(this.readyFrame);
    this.readyFrame = null;
    const cb = this.readyCb;
    this.readyCb = null;
    cb?.(false);
  }
}

function isThenable<T>(v: T | Promise<T>): v is Promise<T> {
  return !!v && typeof (v as Promise<T>).then === 'function';
}
