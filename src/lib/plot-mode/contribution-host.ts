import { Injector, NgZone, Type } from '@angular/core';
import { Observable } from 'rxjs';
import { Message } from 'primeng/api';

import { IImageInfo } from '../contracts/image.contract';
import { PlotType, PlotTypeId } from '../contracts/plot-type';
import {
  PLOT_MODE_CONTEXT,
  PLOT_MODE_SESSION,
  PlotModeContext,
  PlotModeTools,
  PlotTypeContribution,
} from '../contracts/plot-type-contribution.contract';
import {
  ToolDialogContext,
  ToolbarContribution,
  ToolbarDialogToolContribution,
  dialogToolContributions,
} from '../contracts/toolbar-tool.contract';
import { IVisualizer } from '../contracts/visualizer.contract';
import { ActivePlotMode, PlotModeController } from './plot-mode-controller';

/** The live contributed mode's side panel, as the template renders it. */
export interface PlotModePanelView {
  title: string;
  /** An Angular component panel, with its own injector… */
  component: Type<unknown> | null;
  injector: Injector | null;
  /** …or a plain host element a `mount` panel rendered into. */
  host: HTMLElement | null;
}

/** The open dialog tool's dialog, as the template renders it. */
export interface ToolDialogView {
  title: string;
  width: string;
  host: HTMLElement;
}

/** What the contributions need from the viewer that hosts them. */
export interface ContributionViewer {
  readonly visualizer: IVisualizer;
  readonly zone: NgZone;
  /** The toolbar tools a contribution may arm (`PlotModeContext.tools`). */
  readonly tools: PlotModeTools;
  /** Parent of a component panel's injector. */
  readonly injector?: Injector;
  imageInfo$(): Observable<IImageInfo | null>;
  /** The selector's id (a built-in type or a contributed mode). */
  selectedId(): PlotTypeId;
  /** The built-in type being rendered. */
  renderedType(): PlotType;
  /** A contributed mode could not start: select its base type, already on screen. */
  selectBase(type: PlotType): void;
  notify(message: Message): void;
  detectChanges(): void;
}

/** How many animation frames to wait for a tool dialog to attach its body's host. */
const TOOL_DIALOG_ATTACH_FRAMES = 60;

/**
 * Hosts the library's two kinds of contributed sessions over the viewer:
 *  - **plot modes** (`PLOT_TYPE_CONTRIBUTIONS`): a selector entry riding on a built-in
 *    base type, with an optional side panel;
 *  - **dialog tools** (`TOOLBAR_TOOLS`, `kind: 'dialog'`): a floating dialog over the
 *    Image view, whose body the tool mounts once the dialog is in the document.
 *
 * Both run through a {@link PlotModeController} (one live session each, isolated from
 * a failing contribution). A session is bound to the base view it drew over, so it
 * ends before anything else draws ({@link endSessions}) and restarts once the next
 * render has landed ({@link activate}).
 */
export class ContributionHost {
  readonly plotModes: PlotModeController;
  readonly toolDialogs: PlotModeController;
  /** Dialog tools, sorted; their buttons show in the Image view only. */
  readonly dialogTools: ToolbarDialogToolContribution[];
  /** The live mode's panel; null while no contributed session is live. */
  plotModePanel: PlotModePanelView | null = null;
  /** The open dialog tool's live dialog. */
  toolDialog: ToolDialogView | null = null;
  /** The dialog tool the user has open (its session may be between renders). */
  openDialogToolId: string | null = null;

  private destroying = false;
  /** The live dialog body's teardown, and a pending wait for its host to connect. */
  private toolDialogTeardown: (() => void) | null = null;
  private toolDialogFrame: number | null = null;

  constructor(
    plotTypeContributions: readonly PlotTypeContribution[] | null | undefined,
    toolContributions: readonly ToolbarContribution[] | null | undefined,
    private readonly viewer: ContributionViewer,
  ) {
    this.plotModes = new PlotModeController(plotTypeContributions, {
      onActivated: (active) => this.showPlotModePanel(active),
      onDeactivating: () => this.hidePlotModePanel(),
      onFailed: (contribution) => this.fallBackFromPlotMode(contribution),
    });
    this.dialogTools = dialogToolContributions(toolContributions);
    // A dialog tool's session is run by the plot-mode lifecycle, adapted: its "base
    // type" is the Image view it draws over. Its body is NOT a controller panel: the
    // controller would mount into a detached host, and a body must be able to measure
    // itself. The dialog is rendered first and the body mounted once its host is in
    // the document (showToolDialog).
    this.toolDialogs = new PlotModeController(
      this.dialogTools.map((t): PlotTypeContribution => ({
        descriptor: { type: t.id, label: t.label, dimensions: '2d', baseType: PlotType.IMAGE },
        activate: (ctx) => t.activate(ctx as ToolDialogContext),
      })),
      {
        onActivated: (active) => this.showToolDialog(active),
        onDeactivating: () => this.hideToolDialog(),
        onFailed: (contribution) => this.dialogToolFailed(contribution.descriptor.type),
      },
    );
  }

  /** End both sessions: the view they drew over is about to go. An open dialog tool
   *  stays open and restarts on the next {@link activate}. */
  endSessions(): void {
    this.plotModes.deactivate();
    this.toolDialogs.deactivate();
  }

  /** A render landed: start the selected mode's session and the open dialog tool's. */
  activate(): void {
    this.activateSelectedPlotMode();
    this.activateOpenDialogTool();
  }

  /** The viewer is being destroyed: end both sessions without touching its view. */
  destroy(): void {
    this.destroying = true;
    this.endSessions();
  }

  /** The toolbar button: open the tool's dialog, or close it if it is open. */
  toggleDialogTool(id: string): void {
    if (this.openDialogToolId === id) {
      this.closeDialogTool();
      return;
    }
    this.closeDialogTool();
    if (!this.dialogTools.some((t) => t.id === id)) return;
    this.openDialogToolId = id;
    this.toolDialogs.clearCleanupFailures(); // an explicit open gets a fresh attempt
    this.activateOpenDialogTool();
  }

  /** Close the open dialog tool: its body is torn down, then its session ends. */
  closeDialogTool(): void {
    this.openDialogToolId = null;
    this.toolDialogs.deactivate();
  }

  /** Attach a `mount` panel's host element once the panel dialog renders its slot. */
  attachPanelSlot(slot: HTMLElement | undefined): void {
    const host = this.plotModePanel?.host;
    if (slot && host && host.parentElement !== slot) slot.appendChild(host);
  }

  /** Attach the open dialog tool's host element once its dialog renders its slot. */
  attachToolDialogSlot(slot: HTMLElement | undefined): void {
    const host = this.toolDialog?.host;
    if (slot && host && host.parentElement !== slot) slot.appendChild(host);
  }

  /**
   * Start the selected contributed mode's session, once its base view has plotted.
   * No-op for a built-in type, or when the base on screen is not the one the mode
   * rides on. A backend that cannot provide a viewport for it (e.g. OSD fell back to
   * Plotly) counts as a failed activation.
   */
  private activateSelectedPlotMode(): void {
    const contribution = this.plotModes.find(this.viewer.selectedId());
    if (!contribution || this.viewer.renderedType() !== contribution.descriptor.baseType) return;
    const ctx = this.context();
    if (!ctx) {
      console.error(
        `[visualizer] plot-type contribution '${contribution.descriptor.type}': the backend ` +
          'on screen provides no viewport to draw over — falling back.',
      );
      this.fallBackFromPlotMode(contribution);
      return;
    }
    void this.plotModes.activate(contribution, ctx);
  }

  /** Start (or restart, after a re-render) the open dialog tool's session. */
  private activateOpenDialogTool(): void {
    const id = this.openDialogToolId;
    const contribution = id ? this.toolDialogs.find(id) : undefined;
    if (!id || !contribution || this.viewer.renderedType() !== PlotType.IMAGE) return;
    if (this.toolDialogs.current?.contribution === contribution || this.toolDialogs.pending) return;
    const ctx = this.context();
    if (!ctx) {
      console.error(`[visualizer] dialog tool '${id}': the backend on screen provides no viewport to draw over.`);
      this.dialogToolFailed(id);
      return;
    }
    void this.toolDialogs.activate(contribution, ctx);
  }

  /** A session's context over the backend on screen, or null when it has no viewport. */
  private context(): PlotModeContext | null {
    const visualizer = this.viewer.visualizer;
    const viewport = visualizer.getPlotModeViewport?.() ?? null;
    if (!viewport) return null;
    return { visualizer, viewport, imageInfo$: this.viewer.imageInfo$(), tools: this.viewer.tools };
  }

  /** Render the live mode's panel. Activation can resolve outside Angular (an OSD
   *  callback, a contribution's own promise), hence the zone re-entry. */
  private showPlotModePanel(active: ActivePlotMode): void {
    const panel = active.contribution.panel;
    if (!panel) return;
    this.viewer.zone.run(() => {
      if ('component' in panel && panel.component) {
        this.plotModePanel = {
          title: panel.title,
          component: panel.component,
          injector: Injector.create({
            providers: [
              { provide: PLOT_MODE_CONTEXT, useValue: active.ctx },
              { provide: PLOT_MODE_SESSION, useValue: active.session },
            ],
            parent: this.viewer.injector,
          }),
          host: null,
        };
      } else if (active.panelHost) {
        this.plotModePanel = { title: panel.title, component: null, injector: null, host: active.panelHost };
      } else {
        return;
      }
      // A component panel is created and first rendered right here; if that throws,
      // the mode is not usable — end it and fall back rather than leave it selected.
      const err = this.detectChangesSafely();
      if (err !== null) this.plotModes.failActive(err);
    });
  }

  /** Drop the panel (destroying a component panel) before the session ends. */
  private hidePlotModePanel(): void {
    if (!this.plotModePanel) return;
    this.plotModePanel = null;
    this.detectChangesSafely();
  }

  /** A contributed mode could not start. Its base type is already on screen — the base
   *  plotted first — so just select it: nothing needs to re-plot. */
  private fallBackFromPlotMode(contribution: PlotTypeContribution): void {
    if (this.destroying || this.viewer.selectedId() !== contribution.descriptor.type) return;
    this.viewer.zone.run(() => {
      this.viewer.selectBase(contribution.descriptor.baseType);
      this.viewer.notify({
        severity: 'warn',
        summary: `${contribution.descriptor.productionLabel ?? contribution.descriptor.label} is unavailable`,
        detail:
          'The plot mode could not start, so the plain image is shown instead. See the browser console for details.',
      });
      this.detectChangesSafely();
    });
  }

  /**
   * The dialog-tool session is live: render the dialog, then mount the tool's body
   * once the host element is in the document, so `mount()` can measure it and start
   * widgets that need a connected element.
   */
  private showToolDialog(active: ActivePlotMode): void {
    const tool = this.dialogTools.find((t) => t.id === active.contribution.descriptor.type);
    if (!tool) return;
    const host = document.createElement('div');
    host.className = 'tool-dialog-body';
    this.viewer.zone.run(() => {
      this.toolDialog = { title: tool.dialog?.title ?? tool.label, width: tool.dialog?.width ?? '22rem', host };
      const err = this.detectChangesSafely();
      if (err !== null) {
        this.toolDialogs.failActive(err);
        return;
      }
      this.mountToolDialogBody(tool, active, host, 0);
    });
  }

  /**
   * Mount `tool`'s body into `host` once it is connected (the dialog may attach it a
   * frame later, when it moves itself to `<body>`). If it never connects within
   * {@link TOOL_DIALOG_ATTACH_FRAMES} it is mounted anyway, with a warning, rather than
   * leaving an empty dialog. A throwing `mount()` fails the session like a failed start.
   */
  private mountToolDialogBody(
    tool: ToolbarDialogToolContribution,
    active: ActivePlotMode,
    host: HTMLElement,
    frames: number,
  ): void {
    this.toolDialogFrame = null;
    // The session ended (or was replaced) while waiting: nothing to mount into.
    if (this.toolDialogs.current !== active || this.toolDialog?.host !== host) return;
    if (!host.isConnected) {
      if (frames < TOOL_DIALOG_ATTACH_FRAMES) {
        this.toolDialogFrame = requestAnimationFrame(() =>
          this.mountToolDialogBody(tool, active, host, frames + 1),
        );
        return;
      }
      console.warn(`[visualizer] dialog tool '${tool.id}': the dialog body never attached; mounting it detached.`);
    }
    try {
      const teardown = tool.mount(host, active.ctx as ToolDialogContext, active.session);
      this.toolDialogTeardown = typeof teardown === 'function' ? teardown : null;
    } catch (err) {
      console.error(`[visualizer] dialog tool '${tool.id}' mount() threw.`, err);
      this.toolDialogs.failActive(err);
    }
  }

  /** The dialog-tool session is about to end: tear the body down first, then drop the dialog. */
  private hideToolDialog(): void {
    if (this.toolDialogFrame !== null) cancelAnimationFrame(this.toolDialogFrame);
    this.toolDialogFrame = null;
    const teardown = this.toolDialogTeardown;
    this.toolDialogTeardown = null;
    if (teardown) {
      try {
        teardown();
      } catch (err) {
        console.error('[visualizer] dialog tool body teardown threw.', err);
      }
    }
    if (!this.toolDialog) return;
    this.toolDialog.host.remove();
    this.toolDialog = null;
    if (!this.destroying) this.detectChangesSafely();
  }

  /** A dialog tool could not start: close it and say so. */
  private dialogToolFailed(id: string): void {
    if (this.destroying || this.openDialogToolId !== id) return;
    this.viewer.zone.run(() => {
      this.openDialogToolId = null;
      const tool = this.dialogTools.find((t) => t.id === id);
      this.viewer.notify({
        severity: 'warn',
        summary: `${tool?.label ?? id} is unavailable`,
        detail: 'The tool could not start. See the browser console for details.',
      });
      this.detectChangesSafely();
    });
  }

  /** Run change detection; returns what it threw (logged), or null. */
  private detectChangesSafely(): unknown | null {
    if (this.destroying) return null;
    try {
      this.viewer.detectChanges();
      return null;
    } catch (err) {
      console.error('[visualizer] change detection failed while updating a contributed plot mode panel.', err);
      return err ?? new Error('change detection failed');
    }
  }
}
