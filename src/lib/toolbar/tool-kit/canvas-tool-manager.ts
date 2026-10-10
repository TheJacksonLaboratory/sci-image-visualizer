import type { CanvasToolId } from '../../contracts/display-types';
import { CanvasToolHost, ICanvasTool } from './canvas-tool';

/**
 * One backend's canvas tools. Each backend (Plotly, OpenSeadragon, napari-js)
 * creates its own manager with its own {@link CanvasToolHost} and its own tool
 * instances, so arming a tool never re-binds a tool another backend is using,
 * and a backend switch never carries a stroke or SAM points across (RT-21).
 * At most one tool is armed at a time.
 */
export class CanvasToolManager {
  private readonly tools = new Map<CanvasToolId, ICanvasTool<unknown>>();
  private active: ICanvasTool<unknown> | null = null;

  constructor(private readonly host: CanvasToolHost, tools: ReadonlyArray<ICanvasTool<never>>) {
    for (const tool of tools) this.tools.set(tool.id, tool as ICanvasTool<unknown>);
  }

  /** The armed tool's id, or null. */
  get activeId(): CanvasToolId | null {
    return this.active?.id ?? null;
  }

  /** Whether this manager has a tool for `id`. */
  has(id: string | null | undefined): id is CanvasToolId {
    return id != null && this.tools.has(id as CanvasToolId);
  }

  /** The tool with this id, typed by the caller. */
  get<T extends ICanvasTool<never>>(id: CanvasToolId): T | undefined {
    return this.tools.get(id) as T | undefined;
  }

  /**
   * Arm `id` with `options`, disarming the armed tool first. null — or an id
   * this manager has no tool for, such as a region draw mode — disarms only.
   * Arming the armed tool again forwards `options` and keeps its work in progress.
   */
  activate(id: string | null, options?: unknown): void {
    const next = this.has(id) ? this.tools.get(id)! : null;
    if (this.active && this.active !== next) this.deactivate();
    if (!next) return;
    this.active = next;
    next.activate(this.host, options);
  }

  /** Disarm the armed tool, if any. */
  deactivate(): void {
    const tool = this.active;
    this.active = null;
    tool?.deactivate();
  }

  /** Forward live options to a tool, armed or not. */
  setOptions(id: CanvasToolId, options: unknown): void {
    this.tools.get(id)?.setOptions?.(options);
  }

  /** Drop one tool's work in progress (it stays armed). */
  reset(id: CanvasToolId): void {
    this.tools.get(id)?.reset?.();
  }

  /** Drop every tool's work in progress — after undo/redo or an image switch,
   *  where a stroke or prompt no longer matches the regions on screen. */
  resetAll(): void {
    for (const tool of this.tools.values()) tool.reset?.();
  }
}
