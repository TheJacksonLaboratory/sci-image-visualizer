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
 * Multi-provider token for contributed tools.
 *
 * Deliberately has no `factory`: unregistered means no tools, which is what
 * makes this library shippable without the closed model packages. Inject it
 * `{ optional: true }` and treat null as empty.
 */
export const TOOLBAR_TOOLS = new InjectionToken<readonly ToolbarToolContribution[]>('TOOLBAR_TOOLS');

/** Sort contributed tools into display order. */
export function sortToolContributions(
  tools: readonly ToolbarToolContribution[],
): ToolbarToolContribution[] {
  // Stable: equal `order` keeps registration order, so a host controls ties by
  // provider order without having to invent numbers.
  return tools.map((t, i) => ({ t, i })).sort((a, b) =>
    (a.t.order ?? 100) - (b.t.order ?? 100) || a.i - b.i,
  ).map(({ t }) => t);
}

/** The tools a toolbar should actually show: those with at least one model. */
export function visibleToolContributions(
  tools: readonly ToolbarToolContribution[] | null | undefined,
): ToolbarToolContribution[] {
  return sortToolContributions(tools ?? []).filter((t) => t.models().length > 0);
}
