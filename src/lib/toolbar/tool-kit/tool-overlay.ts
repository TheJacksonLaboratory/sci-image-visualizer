/** Pointer callbacks of an on-canvas tool. */
export interface ToolOverlayHandlers {
  /** Primary-button press (other buttons are ignored). The pointer is captured,
   *  so the drag keeps reporting moves and its release outside the canvas. */
  down?(e: PointerEvent): void;
  /** Every move, pressed or hovering. */
  move?(e: PointerEvent): void;
  /** Release, cancel, or leaving the canvas without a capture. */
  up?(e: PointerEvent): void;
  /** The canvas backing store was resized (its contents were cleared). */
  resize?(): void;
}

/**
 * The transparent canvas an on-canvas tool (wand, brush, vertex eraser,
 * zoom-to-box, SAM point) lays over the plot to take the pointer:
 *
 * - absolute, 100 % of the container, above the renderer (z-index 100);
 * - pointer events (mouse, pen, touch) with pointer capture, so a drag that
 *   leaves the canvas keeps going instead of ending at the edge;
 * - only the primary button starts a gesture;
 * - a backing store sized to the container × devicePixelRatio and kept in step
 *   by a ResizeObserver, so drawing stays sharp and aligned after a panel or
 *   window resize (RT-31). {@link context} draws in CSS pixels.
 */
export class ToolOverlayCanvas {
  private canvas: HTMLCanvasElement | null = null;
  private handlers: ToolOverlayHandlers = {};
  private resizeObserver?: ResizeObserver;
  private readonly listeners: Array<[string, (e: PointerEvent) => void]> = [
    ['pointerdown', (e) => this.onDown(e)],
    ['pointermove', (e) => this.handlers.move?.(e)],
    ['pointerup', (e) => this.onUp(e)],
    ['pointercancel', (e) => this.onUp(e)],
    ['pointerleave', (e) => this.onLeave(e)],
  ];

  /** The overlay canvas while attached. */
  get element(): HTMLCanvasElement | null {
    return this.canvas;
  }

  get attached(): boolean {
    return this.canvas !== null;
  }

  /** Width / height in CSS pixels. */
  get cssWidth(): number {
    return this.canvas ? this.canvas.width / this.dpr() : 0;
  }
  get cssHeight(): number {
    return this.canvas ? this.canvas.height / this.dpr() : 0;
  }

  /** Lay the canvas over `container` (no-op when already attached). */
  attach(container: HTMLElement, handlers: ToolOverlayHandlers, cursor = 'crosshair'): HTMLCanvasElement {
    if (this.canvas) return this.canvas;
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, {
      position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
      cursor, zIndex: '100', touchAction: 'none',
    });
    container.appendChild(canvas);
    this.canvas = canvas;
    this.handlers = handlers;
    this.fit(container);
    for (const [type, fn] of this.listeners) canvas.addEventListener(type, fn as EventListener);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.canvas && this.fit(container)) this.handlers.resize?.();
      });
      this.resizeObserver.observe(container);
    }
    return canvas;
  }

  /** Remove the canvas and its listeners (no-op when detached). */
  detach(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    for (const [type, fn] of this.listeners) canvas.removeEventListener(type, fn as EventListener);
    canvas.remove();
    this.canvas = null;
    this.handlers = {};
  }

  /** The 2D context, scaled so drawing coordinates are CSS pixels. */
  context(): CanvasRenderingContext2D | null {
    const ctx = this.canvas?.getContext('2d') ?? null;
    if (ctx) {
      const dpr = this.dpr();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return ctx;
  }

  /** Clear the whole canvas. */
  clear(): void {
    const ctx = this.context();
    ctx?.clearRect(0, 0, this.cssWidth, this.cssHeight);
  }

  /** An event's position relative to the canvas, in CSS pixels. */
  toLocal(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.canvas?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    // Capture so the drag keeps reporting while the pointer is outside the canvas.
    if (e.pointerId != null) this.canvas?.setPointerCapture?.(e.pointerId);
    this.handlers.down?.(e);
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId != null && this.canvas?.hasPointerCapture?.(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    this.handlers.up?.(e);
  }

  /** Leaving ends a drag only when nothing captured the pointer (a captured
   *  drag continues outside the canvas until release). */
  private onLeave(e: PointerEvent): void {
    if (e.pointerId != null && this.canvas?.hasPointerCapture?.(e.pointerId)) return;
    this.handlers.up?.(e);
  }

  /** Size the backing store to the container × DPR. True when it changed. */
  private fit(container: HTMLElement): boolean {
    const canvas = this.canvas;
    if (!canvas) return false;
    const dpr = this.dpr();
    const w = Math.max(0, Math.round((container.clientWidth || container.offsetWidth) * dpr));
    const h = Math.max(0, Math.round((container.clientHeight || container.offsetHeight) * dpr));
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w;
    canvas.height = h;
    return true;
  }

  private dpr(): number {
    return (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  }
}
