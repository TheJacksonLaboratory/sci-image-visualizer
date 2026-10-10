import { Directive, EventEmitter, HostListener, Input, NgZone, OnDestroy, Output } from '@angular/core';

/** A screen position, in CSS pixels. */
export interface FloatingPos {
  x: number;
  y: number;
}

/**
 * Drag handle of a floating, `position: fixed` panel (the intensity inset header,
 * the toolbar dock handle). On mousedown it asks {@link origin} where the panel is —
 * the host may detach a docked panel right there — then emits the new position on
 * every move until mouseup.
 *
 * The move/up listeners exist only while a drag is in progress and run outside the
 * Angular zone, re-entering it per emitted position: a permanent window mousemove
 * listener made every pointer move anywhere in the host app run change detection.
 */
@Directive({ selector: '[vizFloatingDrag]' })
export class FloatingDragDirective implements OnDestroy {
  /** Called on mousedown: the panel's position the drag starts from. */
  @Input('vizFloatingDrag') origin!: () => FloatingPos;
  /** The panel's new position, per pointer move. */
  @Output() readonly vizFloatingDragMove = new EventEmitter<FloatingPos>();

  private end: (() => void) | null = null;

  constructor(private readonly zone: NgZone) {}

  @HostListener('mousedown', ['$event'])
  onMouseDown(e: MouseEvent): void {
    e.preventDefault();
    this.end?.();
    const from = this.origin();
    const start = { mx: e.clientX, my: e.clientY, x: from.x, y: from.y };
    const move = (ev: MouseEvent) => this.zone.run(() => this.vizFloatingDragMove.emit({
      x: start.x + (ev.clientX - start.mx),
      y: start.y + (ev.clientY - start.my),
    }));
    const up = () => this.end?.();
    this.zone.runOutsideAngular(() => {
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    this.end = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.end = null;
    };
  }

  ngOnDestroy(): void {
    this.end?.();
  }
}
