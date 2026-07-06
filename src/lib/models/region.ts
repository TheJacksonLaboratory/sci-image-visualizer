import { ShapeSelection } from './shape';

export class Region {

  /** Stable, unique identity for selection and equality. Minted by
   *  PlotlyService when a region first enters the system. Never derived
   *  from array index — name collisions across delete/add cycles must
   *  not break PrimeNG row selection. */
  id!: number;
  name!: string;
  bounds?: Rectangle | Polygon | MultiPolygon | null = null;
  /** profile = an intensity-profile line ROI; rendered/dragged like a region but
   *  excluded from the Regions tab and exports. Use `isProfile()` to test it —
   *  it's the canonical marker that separates intensity lines (owned by the
   *  intensity tool, sampled into the inset) from annotation regions (owned by
   *  the Region Editor). Both backends (Plotly, OSD) honour it. */
  kind?: 'profile';
  color?: string; // [r, g, b]
  // class label
  label?: string;
  filename?: string;
  /** Zero-based z-slice this region belongs to within a stack — mirrors
   *  QuPath's `geometry.plane.z` (a missing plane / default plane reads back as
   *  0). Used to place/filter ROIs per slice; 0 for a plain single-plane image
   *  or a region drawn without a slice context (jit-ui#93). */
  z = 0;
  shapeColor? = '#00FFFF';
  bytesPerPixel = 8;
  /**
   * resolution is the resolution at which the region
   * was found. In order to get it in the full image
   * coordinates it will normally be 0. However if
   * there is a mistake with the resolution it may not
   * be. We return the resolution here in order to be
   * sure what it is. The server may need to be changed
   * to ensure that results regions are always returned
   * at resolution = 0
   */
  resolution = 0;
  cropped = false;
  tileNumber = 0;
  tileCoordinates: number[] | null = null;

  /** True for intensity-profile line ROIs (the intensity tool's lines). These are
   *  NOT annotation regions: they never appear in the Region Editor and editor
   *  operations (select/save/delete) must never touch them. */
  isProfile(): boolean {
    return this.kind === 'profile';
  }

  toString() {
    // if shape is rectangle
    if (this.bounds instanceof Rectangle) {
      return `x: ${this.bounds.x}, y: ${this.bounds.y},
              width: ${this.bounds.width}, height: ${this.bounds.height}`;
    } else if (this.bounds instanceof Polygon){
      let path = 'M';
      // display as path
      for (let i = 0; i < this.bounds.npoints; i++) {
        if (i < this.bounds.npoints - 1) {
          path = `${path}${this.bounds.xpoints[i]},${this.bounds.ypoints[i]}L`;
        } else {
          path = `${path}${this.bounds.xpoints[i]},${this.bounds.ypoints[i]}`;
        }
      }
      if (this.bounds.closed !== false) {
        path += 'Z';
      }
      return path;
    }
    return '';
  }

  /**
   * Returns a ShapeSelection object that can be used to
   * create a shape in Plotly.
   * @param showRegionLabel
   * @return ShapeSelection
   */
   getShape(showRegionLabel: boolean = true): ShapeSelection {
    const shape = new ShapeSelection();
    shape.id = this.id;
    shape.name = this.name;
    shape.editable = true;
    shape.line = {
      color: this.color ? this.color : this.shapeColor,
      width: 3
    };
    shape.fileName = this.filename;
    if (this.kind === 'profile') shape.kind = 'profile';
    if (showRegionLabel) {
      shape.label = {
        text: `${this.label}`,
        texttemplate: `${this.label}`,
        font: { color: this.color ? this.color : this.shapeColor },
        textposition: 'top left'
      };
    } else {
      shape.label = {};
    }
    shape.legend = this.label;

    const bnds = this.bounds;
    if (bnds != undefined) {
      if (this.isRectangle(bnds)) {
        shape.type = 'rect';
        shape.x0 = bnds.x;
        shape.y0 = bnds.y;
        shape.x1 = bnds.x + bnds.width;
        shape.y1 = bnds.y + bnds.height;
      }
      if (this.isPolygon(bnds)) {
        shape.type = 'path';
        let path = 'M';
        for (let i = 0; i < bnds.npoints; i++) {
          if (i < bnds.npoints - 1) {
            path = `${path}${bnds.xpoints[i]},${bnds.ypoints[i]}L`;
          } else {
            path = `${path}${bnds.xpoints[i]},${bnds.ypoints[i]}`;
          }
        }
        if (bnds.closed !== false) {
          path += 'Z';
        }
        shape.path = path;
      }
    }
    return shape;
  }

  isRectangle(bnds: any): bnds is Rectangle {
    return 'x' in bnds && 'y' in bnds && 'width' in bnds && 'height' in bnds;
  }

  isPolygon(bnds: any): bnds is Polygon {
    return 'npoints' in bnds && 'xpoints' in bnds && 'ypoints' in bnds;
  }
}

export class Rectangle {
  x = 0;
  y = 0;
  width = 0;
  height = 0;
}

export class Polygon {
  npoints = 0;
  xpoints: number[] = [];
  ypoints: number[] = [];
  coordinates: number[][] = [];
  /** false for open polylines; true (default) for closed polygons */
  closed = true;
  /**
   * When true the vertices are treated as bezier-spline **anchors** and the
   * region is rendered/exported as a smooth curve through them. The vertices
   * stay the editable anchors — toggling this flag is the toBezier
   * (`true`) / toPolygon (`false`), which only add/remove the curve, never move
   * the anchors. GeoJSON keeps the flattened curve as the geometry (so QuPath
   * renders it) plus the anchors + handles + flag in properties (so JIT
   * round-trips the editable bezier).
   */
  bezier = false;
  /**
   * Per-anchor cubic-bezier control-point offsets, **relative** to their anchor
   * (so they translate with it). Present only for bezier regions; initialised
   * from the Catmull-Rom construction (a smooth curve) when bezier is turned on,
   * then individually editable by dragging the handles. `handlesIn[i]` /
   * `handlesOut[i]` are `[dx, dy]` for vertex `i`.
   */
  handlesIn?: number[][];
  handlesOut?: number[][];

  /**
   * Interior rings (holes) — jit-ui#85. Each ring is a list of `[x, y]`
   * image-pixel pairs in the SAME closed-polygon convention as the exterior
   * (`coordinates`): no repeated closing point. Present only on closed polygons.
   * A point inside the exterior **and** inside any hole is OUTSIDE the region
   * (even-odd rule). Absent/empty == a solid polygon (the prior behaviour), so
   * every existing region is unaffected.
   */
  holes?: number[][][];

  /**
   * Per-hole bézier control-point offsets, parallel to {@link holes} (one entry per ring, each a
   * list of `[dx, dy]` per ring vertex, **relative** to the vertex). Present only when `bezier` is
   * on for a donut — seeded from the Catmull-Rom default and individually editable, exactly like
   * the exterior {@link handlesIn}/{@link handlesOut}. So a donut smoothed to a bézier curves its
   * holes too (jit-ui#102).
   */
  holeHandlesIn?: number[][][];
  holeHandlesOut?: number[][][];
}

/**
 * A region whose geometry is several disjoint parts — e.g. the result of merging
 * two non-touching regions, or the inverse of a blob (jit-ui#85). Each part is a
 * closed {@link Polygon} that may carry its own holes, so a MultiPolygon
 * represents "sparse bits, some with donut holes" as a single region. Maps 1:1
 * onto a GeoJSON `MultiPolygon` (and QuPath's geometry).
 *
 * A single-part MultiPolygon is equivalent to that Polygon; callers should
 * prefer a plain {@link Polygon} for one connected part.
 */
export class MultiPolygon {
  /** One or more disjoint closed polygons (each may have holes). */
  polygons: Polygon[] = [];
}

export type Bounds = Rectangle | Polygon | {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  npoints?: number;
  xpoints?: number[];
  ypoints?: number[];
};
