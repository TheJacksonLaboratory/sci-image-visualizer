import { NgZone } from '@angular/core';

/** What the shortcuts drive: the viewer's actions and the state they gate on. */
export interface ShortcutHost {
  /** Id of the plot div; the wheel and the context menu act only over it. */
  readonly plotDivName: string;
  /** The viewer's own element (toolbar + plot); its keys are scoped to it. Falls back
   *  to the plot div when absent. */
  readonly hostElement?: HTMLElement | null;
  /** The armed tool — SAM point mode takes Enter / Escape. */
  activeDragMode(): string | null;
  /** ←/→ step the slice: a loaded stack in the Image view. */
  canStepSlice(): boolean;
  /** The wheel steps the zoom: a 2D view whose renderer does not read the wheel itself. */
  wheelZooms(): boolean;
  stepSlice(delta: number): void;
  /** SAM point mode: commit (Enter) or discard (Escape) the prompt. */
  resolveSamPrompt(commit: boolean): void;
  undo(): void;
  redo(): void;
  deleteRegion(): void;
  zoomIn(): void;
  zoomOut(): void;
  toggleDragMode(mode: string): void;
  openContextMenu(event: MouseEvent): void;
}

/** Bare keys that toggle a tool mode. */
const TOOL_KEYS: ReadonlyMap<string, string> = new Map([
  ['p', 'pan'],
  ['b', 'zoomToBox'],
  ['r', 'drawrect'],
  ['f', 'drawclosedpath'],
  ['w', 'wand'],
  ['e', 'eraseVertex'],
  ['s', 'select'],
  ['l', 'drawopenpath'],
]);

/** A field the user types into: its keys are never shortcuts. */
function isTextField(t: HTMLElement | null): boolean {
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

/**
 * The viewer's keyboard, wheel and context-menu handling: one window listener each,
 * registered OUTSIDE the Angular zone (zone-patched, every event anywhere in the host
 * app ran app-wide change detection) and re-entering it only to act.
 *
 * Keys: ←/→ step the slice; Enter/Escape resolve a SAM point prompt; Ctrl/Cmd+Z undo,
 * Ctrl/Cmd+Shift+Z or +Y redo; bare Delete/Backspace/d delete the selected region,
 * +/= and -/_ zoom, and single letters toggle tools (`TOOL_KEYS`). Any other
 * modified key is left to the browser (Cmd/Ctrl+D must not delete a region).
 *
 * Keys are per viewer: with two live viewers (a main view and a pipeline preview)
 * one Delete must not delete in both. A key goes to the viewer that holds focus, or
 * — focus elsewhere — to the viewer the pointer last moved over; any other viewer
 * ignores it (review CORE-2).
 */
export class ViewerShortcuts {
  /** Every attached instance, to find the one holding focus. */
  private static readonly live = new Set<ViewerShortcuts>();
  /** The viewer the pointer last moved over. */
  private static lastHovered: ViewerShortcuts | null = null;
  private readonly listeners: [string, EventListener, boolean | AddEventListenerOptions][] = [];

  constructor(
    private readonly host: ShortcutHost,
    private readonly zone: NgZone,
  ) {}

  /** Register the window listeners (outside the zone). */
  attach(): void {
    this.zone.runOutsideAngular(() => {
      this.listen('contextmenu', (e) => this.onContextMenu(e as MouseEvent), true);
      this.listen('keydown', (e) => this.onKeydown(e as KeyboardEvent), false);
      this.listen('wheel', (e) => this.onWheel(e as WheelEvent), { capture: true, passive: false });
      // `pointerover` fires on element transitions only, not on every move.
      this.listen(
        'pointerover',
        (e) => {
          if (this.contains(e.target as Node)) ViewerShortcuts.lastHovered = this;
        },
        true,
      );
    });
    ViewerShortcuts.live.add(this);
  }

  /** Remove every listener {@link attach} added. */
  detach(): void {
    ViewerShortcuts.live.delete(this);
    if (ViewerShortcuts.lastHovered === this) ViewerShortcuts.lastHovered = null;
    for (const [type, listener, options] of this.listeners.splice(0)) {
      window.removeEventListener(type, listener, options);
    }
  }

  private listen(type: string, listener: EventListener, options: boolean | AddEventListenerOptions): void {
    window.addEventListener(type, listener, options);
    this.listeners.push([type, listener, options]);
  }

  private contains(node: Node | null): boolean {
    const el = this.host.hostElement ?? document.getElementById(this.host.plotDivName);
    return !!node && !!el?.contains(node);
  }

  /** Whether this viewer takes keys now: it holds focus, or nothing does and the
   *  pointer was last over it. */
  private ownsKeys(): boolean {
    const active = document.activeElement;
    const focused =
      active && active !== document.body ? [...ViewerShortcuts.live].find((s) => s.contains(active)) : undefined;
    return (focused ?? ViewerShortcuts.lastHovered) === this;
  }

  private overPlot(event: Event): boolean {
    return !!document.getElementById(this.host.plotDivName)?.contains(event.target as Node);
  }

  private run(fn: () => void): void {
    this.zone.run(fn);
  }

  private onContextMenu(event: MouseEvent): void {
    if (!this.overPlot(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.run(() => this.host.openContextMenu(event));
  }

  private onWheel(event: WheelEvent): void {
    if (!this.overPlot(event)) return;
    // A renderer that reads the scroll delta (napari, 3D scenes) keeps its own wheel:
    // a FIXED zoom step per wheel event is far too sensitive there.
    if (!this.host.wheelZooms()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.deltaY < 0) this.run(() => this.host.zoomIn());
    else if (event.deltaY > 0) this.run(() => this.host.zoomOut());
  }

  private onKeydown(event: KeyboardEvent): void {
    if (!this.ownsKeys()) return;
    const host = this.host;
    const target = event.target as HTMLElement | null;
    if (this.isSliceStepKey(event, target)) {
      event.preventDefault();
      this.run(() => host.stepSlice(event.key === 'ArrowRight' ? 1 : -1));
      return;
    }
    if (isTextField(target)) return;
    if (host.activeDragMode() === 'samPoint' && (event.key === 'Enter' || event.key === 'Escape')) {
      this.run(() => host.resolveSamPrompt(event.key === 'Enter'));
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      const k = event.key.toLowerCase();
      if (k === 'z' && !event.shiftKey) {
        event.preventDefault();
        this.run(() => host.undo());
        return;
      }
      if ((k === 'z' && event.shiftKey) || k === 'y') {
        event.preventDefault();
        this.run(() => host.redo());
        return;
      }
    }
    // The bare-key shortcuts must not fire on browser/OS shortcuts.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key;
    if (key === 'Delete' || key === 'Backspace' || key === 'd' || key === 'D') this.run(() => host.deleteRegion());
    else if (key === '+' || key === '=') this.run(() => host.zoomIn());
    else if (key === '-' || key === '_') this.run(() => host.zoomOut());
    else {
      const mode = TOOL_KEYS.get(key);
      if (mode) this.run(() => host.toggleDragMode(mode));
    }
  }

  /**
   * ←/→ step the slice in the Image view, the same way the slider does — only for a
   * loaded stack, and not while a form field or the slider itself has focus (it
   * handles arrows natively; stepping here too would double-step). Up/Down are left
   * to OpenSeadragon (panning).
   */
  private isSliceStepKey(e: KeyboardEvent, t: HTMLElement | null): boolean {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;
    if (!this.host.canStepSlice()) return false;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return false;
    return !(t && (t.getAttribute('role') === 'slider' || t.closest('.p-slider')));
  }
}
