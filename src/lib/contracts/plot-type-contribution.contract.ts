/**
 * How a plot mode gets into the plot-type selector without this library knowing
 * what it is.
 *
 * A package contributes a mode by providing a {@link PlotTypeContribution} on the
 * {@link PLOT_TYPE_CONTRIBUTIONS} multi-provider token, the same way
 * `TOOLBAR_TOOLS` contributes toolbar tools. Nothing registers at import time:
 * installing a package makes a mode available, and adding its provider turns it
 * on. A plain object works, so the contributing package needs no Angular
 * compiler and no decorators:
 *
 *     { provide: PLOT_TYPE_CONTRIBUTIONS, useValue: myContribution, multi: true }
 *     { provide: PLOT_TYPE_CONTRIBUTIONS, useFactory: () => makeContribution(), multi: true }
 *
 * Provide nothing and the selector, the render path and the panel area behave
 * exactly as they did before this extension point existed.
 *
 * WHY A CONTRIBUTED MODE RIDES ON A BUILT-IN ONE
 * A contributed mode does not bring a renderer. It names a built-in
 * {@link ContributedPlotTypeDescriptor.baseType} — in v1 only `PlotType.IMAGE`,
 * the OpenSeadragon view — and the visualizer plots exactly as if that type had
 * been selected: same backend, same toolbar, same region tools, same wheel
 * handling. The contribution then draws over it through the
 * {@link PlotModeViewport} and talks to the viewer through the public
 * {@link IVisualizer}. That keeps every rendering decision in one place and means
 * a contribution can never be half-supported by some code path that switches on
 * the plot type.
 *
 * WHAT THE VISUALIZER GUARANTEES
 *  1. Contributed descriptors are appended after the built-in ones and curated by
 *     the same `productionLabel` / test-mode / `requires*` rules.
 *  2. Selecting one plots with `baseType`'s backend, then calls `activate(ctx)`
 *     once the viewport is ready.
 *  3. Leaving the mode — another type, an image switch (or any re-render of the
 *     base view), or the visualizer being destroyed — calls `session.deactivate()`
 *     exactly once, before the next mode draws. If the mode is still selected
 *     when the new image has plotted, a fresh session is activated for it.
 *  4. `panel` is shown only while a session is live.
 *  5. A thrown error or rejected promise from `activate`, `deactivate`, `mount`
 *     or a mount's teardown is caught and logged; none escapes, so a contribution
 *     cannot break the viewer. Failing to start (`activate` / `mount`) falls back
 *     to `baseType`. Failing to clean up falls back when that same mode is being
 *     re-activated (base re-render, image switch) — immediately if it already is
 *     live again — and is only logged when the user has moved to another mode; the
 *     user explicitly selecting it again gets a fresh attempt.
 *  6. {@link PLOT_TYPE_CONTRIBUTIONS} has no factory: no providers, no modes.
 */
import { InjectionToken, Type } from '@angular/core';
import type { Observable } from 'rxjs';

import type { IImageInfo } from './image.contract';
import type { PlotType, PlotTypeDescriptor, PlotTypeId } from './plot-type';
import type { IVisualizer } from './visualizer.contract';

/** A rectangle in level-0 image pixels. */
export interface PlotModeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Selector metadata for a contributed plot mode. */
export interface ContributedPlotTypeDescriptor {
  /** Unique id, namespaced, e.g. 'dianne'. Must not clash with PlotType values. */
  type: string;
  /** Test-mode label, e.g. 'Digital Pathology - DIANNE'. */
  label: string;
  /** Default-selector label; omit to make the mode test-only (same rule as built-ins). */
  productionLabel?: string;
  /** 'pi pi-…' class or asset path, same as PlotTypeDescriptor.icon. */
  icon?: string;
  /** Always '2d' in v1. */
  dimensions: '2d';
  /** Built-in type whose backend renders the base image. v1 supports PlotType.IMAGE (OSD). */
  baseType: PlotType;
  /** Same gates as PlotTypeDescriptor, evaluated in addition to the base type's own. */
  requiresGrayscale?: boolean;
  requiresStack?: boolean;
  /** Hidden until a `SpatialDataset` is published on SPATIAL_DATA_PORT (an overlay of spatial observations). */
  requiresSpatialData?: boolean;
  /** Hidden unless the published dataset carries `observations.z`. */
  requiresSpatial3d?: boolean;
}

/** The base view's viewport, as a contributed mode sees it. */
export interface PlotModeViewport {
  /** Element the mode's overlay canvas/SVG attaches to; fills the plot area. */
  getOverlayContainer(): HTMLElement | null;
  /** Level-0 image px -> client px, and the reverse. */
  dataToClient(x: number, y: number): { x: number; y: number };
  clientToData(clientX: number, clientY: number): { x: number; y: number };
  /** Screen px per image px at the current zoom. */
  dataLengthToScreen(len: number): number;
  isReady(): boolean;
  /** Visible image rect in level-0 px, emitted on every redraw frame (pan/zoom animation). */
  frame$: Observable<PlotModeRect>;
  /** Same rect, emitted once the viewport settles (existing getViewportChange$ semantics). */
  settled$: Observable<PlotModeRect>;
}

/** Everything a contributed mode gets to work with while it is active. */
export interface PlotModeContext {
  /** Full public visualizer API: regions, region overlay (tool modes), undo, etc. */
  visualizer: IVisualizer;
  viewport: PlotModeViewport;
  /** Current image info from IMAGE_STATE_PORT (null until an image is loaded). */
  imageInfo$: Observable<IImageInfo | null>;
}

/** A live activation of a contributed mode. */
export interface PlotModeSession {
  /** Called when the user leaves the mode, the image changes, or the visualizer is destroyed. */
  deactivate(): void;
}

/**
 * The mode's side panel, shown in the visualizer's right-hand panel area while
 * a session is live. Two forms:
 *
 *  - `component`: an Angular component, rendered through `NgComponentOutlet`
 *    with {@link PLOT_MODE_CONTEXT} and {@link PLOT_MODE_SESSION} in its
 *    injector. Needs an AOT-compiled (partial-Ivy) component.
 *  - `mount`: framework-agnostic. The visualizer hands over an empty host
 *    element after `activate` resolves; the function renders into it and returns
 *    a teardown. The teardown is called exactly once when the mode deactivates,
 *    before `session.deactivate()`, and the host element is then removed.
 */
export type PlotModePanel =
  | { title: string; component: Type<unknown> }
  | {
      title: string;
      mount(host: HTMLElement, ctx: PlotModeContext, session: PlotModeSession): () => void;
    };

/** A plot mode contributed to the selector. A plain object is enough. */
export interface PlotTypeContribution {
  descriptor: ContributedPlotTypeDescriptor;
  /** Called after the base backend has plotted the image in this mode. */
  activate(ctx: PlotModeContext): PlotModeSession | Promise<PlotModeSession>;
  /**
   * Optional side panel, rendered in the visualizer's right-hand panel area while the
   * mode is active. A component panel can inject PLOT_MODE_CONTEXT and PLOT_MODE_SESSION.
   */
  panel?: PlotModePanel;
}

/**
 * Multi-provider token for contributed plot modes.
 *
 * Deliberately has no `factory`: unregistered means no contributed modes, and the
 * library behaves exactly as before. The visualizer injects it `{ optional: true }`
 * and treats null as empty.
 */
export const PLOT_TYPE_CONTRIBUTIONS =
  new InjectionToken<readonly PlotTypeContribution[]>('PLOT_TYPE_CONTRIBUTIONS');
/** The active mode's context, in a component panel's injector. */
export const PLOT_MODE_CONTEXT = new InjectionToken<PlotModeContext>('PLOT_MODE_CONTEXT');
/** The active mode's session, in a component panel's injector. */
export const PLOT_MODE_SESSION = new InjectionToken<PlotModeSession>('PLOT_MODE_SESSION');

/**
 * One entry in the plot-type selector: a built-in {@link PlotTypeDescriptor}
 * as-is, or a contributed descriptor completed with its base type's `source`.
 * Every entry therefore carries the same fields the selector curates by.
 */
export interface PlotTypeOption extends Omit<PlotTypeDescriptor, 'type'> {
  type: PlotTypeId;
  /** Set only for a contributed mode: the built-in type that renders it. */
  baseType?: PlotType;
}

/** The selector entry for a contributed mode, given its base type's descriptor. */
export function contributedPlotTypeOption(
  d: ContributedPlotTypeDescriptor,
  base: PlotTypeDescriptor,
): PlotTypeOption {
  return { ...d, source: base.source };
}
