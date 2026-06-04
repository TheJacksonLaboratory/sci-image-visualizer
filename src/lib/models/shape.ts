import { Region, Polygon, Rectangle } from './region';
import { Datum, Font, Shape, ShapeLabel, ShapeLine, XAxisName, YAxisName } from 'plotly.js-dist-min';

export class ShapeSelection implements Shape {

  /** Stable, unique identity carried alongside the shape so it round-trips
   *  through Plotly's relayout untouched. Plotly preserves unknown
   *  properties on shape objects, so this survives the same way `legend`
   *  and `fileName` already do. */
  id!: number;
  name!: string;
  fillcolor!: string;
  // label takes the form
  // { text: legend, texttemplate: legend, font: { color: '#FFF000' }, textposition: 'top left' }
  // or can be an empty object {} if no label is to be shown
  label!: Partial<ShapeLabel>;
  layer!: 'below' | 'above';
  legendgroup!: string;
  legendgrouptitle!: { text: string; font?: Partial<Font> };
  legendrank!: number;
  line!: Partial<ShapeLine>;
  opacity!: number;
  path!: string;
  showlegend!: boolean;
  templateitemname!: string;
  type!: 'rect' | 'circle' | 'line' | 'path';
  visible!: boolean | 'legendonly';
  x0!: Datum;
  x1!: Datum;
  xanchor!: number | string;
  xref!: 'paper' | XAxisName;
  xsizemode!: 'scaled' | 'pixel';
  y0!: Datum;
  y1!: Datum;
  yanchor!: number | string;
  yref!: 'paper' | YAxisName;
  ysizemode!: 'scaled' | 'pixel';
  editable = true;
  // legend text for the region (used for classes) - value used in label.text and label.texttemplate
  legend!: any;
  // file name of the file for which the region was created
  fileName!: string | undefined;
  // tags an intensity-profile line ROI so it round-trips through Plotly and the
  // region store as a profile (excluded from the Regions tab + exports).
  kind?: 'profile';

  /**
   * Returns a Region object based on the shape type.
   */
  public getRegion(): Region {
    const region = new Region();
    region.id = this.id;
    region.name = this.name;
    // The region's colour lives on line.color (see Region.getShape); fillcolor
    // is only set for the active-shape highlight. Restore the class label from
    // legend too. Without these, getRegions() — which the OSD region overlay
    // renders from — returned undefined colour AND label, so OSD drew every
    // region in the default colour with no label (unlike Plotly, which renders
    // its shape array directly).
    region.color = this.line?.color ?? this.fillcolor;
    region.label = this.legend;
    if (this.kind === 'profile') region.kind = 'profile';
    if (this.type === 'rect') {
      region.bounds = new Rectangle();
      region.bounds.x = this.x0 as number;
      region.bounds.y = this.y0 as number;
      region.bounds.width = (this.x1 as number) - (this.x0 as number);
      region.bounds.height = (this.y1 as number) - (this.y0 as number);
    } else if (this.type === 'path') {
      region.bounds = new Polygon();
      const isClosed = this.path.endsWith('Z');
      const spath = isClosed ? this.path.slice(1, -1) : this.path.slice(1); // remove M and optionally Z
      const spoints = spath.split('L');
      region.bounds.npoints = spoints.length;
      region.bounds.xpoints = [];
      region.bounds.ypoints = [];
      region.bounds.coordinates = [];
      region.bounds.closed = isClosed;
      for (const point of spoints) {
        const coords = point.split(',');
        region.bounds.xpoints.push(parseFloat(coords[0]));
        region.bounds.ypoints.push(parseFloat(coords[1]));
        region.bounds.coordinates.push([parseFloat(coords[0]), parseFloat(coords[1])]);
      }
    } else {
      throw new Error(`Unsupported shape type: ${this.type}`);
    }
    return region;
  }
}
