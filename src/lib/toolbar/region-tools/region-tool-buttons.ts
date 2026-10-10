/** A drawing tool's toggle button in the toolbar's region group. */
export interface RegionToolButton {
  /** The drag mode the button toggles. */
  mode: string;
  /** Accessible name. */
  label: string;
  /** Tooltip (HTML). */
  tooltip: string;
  /** A PrimeNG glyph (`pi pi-…`), or else {@link img}. */
  icon?: string;
  /** An SVG under `assets/plotting/`, recoloured for its on/off state. */
  img?: string;
  /** `not3d`: absent from the 3D cloud's screen-space lasso (no raster to
   *  sample / an open polyline is no region); `vertex`: needs a backend with a
   *  vertex-editing overlay (OSD + napari-js image). */
  gate?: 'not3d' | 'vertex';
  /** The tool's parameter slider, shown while it is active. */
  slider?: 'brush' | 'wand' | 'eraser';
}

/** The region drawing tools, in toolbar order. */
export const REGION_TOOL_BUTTONS: readonly RegionToolButton[] = [
  { mode: 'select', label: 'Selection mode', icon: 'pi pi-arrow-up-right',
    tooltip: 'Selection mode (<kbd>s</kbd>)' },
  { mode: 'drawrect', label: 'Draw a rectangle', icon: 'pi pi-stop',
    tooltip: 'Draw a rectangular region (<kbd>r</kbd>)' },
  { mode: 'drawopenpath', label: 'Draw a polyline', img: 'polyline.svg', gate: 'not3d',
    tooltip: 'Draw a polyline (<kbd>l</kbd>)' },
  { mode: 'drawclosedpath', label: 'Draw a freeform region', icon: 'pi pi-pencil',
    tooltip: 'Draw a freeform region (<kbd>f</kbd>)' },
  { mode: 'brush', label: 'Brush', img: 'paintbrush.svg', gate: 'not3d', slider: 'brush',
    tooltip: 'Brush: click and drag to paint a region.\n<br>Hold <kbd>Shift</kbd> while painting to erase from a region.' },
  { mode: 'drawpolygon', label: 'Draw a polygon', img: 'polygon-vertices.svg', gate: 'vertex',
    tooltip: 'Polygon: click to place each vertex; click the first point to close' },
  { mode: 'addpoint', label: 'Add a vertex', img: 'vertex-add.svg', gate: 'vertex',
    tooltip: 'Add a vertex: click an edge of the selected polygon' },
  { mode: 'deletepoint', label: 'Delete a vertex', img: 'vertex-delete.svg', gate: 'vertex',
    tooltip: 'Delete a vertex: click a vertex of the selected polygon' },
  { mode: 'wand', label: 'Wand', img: 'wand.svg', slider: 'wand',
    tooltip: 'Wand: click and drag to grow a region by similar pixel values (<kbd>w</kbd>).\n'
      + '<br>Hold <kbd>Shift</kbd> while clicking or dragging on a region to erase pixels from it.' },
  { mode: 'eraseVertex', label: 'Vertex eraser', icon: 'pi pi-eraser', slider: 'eraser',
    tooltip: 'Vertex eraser (<kbd>e</kbd>): click or drag to remove polygon vertices inside\n'
      + 'the cursor circle from any region.' },
];
