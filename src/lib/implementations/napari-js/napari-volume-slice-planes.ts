import { parseColor } from 'napari-js';
import type { Viewer } from 'napari-js';
import { SlicePlanesWidget } from 'napari-js/overlays';

import type { VolumeFrame } from './napari-volume-region-meshes';

/** A plane across the volume: x = const, y = const (image px) or z = const (a slice). */
export type PlaneAxis = 'x' | 'y' | 'z';

/** Where each plane is (image px for x and y, the slice for z); null: not shown. */
export type SlicePlanes = Record<PlaneAxis, number | null>;

/** Each plane's colour: its axis's, as the axes gizmo draws them. */
export const SLICE_PLANE_COLORS: Readonly<Record<PlaneAxis, string>> = {
  x: '#ff5c5c',
  y: '#4cd964',
  z: '#668cff',
};
/** A plane's opacity: enough to read where it is, not to hide the volume behind it … */
export const SLICE_PLANE_OPACITY = 0.22;
/** … and while it is dragged. */
export const SLICE_PLANE_DRAG_OPACITY = 0.4;

const AXES: readonly PlaneAxis[] = ['x', 'y', 'z'];

export interface SlicePlanesOptions {
  /** A plane dragged to `value` along its axis (image px, or a fractional slice). */
  onMove(axis: PlaneAxis, value: number): void;
}

/**
 * The planes of the sections shown beside a volume view: napari-js's {@link SlicePlanesWidget}
 * (translucent quads in their axis's colour, each with a grip that drags it along its axis) over
 * the stack's frame. It works in the frame's image px and slices: the widget's box is the image,
 * one voxel per px, so a px position is the widget's shifted by half a pixel (pixel i spans
 * [i, i + 1) here, is centred on i there); a slice is the same in both.
 */
export class VolumeSlicePlanes {
  private widget: SlicePlanesWidget | null = null;
  private frame: VolumeFrame | null = null;
  private planes: SlicePlanes = { x: null, y: null, z: null };
  /** Set while the planes are moved from here, so the widget's echo is not reported as a drag. */
  private applying = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly host: HTMLElement,
    private readonly opts: SlicePlanesOptions,
  ) {}

  /** Follow the volume's frame (it opened, or its Z was stretched). */
  setFrame(frame: VolumeFrame): void {
    this.frame = frame;
    this.rebuild();
  }

  /** Show the planes where they are now (null: hide one). */
  set(planes: SlicePlanes): void {
    this.planes = { ...planes };
    if (this.widget) this.apply();
    else this.rebuild();
  }

  clear(): void {
    this.widget?.dispose();
    this.widget = null;
    this.planes = { x: null, y: null, z: null };
  }

  destroy(): void {
    this.clear();
  }

  /** The widget over the current frame, made when there is one and a plane to show. */
  private rebuild(): void {
    this.widget?.dispose();
    this.widget = null;
    const frame = this.frame;
    if (!frame || AXES.every((a) => this.planes[a] === null)) return;
    const [w, h, d] = frame.size;
    const [ww, wh, wd] = frame.world;
    const widget = new SlicePlanesWidget(this.host, this.viewer, {
      volume: { shape: [w, h, d], voxelSize: [ww / w, wh / h, wd / d] },
      colors: { x: rgb(SLICE_PLANE_COLORS.x), y: rgb(SLICE_PLANE_COLORS.y), z: rgb(SLICE_PLANE_COLORS.z) },
      opacity: SLICE_PLANE_OPACITY,
      dragOpacity: SLICE_PLANE_DRAG_OPACITY,
    });
    widget.changed.connect(({ axis, value }) => {
      if (!this.applying) this.opts.onMove(axis, fromWidget(axis, value));
    });
    this.widget = widget;
    this.apply();
  }

  private apply(): void {
    const widget = this.widget as SlicePlanesWidget;
    this.applying = true;
    try {
      for (const axis of AXES) {
        const at = this.planes[axis];
        widget.setVisible(axis, at !== null);
        if (at !== null) widget.setPosition(axis, toWidget(axis, at));
      }
    } finally {
      this.applying = false;
    }
  }
}

/** Image px (pixel i spanning [i, i + 1)) → the widget's data coordinates (centred on i); slices as is. */
function toWidget(axis: PlaneAxis, v: number): number {
  return axis === 'z' ? v : v - 0.5;
}

function fromWidget(axis: PlaneAxis, v: number): number {
  return axis === 'z' ? v : v + 0.5;
}

/** `#rrggbb` → 0..1 RGB. */
function rgb(css: string): [number, number, number] {
  const [r, g, b] = parseColor(css) ?? [1, 1, 1, 1];
  return [r, g, b];
}
