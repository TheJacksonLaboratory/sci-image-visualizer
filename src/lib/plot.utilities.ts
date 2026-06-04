import { Polygon, Rectangle, Region } from './models/region';
import { ShapeSelection } from './models/shape';
import { resolveHandles, bezierCurveFromHandles } from './models/bezier';
import { saveAs } from 'file-saver';

export const COLORMAP_OPTIONS = [
  {
    label: 'Sequential',
    data: null,
    children: [
      { label:'Greys', data: { value: 'GREYS_LUT', src:'../assets/icons/colormap-greys.png' } },
      { label:'Purples', data: { value: 'PURPLES_LUT', src:'../assets/icons/colormap-purples.png' } },
      { label:'Blues', data: { value: 'BLUES_LUT', src:'../assets/icons/colormap-blues.png' } },
      { label:'Greens', data: { value: 'GREENS_LUT', src:'../assets/icons/colormap-greens.png' } },
      { label:'Oranges', data: { value: 'ORANGES_LUT', src:'../assets/icons/colormap-oranges.png' } },
      { label:'Reds', data: { value: 'Reds', src:'../assets/icons/colormap-reds.png' } },
      { label:'YlOrBr', data: { value: 'YLORBR_LUT', src:'../assets/icons/colormap-ylorbr.png' } },
      { label:'YlOrRd', data: { value: 'YLORRD_LUT', src:'../assets/icons/colormap-ylorrd.png' } },
      { label:'OrRd', data: { value: 'ORRD_LUT', src:'../assets/icons/colormap-orrd.png' } },
      { label:'PuRd', data: { value: 'PURD_LUT', src:'../assets/icons/colormap-purd.png' } },
      { label:'RdPu', data: { value: 'RDPU_LUT', src:'../assets/icons/colormap-rdpu.png' } },
      { label:'BuPu', data: { value: 'BUPU_LUT', src:'../assets/icons/colormap-bupu.png' } },
      { label:'GnBu', data: { value: 'GNBU_LUT', src:'../assets/icons/colormap-gnbu.png' } },
      { label:'YlGnBu', data: { value: 'YLGNBU_LUT', src:'../assets/icons/colormap-ylgnbu.png' } },
      { label:'PuBuGn', data: { value: 'PUBUGN_LUT', src:'../assets/icons/colormap-pubugn.png' } },
      { label:'BuGn', data: { value: 'BUGN_LUT', src:'../assets/icons/colormap-bugn.png' } },
      { label:'YlGn', data: { value: 'YLGN_LUT', src:'../assets/icons/colormap-ylgn.png' } },
      { label:'Greys Inv', data: { value: 'Greys', src:'../assets/icons/colormap-greys-inv.png' } },
      { label:'Greens Inv', data: { value: 'Greens', src:'../assets/icons/colormap-greens-inv.png' } },
      { label:'YlOrRd Inv', data: { value: 'YlOrRd', src:'../assets/icons/colormap-ylorrd-inv.png' } },
      { label:'YlGnBu Inv', data: { value: 'YlGnBu', src:'../assets/icons/colormap-ylgnbu-inv.png' } },
    ]
  },
  {
    label: 'Sequential (2)',
    data: null,
    children: [
      { label: 'binary', data: { value: 'BINARY_LUT', src: '../assets/icons/colormap-binary.png' } },
      { label: 'gist_yarg', data: { value: 'GIST_YARG_LUT', src: '../assets/icons/colormap-gist_yarg.png' } },
      { label: 'gist_gray', data: { value: 'GIST_GRAY_LUT', src: '../assets/icons/colormap-gist_gray.png' } },
      { label: 'gray', data: { value: 'GRAY_LUT', src: '../assets/icons/colormap-gray.png' } },
      { label: 'bone', data: { value: 'BONE_LUT', src: '../assets/icons/colormap-bone.png' } },
      { label: 'pink', data: { value: 'PINK_LUT', src: '../assets/icons/colormap-pink.png' } },
      { label: 'spring', data: { value: 'SPRING_LUT', src: '../assets/icons/colormap-spring.png' } },
      { label: 'summer', data: { value: 'SUMMER_LUT', src: '../assets/icons/colormap-summer.png' } },
      { label: 'autumn', data: { value: 'AUTUMN_LUT', src: '../assets/icons/colormap-autumn.png' } },
      { label: 'winter', data: { value: 'WINTER_LUT', src: '../assets/icons/colormap-winter.png' } },
      { label: 'cool', data: { value: 'COOL_LUT', src: '../assets/icons/colormap-cool.png' } },
      { label: 'Wistia', data: { value: 'WISTIA_LUT', src: '../assets/icons/colormap-wistia.png' } },
      { label: 'hot', data: { value: 'HOT_LUT', src: '../assets/icons/colormap-hot.png' } },
      { label: 'afmhot', data: { value: 'AFMHOT_LUT', src: '../assets/icons/colormap-afmhot.png' } },
      { label: 'gist_heat', data: { value: 'GIST_HEAT_LUT', src: '../assets/icons/colormap-gist_heat.png' } },
      { label: 'copper', data: { value: 'COPPER_LUT', src: '../assets/icons/colormap-copper.png' } },
      { label:'Bluered', data: { value: 'Bluered', src:'../assets/icons/colormap-bluered.png' } },

    ]
  },
  {
    label: 'Perceptually Uniform Sequential',
    data: null,
    children: [
      { label:'Viridis', data: { value: 'Viridis', src:'../assets/icons/colormap-viridis.png' } },
      { label: 'Magma', data: { value: 'MAGMA_LUT', src:'../assets/icons/colormap-magma.png' } },
      { label: 'Inferno', data: { value: 'INFERNO_LUT', src:'../assets/icons/colormap-inferno.png' } },
      { label:'Cividis', data: { value: 'Cividis', src:'../assets/icons/colormap-cividis.png' } },
      { label:'Electric', data: { value: 'Electric', src: '../assets/icons/colormap-electric.png' } },
      { label:'Plasma', data: { value: 'PLASMA_LUT', src:'../assets/icons/colormap-plasma.png' } },
    ]
  },
  {
    label: 'Diverging',
    data: null,
    children: [
      { label:'PiYG', data: { value: 'PIYG_LUT', src:'../assets/icons/colormap-piyg.png' } },
      { label:'PRGn', data: { value: 'PRGN_LUT', src:'../assets/icons/colormap-prgn.png' } },
      { label:'BrBG', data: { value: 'BRBG_LUT', src:'../assets/icons/colormap-brbg.png' } },
      { label:'PuOr', data: { value: 'PUOR_LUT', src:'../assets/icons/colormap-puor.png' } },
      { label:'RdGy', data: { value: 'RDGY_LUT', src:'../assets/icons/colormap-rdgy.png' } },
      { label:'RdBu', data: { value: 'RDBU_LUT', src:'../assets/icons/colormap-rdbu.png' } },
      { label:'RdYlBu', data: { value: 'RDYLBU_LUT', src:'../assets/icons/colormap-rdylbu.png' } },
      { label:'RdYlGn', data: { value: 'RDYLGN_LUT', src:'../assets/icons/colormap-rdylgn.png' } },
      { label:'Spectral', data: { value: 'SPECTRAL_LUT', src:'../assets/icons/colormap-spectral.png' } },
      { label:'coolwarm', data: { value: 'COOLWARM_LUT', src:'../assets/icons/colormap-coolwarm.png' } },
      { label:'bwr', data: { value: 'BWR_LUT', src:'../assets/icons/colormap-bwr.png' } },
      { label:'seismic', data: { value: 'SEISMIC_LUT', src:'../assets/icons/colormap-seismic.png' } },
      { label:'berlin', data: { value: 'BERLIN_LUT', src:'../assets/icons/colormap-berlin.png' } },
      { label:'managua', data: { value: 'MANAGUA_LUT', src:'../assets/icons/colormap-managua.png' } },
      { label:'vanimo', data: { value: 'VANIMO_LUT', src:'../assets/icons/colormap-vanimo.png' } },
      { label:'Picnic', data: { value: 'Picnic', src:'../assets/icons/colormap-picnic.png' } },
      { label:'Portland', data: { value: 'Portland', src:'../assets/icons/colormap-portland.png' } },

    ]
  },
  {
    label: 'Cyclic',
    data: null,
    children: [
      { label:'twilight', data: { value: 'TWILIGHT_LUT', src:'../assets/icons/colormap-twilight.png' } },
      { label:'twilight_shifted', data: { value: 'TWILIGHT_SHIFTED_LUT', src:'../assets/icons/colormap-twilight_shifted.png' } },
      { label: 'hsv', data: { value: 'HSV_LUT', src: '../assets/icons/colormap-hsv.png' } },
    ]
  },
  {
    label: 'Qualitative',
    data: null,
    children: [
      { label:'Pastel1', data: { value: 'PASTEL1_LUT', src:'../assets/icons/colormap-Pastel1.png' } },
      { label:'Pastel2', data: { value: 'PASTEL2_LUT', src:'../assets/icons/colormap-pastel2.png' } },
      { label:'Accent', data: { value: 'ACCENT_LUT', src:'../assets/icons/colormap-accent.png' } },
      { label:'Dark2', data: { value: 'DARK2_LUT', src:'../assets/icons/colormap-dark2.png' } },
      { label:'Set1', data: { value: 'SET1_LUT', src:'../assets/icons/colormap-set1.png' } },
      { label:'Set2', data: { value: 'SET2_LUT', src:'../assets/icons/colormap-set2.png' } },
      { label:'Set3', data: { value: 'SET3_LUT', src: '../assets/icons/colormap-set3.png' } },
      { label:'tab10', data: { value: 'TAB10_LUT', src:'../assets/icons/colormap-tab10.png' } },
      { label:'tab20', data: { value: 'TAB20_LUT', src:'../assets/icons/colormap-tab20.png' } },
      { label:'tab20b', data: { value: 'TAB20B_LUT', src:'../assets/icons/colormap-tab20b.png' } },
      { label:'tab20c', data: { value: 'TAB20C_LUT', src: '../assets/icons/colormap-tab20c.png' } }
    ]
  },
  {
    label: 'Miscellaneous',
    data: null,
    children: [
      { label:'flag', data: { value: 'FLAG_LUT', src: '../assets/icons/colormap-flag.png' } },
      { label:'prism', data: { value: 'PRISM_LUT', src: '../assets/icons/colormap-prism.png' } },
      { label:'ocean', data: { value: 'OCEAN_LUT', src: '../assets/icons/colormap-ocean.png' } },
      { label:'gist_earth', data: { value: 'GIST_EARTH_LUT', src: '../assets/icons/colormap-gist_earth.png' } },
      { label:'terrain', data: { value: 'TERRAIN_LUT', src: '../assets/icons/colormap-terrain.png' } },
      { label:'gist_stern', data: { value: 'GIST_STERN_LUT', src: '../assets/icons/colormap-gist_stern.png' } },
      { label:'gnuplot', data: { value: 'GNUPLOT_LUT', src: '../assets/icons/colormap-gnuplot.png' } },
      { label:'gnuplot2', data: { value: 'GNUPLOT2_LUT', src: '../assets/icons/colormap-gnuplot2.png' } },
      { label:'CMRmap', data: { value: 'CMRMAP_LUT', src: '../assets/icons/colormap-cmrmap.png' } },
      { label:'cubehelix', data: { value: 'CUBEHELIX_LUT', src: '../assets/icons/colormap-cubehelix.png' } },
      { label:'brg', data: { value: 'BRG_LUT', src: '../assets/icons/colormap-brg.png' } },
      { label:'gist_rainbow', data: { value: 'GIST_RAINBOW_LUT', src: '../assets/icons/colormap-gist_rainbow.png' } },
      { label:'rainbow', data: { value: 'RAINBOW_LUT', src:'../assets/icons/colormap-rainbow.png' } },
      { label:'jet', data: { value: 'JET_LUT', src:'../assets/icons/colormap-jet.png' } },
      { label:'turbo', data: { value: 'TURBO_LUT', src: '../assets/icons/colormap-turbo.png' } },
      { label:'nipy_spectral', data: { value: 'NIPY_SPECTRAL_LUT', src: '../assets/icons/colormap-nipy_spectral.png' } },
      { label:'gist_ncar', data: { value: 'GIST_NCAR_LUT', src: '../assets/icons/colormap-gist_ncar.png' } },
      { label:'Blackbody', data: { value: 'Blackbody', src:'../assets/icons/colormap-blackbody.png' } },
    ]
  }
];

export const CONFIG = {
  displaylogo: false, // Hide the plotly logo
  responsive: true, // Make the plot responsive
  displayModeBar: false,
  scrollZoom: false, // disable mouse scroll zoom
};
export const CONFIG_SURFACE = {
  displaylogo: false, // Hide the plotly logo
  responsive: true, // Make the plot responsive
  displayModeBar: false,
  scrollZoom: true, // 3D scenes orbit/zoom natively on scroll
};
export class PlotUtilities {

  /**
   * Rounds all the point coordinates of a path ('M13.54,54.566L35.44,33.3L36.22,89.6Z')
   * becomes 'M14,55L35,33L36,90Z'
   * @param path
   */
  public roundPathCoordinates(path: string) {
    const isClosed = path.endsWith('Z');
    const inner = isClosed ? path.substring(1, path.length - 1) : path.substring(1);
    let roundedPath = 'M';
    const strArray = inner.split('L');
    for (let i = 0; i < strArray.length; i++) {
      const xy = strArray[i].split(',');
      if (i < strArray.length - 1) {
        roundedPath = `${roundedPath}${Math.round(+xy[0])},${Math.round(+xy[1])}L`;
      } else {
        roundedPath = `${roundedPath}${Math.round(+xy[0])},${Math.round(+xy[1])}`;
      }
    }
    return isClosed ? roundedPath + 'Z' : roundedPath;
  }

  /**
   * Transform a 1d array into a matrix given a given width
   * @param array Uint8Array
   * @param elementsPerSubArray
   */
  public arrayToMatrix(array: any[] | Uint8Array, elementsPerSubArray: number) {
    const matrix: any[] = [];
    let i, k;
    for (i = 0, k = -1; i < array.length; i++) {
      if (i % elementsPerSubArray === 0) {
        k++;
        matrix[k] = [];
      }
      matrix[k].push(array[i]);
    }
    return matrix;
  }

  /**
   * coordinates are of the bottom left and upper right corners of the rectangle, The coordinates
   * are taken given a yAxis that is up side down (as for all images). If Zoom is out of the image boundary,
   * it will return the image size coordinates for the new rectangle.
   * @param coordinates plotly coordinates ([Xaxis.range[0], xAxis.range[1], yAxis.range[0], yaxis.range[1]])
   * @param trueImageSize true image size [0, x, 0, y]
   */
  public getRectangle(coordinates: number[], trueImageSize: number[]) {
    const rect = new Rectangle();
    // check if new image size is bigger than original image size
    if (coordinates[3] < 0) {
      coordinates[3] = 0;
    }
    if (coordinates[1] > trueImageSize[1]) {
      coordinates[1] = trueImageSize[1];
    }
    if (coordinates[2] > trueImageSize[3]) {
      coordinates[2] = trueImageSize[3];
    }
    if (coordinates[0] < 0) {
      coordinates[0] = 0;
    }
    // if coordinates outside of image left/right/top/bottom
    // we set the coordinates to the original image size.
    if (coordinates[1] < 0 || coordinates[0] > trueImageSize[1]
      || coordinates[2] < 0 || coordinates[3] > trueImageSize[3]) {
      coordinates[0] = 0;
      coordinates[1] = trueImageSize[1];
      coordinates[2] = trueImageSize[3];
      coordinates[3] = 0;
    }
    rect.x = Math.floor(coordinates[0]);
    rect.y = Math.floor(coordinates[3]);
    rect.width = Math.floor(coordinates[1] - coordinates[0]);
    rect.height = Math.floor(coordinates[2] - coordinates[3]);
    return rect;
  }

  /**
   * given a dom object (found by id), return a Rectangle of the bounding element.
   * @param div
   */
  public getDomRectangle(div: string) {
    const domRect = new Rectangle();
    const appDiv: HTMLElement | null = document.getElementById(div);
    if (appDiv && appDiv.parentNode && appDiv.parentNode.parentElement) {
      const rect = appDiv.parentNode.parentElement.getBoundingClientRect();
      domRect.x = Math.round(rect.x);
      domRect.y = Math.round(rect.y);
      domRect.width = Math.round(rect.width);
      domRect.height = Math.round(rect.height);
    }
    return domRect;
  }

  /**
   * snap region  to closest pixel in the coordinate (round the coordinates of the region)
   * @param shape
   * @private
   */
  public snapRegion(shape: ShapeSelection) {
    // if region is a polygon
    if (shape.path) {
      shape.path = this.roundPathCoordinates(shape.path);
    } else if (shape.x0 && shape.x1 && shape.y0 && shape.y1) {
      // if region is a rectangle
      if (typeof shape.x0 === 'number') {
        shape.x0 = Math.round(shape.x0);
      }
      if (typeof shape.x1 === 'number') {
        shape.x1 = Math.round(shape.x1);
      }
      if (typeof shape.y0 === 'number') {
        shape.y0 = Math.round(shape.y0);
      }
      if (typeof shape.y1 === 'number') {
        shape.y1 = Math.round(shape.y1);
      }
    }
    return shape;
  }

  /**
   * Given a figure (path or rectangle), returns a polygon
   * @param fig
   */
  public getPolygon(fig: any): any {
    const poly: any = new Polygon();
    if (fig.type === 'path') {
      const tempPath = fig.path as string;
      const isClosed = tempPath.endsWith('Z');
      const path = isClosed ? tempPath.substring(1, tempPath.length - 1) : tempPath.substring(1);
      const verts: string[] = path.split('L');
      poly.npoints = verts.length;
      poly.xpoints = [];
      poly.ypoints = [];
      poly.closed = isClosed;
      verts.forEach((pnt: any) => {
        const point = pnt.split(',');
        poly.xpoints.push(Math.round(point[0]));
        poly.ypoints.push(Math.round(point[1]));
      });
    } else if (fig.type === 'rect') {
      poly.npoints = 4;
      poly.xpoints = this.round([fig.x0, fig.x1, fig.x1, fig.x0]);
      poly.ypoints = this.round([fig.y1, fig.y1, fig.y0, fig.y0]);
    } else {
      console.log('Ignoring unrecognised shape in diagram');
      return null;
    }
    return poly;
  }

  /**
   * TESTED
   * Rounds a list of numbers
   * @param a
   */
  public round(a: number[]): number[] {
    const b: number[] = [];
    a.forEach((d: number) => b.push(Math.round(d)));
    return b;
  }

  /**
   * TESTED
   * Returns true of zoom is the same as image size
   * @param rect Rectangle area
   * @param trueImgSize
   * @return true if rect is out of image size boundary
   */
  public isZoomSameAsImgSize(rect: Rectangle, trueImgSize: number[]) {
    return rect.x === trueImgSize[0] && rect.y === trueImgSize[2]
      && rect.width === trueImgSize[1] && rect.height === trueImgSize[3];
  }

  /**
   * Save the json string to a file
   * @param jsonString
   */
  public saveToFile(jsonString: any, baseName?: string) {
    const blob = new Blob([jsonString], { type: 'application/json' });
    const stem = (baseName ?? '').replace(/\.[^/.]+$/, '').trim() || 'rois';
    saveAs(blob, `${stem}.geojson`);
  }

  /**
   * Function that imports ROIs from a geojson object
   * @param geoJsonStr
   * @return Region[]
   */
  public importROIsFromGeoJson(geoJsonStr: string): Region[] {
    const regions: Region[] = [];
    let geoJson: any;
    try {
      geoJson = JSON.parse(geoJsonStr);
    } catch (error) {
      throw new Error('Error parsing json string: ' + error);
    }
    if (!geoJson.features) {
      throw new Error('Invalid GeoJson file: must contain the \'features\' key.');
    }
    let idx = 0;
    for (const feature of geoJson.features) {
      const region = new Region();
      region.name = `shape${idx}`;
      idx++;
      if (!feature.properties || !feature.properties.classification) {
        // No classification metadata — use a default label and color.
        region.label = 'Cell';
      } else if (!feature.properties.classification.name) {
        // assume classification is a string
        region.label = feature.properties.classification;
      } else {
        // if classification is an object with a name / check color as well
        region.label = feature.properties.classification.name;
        if (feature.properties.classification.color) {
          region.color = this.rgbToHex(
            feature.properties.classification.color[0],
            feature.properties.classification.color[1],
            feature.properties.classification.color[2]
          );
        }
      }

      // JIT bezier region: the editable anchors + flag travel in properties
      // (the geometry holds the flattened curve for viewers without bezier
      // support). Reconstruct the editable bezier from the anchors.
      if (feature.properties && feature.properties.isBezier && feature.properties.bezierAnchors) {
        const anchors: number[][] = feature.properties.bezierAnchors;
        const polygon = new Polygon();
        polygon.bezier = true;
        polygon.closed = feature.geometry?.type !== 'LineString';
        polygon.npoints = anchors.length;
        polygon.xpoints = anchors.map(a => a[0]);
        polygon.ypoints = anchors.map(a => a[1]);
        polygon.coordinates = anchors.map(a => [a[0], a[1]]);
        // Restore the edited control handles when present (else they'll fall back
        // to the smooth Catmull-Rom default at render time).
        if (feature.properties.bezierHandlesIn) polygon.handlesIn = feature.properties.bezierHandlesIn;
        if (feature.properties.bezierHandlesOut) polygon.handlesOut = feature.properties.bezierHandlesOut;
        region.bounds = polygon;
        regions.push(region);
        continue;
      }

      const coordinates = feature.geometry.coordinates;
      if (!coordinates) {
        throw new Error('Invalid GeoJson file: must contain the \'coordinates\' key.');
      }
      // Open polyline: LineString geometry
      if (feature.geometry.type === 'LineString') {
        const polygon = new Polygon();
        polygon.closed = false;
        polygon.npoints = coordinates.length;
        polygon.xpoints = [];
        polygon.ypoints = [];
        polygon.coordinates = [];
        for (let i = 0; i < coordinates.length; i++) {
          polygon.xpoints.push(coordinates[i][0]);
          polygon.ypoints.push(coordinates[i][1]);
          polygon.coordinates.push([coordinates[i][0], coordinates[i][1]]);
        }
        region.bounds = polygon;
      // Polygon: check if it encodes a rectangle
      } else if (coordinates[0].length === 5
        && JSON.stringify(coordinates[0][0]) === JSON.stringify(coordinates[0][4])
        && coordinates[0][0][0] === coordinates[0][3][0]
        && coordinates[0][0][1] === coordinates[0][1][1]
        && coordinates[0][1][0] === coordinates[0][2][0]
        && coordinates[0][2][1] === coordinates[0][3][1]) {
        const rectangle = new Rectangle();
        rectangle.x = coordinates[0][0][0];
        rectangle.y = coordinates[0][0][1];
        rectangle.width = coordinates[0][2][0] - coordinates[0][0][0];
        rectangle.height = coordinates[0][2][1] - coordinates[0][0][1];
        region.bounds = rectangle;

      } else { // polygon is a freeform closed polygon
        const polygon = new Polygon();
        polygon.npoints = coordinates[0].length - 1;
        polygon.xpoints = [];
        polygon.ypoints = [];
        polygon.coordinates = [];
        for (let i = 0; i < coordinates[0].length - 1; i++) {
          polygon.xpoints.push(coordinates[0][i][0]);
          polygon.ypoints.push(coordinates[0][i][1]);
          polygon.coordinates.push([coordinates[0][i][0], coordinates[0][i][1]]);
        }
        region.bounds = polygon;
      }
      regions.push(region);
    }
    return regions;
  }

  /**
   * Function that returns a geojson object from a Plotly ROI
   * @param rois
   * @return FeatureCollection<Geometry, GeoJsonProperties>
   */
  public exportROIsToGeoJson(rois: Region[]): string {
    console.log('Exporting ROIs to GeoJson');
    console.log(rois);
    const features: any[] = [];
    for (const roi of rois.filter(r => (r as any).kind !== 'profile')) {
      if (roi.bounds instanceof Rectangle) {
        const rectangle = {
          type: 'Feature',
          properties: {
            classification: {
              name: roi.label ? roi.label : roi.name,
              color: [
                this.hexToRgb(roi?.color)[0],
                this.hexToRgb(roi?.color)[1],
                this.hexToRgb(roi?.color)[2]
              ]
            },
          },
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [roi.bounds.x, roi.bounds.y],
              [roi.bounds.x + roi.bounds.width, roi.bounds.y],
              [roi.bounds.x + roi.bounds.width, roi.bounds.y + roi.bounds.height],
              [roi.bounds.x, roi.bounds.y + roi.bounds.height],
              [roi.bounds.x, roi.bounds.y]
            ]]
          }
        };
        features.push(rectangle);
      } else if (roi.bounds instanceof Polygon) {
        const colorRgb = [
          this.hexToRgb(roi?.color)[0],
          this.hexToRgb(roi?.color)[1],
          this.hexToRgb(roi?.color)[2]
        ];
        const closed = roi.bounds.closed !== false;
        const isBezier = roi.bounds.bezier === true;
        // For a bezier region the geometry is the flattened smooth curve,
        // so a viewer without bezier support (QuPath) still renders the curve;
        // the editable anchors + flag ride along in properties for JIT.
        const geomCoords = isBezier
          ? (() => {
            const handles = resolveHandles(roi.bounds.xpoints, roi.bounds.ypoints, closed,
              roi.bounds.handlesIn, roi.bounds.handlesOut);
            const c = bezierCurveFromHandles(roi.bounds.xpoints, roi.bounds.ypoints, handles, closed);
            return c.xs.map((x, i) => [x, c.ys[i]]);
          })()
          : roi.bounds.coordinates;
        const properties: any = {
          classification: {
            name: roi.label ? roi.label : roi.name,
            color: colorRgb
          },
        };
        if (isBezier) {
          properties.isBezier = true;
          properties.bezierAnchors = roi.bounds.coordinates;
          // The editable control handles (relative offsets) travel along so JIT
          // round-trips a hand-edited curve, not just the smooth default.
          if (roi.bounds.handlesIn) properties.bezierHandlesIn = roi.bounds.handlesIn;
          if (roi.bounds.handlesOut) properties.bezierHandlesOut = roi.bounds.handlesOut;
        }
        if (closed) {
          // Close the ring. The flattened bezier curve already returns to its
          // start, so only the straight-polygon path needs the first point
          // repeated.
          const ring = isBezier ? geomCoords : [...geomCoords, geomCoords[0]];
          features.push({
            type: 'Feature',
            properties,
            geometry: { type: 'Polygon', coordinates: [ring] }
          });
        } else {
          features.push({
            type: 'Feature',
            properties,
            geometry: { type: 'LineString', coordinates: geomCoords }
          });
        }
      }
    }
    const geoJsonData = {
      features: features,
      type: 'FeatureCollection'
    };

    return JSON.stringify(geoJsonData);
  }

  public rgbToHex(r: number, g: number, b: number): string {
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  public hexToRgb(hex: string | undefined): number[] {
    let r: number, g: number, b: number;
    if (hex) {
      const bigint = parseInt(hex.slice(1), 16);
      r = (bigint >> 16) & 255;
      g = (bigint >> 8) & 255;
      b = bigint & 255;
    } else {
      r = 0;
      g = 0;
      b = 0;
    }
    return [r, g, b];
  }

}
