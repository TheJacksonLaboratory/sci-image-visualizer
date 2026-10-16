import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  Output,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';

import type { SectionAxis, SectionView } from '../contracts/section-view.contract';
import { SLICE_PLANE_COLORS } from '../implementations/napari-js/napari-volume-slice-planes';

/** A press that moves farther than this (px) pans; a shorter one is a click. */
const CLICK_SLOP_PX = 4;
/** How much a wheel notch zooms. */
const WHEEL_ZOOM = 1.0015;
/** The section's share of the pane when fitted. */
const FIT_MARGIN = 0.94;
/** The regions' fill opacity, as the 2D view's default. */
const FILL_ALPHA = 0.25;

/**
 * One section beside a split volume view (the plane x = const or y = const through the stack):
 * its image in the volume's proportions, the regions cut by the plane, and the other two planes
 * as a crosshair in their axis colours. The wheel zooms about the pointer, a drag pans, a
 * double-click fits; a click picks that point (`pick`, in section coordinates) — the host moves
 * the other planes there.
 */
/** Section coordinates (u, v) → canvas px. */
type ToCanvas = (u: number, v: number) => [number, number];

@Component({
  selector: 'viz-section-pane',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <canvas
      #canvas
      class="section-canvas"
      [attr.aria-label]="label"
      (wheel)="onWheel($event)"
      (pointerdown)="onDown($event)"
      (pointermove)="onMove($event)"
      (pointerup)="onUp($event)"
      (pointercancel)="onUp($event)"
      (dblclick)="fit()"
    ></canvas>
    <span class="section-badge" [style.background]="axisColor">{{ label }}</span>
    <span *ngIf="!view" class="section-empty">Waiting for the volume…</span>
  `,
  styles: [
    `
      :host {
        position: absolute;
        inset: 0;
        display: block;
        overflow: hidden;
        background: #111;
      }
      .section-canvas {
        width: 100%;
        height: 100%;
        display: block;
        cursor: crosshair;
        touch-action: none;
      }
      .section-badge {
        position: absolute;
        top: 6px;
        left: 6px;
        padding: 1px 8px;
        border-radius: 4px;
        color: #fff;
        font:
          600 12px/1.6 system-ui,
          sans-serif;
        pointer-events: none;
      }
      .section-empty {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #aaa;
        font:
          13px system-ui,
          sans-serif;
        pointer-events: none;
      }
    `,
  ],
})
export class SectionPaneComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) axis!: SectionAxis;
  @Input() view: SectionView | null = null;
  /** A point clicked, in section coordinates (u across, v down). */
  @Output() readonly pick = new EventEmitter<{ u: number; v: number }>();

  @ViewChild('canvas', { static: true }) private canvasRef!: ElementRef<HTMLCanvasElement>;

  private zoom = 1;
  private pan = { x: 0, y: 0 };
  private press: { x: number; y: number; panX: number; panY: number; moved: boolean; pointer: number } | null =
    null;
  private image: { source: SectionView['image']; canvas: HTMLCanvasElement } | null = null;
  private resize?: ResizeObserver;
  private frame: number | null = null;

  constructor(private readonly zone: NgZone) {}

  protected get axisColor(): string {
    return SLICE_PLANE_COLORS[this.axis];
  }

  protected get label(): string {
    const at = this.view ? ` · ${Math.round(this.view.at)} px` : '';
    return `${this.axis.toUpperCase()}${at}`;
  }

  ngAfterViewInit(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.zone.runOutsideAngular(() => {
        this.resize?.disconnect();
        this.resize = new ResizeObserver(() => this.draw());
        this.resize.observe(this.canvasRef.nativeElement);
      });
    }
    this.draw();
  }

  ngOnChanges(): void {
    this.draw();
  }

  ngOnDestroy(): void {
    this.resize?.disconnect();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
  }

  /** Back to the whole section, centred. */
  fit(): void {
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.draw();
  }

  protected onWheel(e: WheelEvent): void {
    if (!this.view) return;
    e.preventDefault();
    const [cx, cy] = this.local(e);
    const factor = Math.pow(WHEEL_ZOOM, -e.deltaY);
    const next = Math.min(50, Math.max(0.2, this.zoom * factor));
    const k = next / this.zoom;
    // Keep the point under the pointer still.
    const { width, height } = this.canvasRef.nativeElement.getBoundingClientRect();
    this.pan.x = (cx - width / 2) * (1 - k) + this.pan.x * k;
    this.pan.y = (cy - height / 2) * (1 - k) + this.pan.y * k;
    this.zoom = next;
    this.draw();
  }

  protected onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.press = {
      x: e.clientX,
      y: e.clientY,
      panX: this.pan.x,
      panY: this.pan.y,
      moved: false,
      pointer: e.pointerId,
    };
    this.canvasRef.nativeElement.setPointerCapture?.(e.pointerId);
  }

  protected onMove(e: PointerEvent): void {
    const p = this.press;
    if (!p || e.pointerId !== p.pointer) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) <= CLICK_SLOP_PX) return;
    p.moved = true;
    this.pan = { x: p.panX + dx, y: p.panY + dy };
    this.draw();
  }

  protected onUp(e: PointerEvent): void {
    const p = this.press;
    if (!p || e.pointerId !== p.pointer) return;
    this.press = null;
    const canvas = this.canvasRef.nativeElement;
    if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture?.(e.pointerId);
    if (p.moved || !this.view) return;
    const at = this.toSection(...this.local(e));
    if (!at) return;
    const [U, V] = this.view.size;
    if (at.u < 0 || at.v < 0 || at.u > U || at.v > V) return;
    this.pick.emit(at);
  }

  private local(e: MouseEvent): [number, number] {
    const r = this.canvasRef.nativeElement.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** Section units → CSS px in the pane: scale per unit across and down, and the origin. */
  private transform(width: number, height: number): { sx: number; sy: number; ox: number; oy: number } | null {
    const view = this.view;
    if (!view || width <= 0 || height <= 0) return null;
    const [U, V] = view.size;
    const worldW = U * view.scale[0];
    const worldH = V * view.scale[1];
    if (!(worldW > 0 && worldH > 0)) return null;
    const k = Math.min(width / worldW, height / worldH) * FIT_MARGIN * this.zoom;
    const sx = view.scale[0] * k;
    const sy = view.scale[1] * k;
    return { sx, sy, ox: width / 2 + this.pan.x - (U / 2) * sx, oy: height / 2 + this.pan.y - (V / 2) * sy };
  }

  private toSection(x: number, y: number): { u: number; v: number } | null {
    const { width, height } = this.canvasRef.nativeElement.getBoundingClientRect();
    const t = this.transform(width, height);
    return t ? { u: (x - t.ox) / t.sx, v: (y - t.oy) / t.sy } : null;
  }

  /** Redraw on the next frame (outside Angular: a canvas paint needs no change detection). */
  private draw(): void {
    if (this.frame !== null || typeof requestAnimationFrame === 'undefined') return;
    this.zone.runOutsideAngular(() => {
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.paint();
      });
    });
  }

  private paint(): void {
    const canvas = this.canvasRef.nativeElement;
    const { width, height } = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const view = this.view;
    const t = this.transform(width, height);
    if (!view || !t) return;
    const [U, V] = view.size;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.imageCanvas(view.image), t.ox, t.oy, U * t.sx, V * t.sy);

    const px = (u: number, v: number): [number, number] => [t.ox + u * t.sx, t.oy + v * t.sy];
    this.paintRegions(ctx, view, px);
    this.paintCrosshair(ctx, view, t, px);
  }

  /** Each class's cut: its outlines filled and stroked, its lines drawn (a dot for one point). */
  private paintRegions(ctx: CanvasRenderingContext2D, view: SectionView, px: ToCanvas): void {
    for (const r of view.regions) {
      if (r.rings.length) {
        ctx.beginPath();
        for (const ring of r.rings) {
          for (let i = 0; i + 1 < ring.length; i += 2) {
            const [x, y] = px(ring[i], ring[i + 1]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.closePath();
        }
        ctx.globalAlpha = FILL_ALPHA;
        ctx.fillStyle = r.color;
        ctx.fill('evenodd');
        ctx.globalAlpha = 1;
        ctx.strokeStyle = r.color;
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }
      ctx.strokeStyle = r.color;
      ctx.fillStyle = r.color;
      ctx.lineWidth = 2;
      for (const line of r.lines) {
        if (line.length === 2) {
          const [x, y] = px(line[0], line[1]);
          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        ctx.beginPath();
        for (let i = 0; i + 1 < line.length; i += 2) {
          const [x, y] = px(line[i], line[i + 1]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
  }

  /** The other planes: across (u) and down (v), dashed in their axis colours. */
  private paintCrosshair(
    ctx: CanvasRenderingContext2D,
    view: SectionView,
    t: { ox: number; oy: number; sx: number; sy: number },
    px: ToCanvas,
  ): void {
    const [U, V] = view.size;
    const across: keyof typeof SLICE_PLANE_COLORS = this.axis === 'x' ? 'z' : 'x';
    const down: keyof typeof SLICE_PLANE_COLORS = this.axis === 'x' ? 'y' : 'z';
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.25;
    if (view.crosshair.u !== null) {
      const [x] = px(view.crosshair.u, 0);
      ctx.strokeStyle = SLICE_PLANE_COLORS[across];
      ctx.beginPath();
      ctx.moveTo(x, t.oy);
      ctx.lineTo(x, t.oy + V * t.sy);
      ctx.stroke();
    }
    if (view.crosshair.v !== null) {
      const [, y] = px(0, view.crosshair.v);
      ctx.strokeStyle = SLICE_PLANE_COLORS[down];
      ctx.beginPath();
      ctx.moveTo(t.ox, y);
      ctx.lineTo(t.ox + U * t.sx, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  /** The section's image on a canvas of its own size (made again only for a new image). */
  private imageCanvas(image: SectionView['image']): HTMLCanvasElement {
    if (this.image?.source === image) return this.image.canvas;
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d')?.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    this.image = { source: image, canvas };
    return canvas;
  }
}
