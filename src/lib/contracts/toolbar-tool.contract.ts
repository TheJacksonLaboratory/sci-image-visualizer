/**
 * How a tool gets into the toolbar without this library knowing what it is.
 *
 * WHY THIS EXISTS
 * The YOLO detector and the retinal-layer segmenter used to be built in: their
 * buttons were hardcoded in the toolbar template, their model registries named
 * JAX checkpoints, and the `INSTANCE_SEGMENTER` / `SEMANTIC_SEGMENTER` tokens
 * defaulted to in-library services that imported `yolo-segdetect-js` and
 * `jax-ai-js`. Those default factories were the only thing pulling either
 * package into the bundle — the contracts themselves were already clean.
 *
 * That arrangement cannot ship in an open library while the models are closed.
 * So the tools move out, into a package that depends on this one, and arrive
 * back through {@link TOOLBAR_TOOLS}. This library keeps the contracts, the
 * chrome and the region plumbing; it no longer knows that YOLO exists.
 *
 * A host registers tools with a multi-provider:
 *
 *     { provide: TOOLBAR_TOOLS, useExisting: YoloToolContribution, multi: true }
 *
 * Register nothing and the toolbar has no segmentation tools, the help dialog
 * lists none, and neither model package is in the graph.
 *
 * WHY PARAMS ARE DECLARED, NOT RENDERED
 * A contribution describes its parameters ({@link ToolParamSpec}) instead of
 * supplying a component to draw them. The toolbar renders one generic dialog
 * from that description. The alternative — each plugin shipping its own dialog
 * component — would make every plugin depend on this library's exact PrimeNG
 * version and styling internals to look like the rest of the toolbar, and the
 * two dialogs that exist today are entirely numbers and one checkbox. A schema
 * covers them, and it is the same shape jit-ui already uses for its pipeline
 * step parameters, so the vocabulary is familiar.
 *
 * If a tool ever needs a control this cannot express, add a variant here rather
 * than an escape hatch that returns a component — the moment one tool draws
 * itself, the toolbar stops being able to lay tools out consistently.
 *
 * DIALOG TOOLS
 * Some tools are not "set parameters, run once" but an interactive session: the
 * user paints, the tool retrains and redraws, over and over (DIANNE). A schema
 * cannot describe that, so {@link ToolbarDialogToolContribution} is the one
 * variant that renders its own body. The toolbar still owns the button, its
 * placement and the dialog chrome; the tool only fills the dialog, with plain
 * DOM (`mount`), so it needs neither Angular nor this library's PrimeNG version.
 * Its button sits with the host's own actions at the start of the toolbar, and
 * shows only in the Image view, the view its context ({@link ToolDialogContext})
 * draws over.
 *
 * WHY AN EMPTY MODEL LIST HIDES THE TOOL
 * {@link ToolbarToolContribution.models} returning `[]` removes the tool from
 * the toolbar entirely. This preserves the behaviour the built-in tools already
 * had (their buttons were `*ngIf`'d on a filtered registry), and it gives a host
 * one switch for "the weights are not configured in this deployment" that does
 * not require unregistering the provider.
 */
import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';

import type { IVisualizer } from './visualizer.contract';
import type { PlotModeContext, PlotModeSession, PlotModeTools } from './plot-type-contribution.contract';

/** A number field. Rendered as a stepper, matching the built-in dialogs. */
export interface NumberParamSpec {
  id: string;
  label: string;
  type: 'number';
  min?: number;
  max?: number;
  step?: number;
  /** Decimal places to show. Omit for integers. */
  fractionDigits?: number;
  /** Hover help. Plain text; it is not rendered as HTML. */
  tooltip?: string;
}

/** A checkbox. `label` sits beside it and may run to a sentence or two. */
export interface BooleanParamSpec {
  id: string;
  label: string;
  type: 'boolean';
  tooltip?: string;
}

/** A fixed set of choices. */
export interface SelectParamSpec {
  id: string;
  label: string;
  type: 'select';
  options: { label: string; value: string | number }[];
  tooltip?: string;
}

export type ToolParamSpec = NumberParamSpec | BooleanParamSpec | SelectParamSpec;

/** One selectable checkpoint. */
export interface ToolModelOption {
  id: string;
  label: string;
  /**
   * Describes the checkpoint in the picker's hover tooltip — size, speed,
   * training domain, accuracy. **Rendered as HTML**, so it is trusted content
   * from the contributing package, never anything user-supplied.
   */
  info?: string;
  /**
   * Parameter values this checkpoint wants, merged over
   * {@link ToolbarToolContribution.defaultParams} when it is selected. Defaults
   * belong to the model rather than the tool — a detector trained on native 40x
   * patches wants different tiling from one trained on thumbnails.
   */
  defaults?: Record<string, unknown>;
}

/**
 * The `status$` / `busy$` / `progress$` surface the toolbar drives its sticky
 * toast and progress bar from. `progress$` is a 0..1 fraction, or -1 for
 * indeterminate.
 */
export interface ToolProgress {
  status$: Observable<string>;
  busy$: Observable<boolean>;
  progress$: Observable<number>;
}

/** Toolbar icon: a published asset, or a PrimeIcon class name. */
export type ToolIcon = { src: string; pi?: never } | { pi: string; src?: never };

/**
 * A tool contributed to the toolbar.
 *
 * Implement it on an `@Injectable()` service in the contributing package, so it
 * can inject its own segmenter and model registry — this library provides
 * neither and must not learn to.
 */
export interface ToolbarToolContribution {
  /** Stable identity, used for tracking and persisted preferences. */
  id: string;
  /** Short name, used in the toast and the help dialog heading. */
  label: string;
  icon: ToolIcon;

  /** Tooltip on the run button — say what it does to the current view. */
  runTooltip: string;
  /** Tooltip on the checkpoint picker. Defaults to "Pick the model". */
  modelTooltip?: string;
  /** Tooltip on the parameters button. Defaults to "Parameters". */
  paramsTooltip?: string;

  /**
   * Where it sits among the segmentation tools. Lower sorts first; ties fall
   * back to registration order. The built-in prompted tools occupy 0-99, so
   * contributed tools should start at 100 to land after them.
   */
  order?: number;

  /** Selectable checkpoints. **Empty hides the tool.** */
  models(): ToolModelOption[];
  /** Which checkpoint runs when the user has not chosen. */
  defaultModelId(): string;
  /**
   * Called when the user picks a checkpoint, before parameters are re-seeded.
   * Use it to record the choice in the contributing package's own registry.
   */
  onModelChange?(modelId: string): void;

  /** Parameter fields, in dialog order. Empty hides the parameters button. */
  params: ToolParamSpec[];
  /**
   * Baseline parameter values for a checkpoint. Called on first use and again
   * on "Reset to model defaults", so it must be pure and must return every key
   * the tool reads — a parameter the dialog shows but this omits renders as
   * empty and reaches `run` as undefined.
   */
  defaultParams(modelId: string): Record<string, unknown>;

  /**
   * Entry for the help dialog's tool list. `body` is rendered as HTML and may
   * reference published assets (e.g. the tool's own icon).
   */
  help?: { body: string };

  /** Progress surface for the toast. */
  progress: ToolProgress;

  /**
   * Run over what is currently displayed, and write whatever it finds through
   * `viz`. Resolves with the number of regions added.
   *
   * Everything the tool needs is on {@link IVisualizer}, which is part of this
   * library's public surface — a contribution never reaches into internals.
   * Region writes go through the same path the built-in tools use, so the
   * index-based overlays and the Regions table stay consistent.
   */
  run(viz: IVisualizer, params: Record<string, unknown>): Promise<number>;
}

/**
 * What a dialog tool gets while its dialog is open: the same surface a
 * contributed plot mode gets (the public visualizer, the Image view's viewport
 * and the current image), with the toolbar tools always present.
 */
export type ToolDialogContext = PlotModeContext & { tools: PlotModeTools };

/** A live dialog-tool session. `deactivate()` runs exactly once, after the body's teardown. */
export type ToolDialogSession = PlotModeSession;

/**
 * A toolbar tool that opens a dialog instead of running once (see DIALOG TOOLS
 * above). Clicking its button opens the dialog and starts a session; clicking it
 * again, or closing the dialog, ends it.
 *
 * The session is bound to the Image view on screen. When that view is re-rendered
 * (another image, another slice) the session ends and, with the dialog still
 * open, a fresh one starts once the new view is ready. Leaving the Image view
 * closes the dialog. As with plot modes, nothing the tool throws or rejects
 * escapes: a failed start closes the dialog with a warning.
 */
export interface ToolbarDialogToolContribution {
  kind: 'dialog';
  /** Stable identity. Must not clash with another toolbar tool. */
  id: string;
  /** Short name; the dialog title unless `dialog.title` is set. */
  label: string;
  icon: ToolIcon;
  /** Tooltip on the button. */
  tooltip: string;
  /** Order among the dialog tools. Lower sorts first; ties keep registration order. */
  order?: number;
  dialog?: {
    title?: string;
    /** CSS width of the dialog. Default `'22rem'`. */
    width?: string;
  };
  /** Entry for the help dialog's tool list, rendered as HTML (trusted content). */
  help?: { body: string };
  /** Start a session, once the Image view's viewport is ready. */
  activate(ctx: ToolDialogContext): ToolDialogSession | Promise<ToolDialogSession>;
  /** Render the dialog body into `host`; return its teardown (called before `deactivate()`). */
  mount(host: HTMLElement, ctx: ToolDialogContext, session: ToolDialogSession): () => void;
}

/** Anything provided on {@link TOOLBAR_TOOLS}. A run tool has no `kind`. */
export type ToolbarContribution = ToolbarToolContribution | ToolbarDialogToolContribution;

/** Whether a contribution is a {@link ToolbarDialogToolContribution}. */
export function isDialogToolContribution(c: unknown): c is ToolbarDialogToolContribution {
  return !!c && (c as { kind?: unknown }).kind === 'dialog';
}

/**
 * Multi-provider token for contributed tools: run tools
 * ({@link ToolbarToolContribution}) and, since 0.6.0, dialog tools
 * ({@link ToolbarDialogToolContribution}).
 *
 * Deliberately has no `factory`: unregistered means no tools, which is what
 * makes this library shippable without the closed model packages. Inject it
 * `{ optional: true }` and treat null as empty.
 */
export const TOOLBAR_TOOLS = new InjectionToken<readonly ToolbarContribution[]>('TOOLBAR_TOOLS');

/** Sort contributed tools into display order. */
export function sortToolContributions<T extends { order?: number }>(
  tools: readonly T[],
): T[] {
  // Stable: equal `order` keeps registration order, so a host controls ties by
  // provider order without having to invent numbers.
  return tools.map((t, i) => ({ t, i })).sort((a, b) =>
    (a.t.order ?? 100) - (b.t.order ?? 100) || a.i - b.i,
  ).map(({ t }) => t);
}

/** The run tools a toolbar should actually show: those with at least one model.
 *  Dialog tools are left out (see {@link dialogToolContributions}). */
export function visibleToolContributions(
  tools: readonly ToolbarContribution[] | null | undefined,
): ToolbarToolContribution[] {
  const run = (tools ?? []).filter(
    (t): t is ToolbarToolContribution =>
      !isDialogToolContribution(t) && typeof (t as ToolbarToolContribution)?.models === 'function',
  );
  return sortToolContributions(run).filter((t) => t.models().length > 0);
}

/**
 * The dialog tools, in display order. A malformed one (no string `id`, no
 * `activate` or `mount` function) or a repeated `id` is dropped with a warning
 * rather than breaking the toolbar.
 */
export function dialogToolContributions(
  tools: readonly ToolbarContribution[] | null | undefined,
  log: { warn(...args: unknown[]): void } = console,
): ToolbarDialogToolContribution[] {
  const seen = new Set<string>();
  const out: ToolbarDialogToolContribution[] = [];
  for (const t of (tools ?? []).filter(isDialogToolContribution)) {
    if (typeof t.id !== 'string' || !t.id || typeof t.activate !== 'function'
        || typeof t.mount !== 'function') {
      log.warn('[visualizer] dialog tool ignored: it needs a string `id` and `activate` and `mount` functions.', t);
      continue;
    }
    if (seen.has(t.id)) {
      log.warn(`[visualizer] dialog tool '${t.id}' ignored: another dialog tool already uses that id.`);
      continue;
    }
    seen.add(t.id);
    out.push(t);
  }
  return sortToolContributions(out);
}
