import { Region, Polygon, Rectangle } from './region';
import { parseSvgPath } from './geometry';
import { Datum, Font, Shape, ShapeLabel, ShapeLine, XAxisName, YAxisName } from 'plotly.js-dist-min';

/**
 * A {@link Region} projected to a Plotly layout shape (`rect` or SVG `path`),
 * carrying the region's identity, class label and file name along so it
 * round-trips through Plotly's relayout. Coordinates are the plot's data
 * coordinates, which are the region's image pixels. Built by
 * {@link Region.getShape}; {@link getRegion} converts back (only `rect` and
 * `path` shapes — anything else throws).
 */
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
      const { xpoints, ypoints, closed } = parseSvgPath(this.path);
      region.bounds = Object.assign(new Polygon(), {
        npoints: xpoints.length,
        xpoints,
        ypoints,
        coordinates: xpoints.map((x, i) => [x, ypoints[i]]),
        closed,
      });
    } else {
      throw new Error(`Unsupported shape type: ${this.type}`);
    }
    return region;
  }
}
