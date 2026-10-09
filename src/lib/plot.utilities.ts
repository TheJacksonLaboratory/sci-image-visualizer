import { Polygon, Rectangle, Region } from './models/region';
import { ShapeSelection } from './models/shape';
import { parseSvgPath } from './models/geometry';
import { downloadGeoJson, regionsFromGeoJson, regionsToGeoJson } from './models/region-geojson';
import { hexToRgb, rgbToHex } from './contracts/color';

export const COLORMAP_OPTIONS = [
  {
    label: 'Sequential',
    data: null,
    children: [
      { label:'Greys', data: { value: 'GREYS_LUT', src:'assets/plotting/icons/colormap-greys.png' } },
      { label:'Purples', data: { value: 'PURPLES_LUT', src:'assets/plotting/icons/colormap-purples.png' } },
      { label:'Blues', data: { value: 'BLUES_LUT', src:'assets/plotting/icons/colormap-blues.png' } },
      { label:'Greens', data: { value: 'GREENS_LUT', src:'assets/plotting/icons/colormap-greens.png' } },
      { label:'Oranges', data: { value: 'ORANGES_LUT', src:'assets/plotting/icons/colormap-oranges.png' } },
      { label:'Reds', data: { value: 'Reds', src:'assets/plotting/icons/colormap-reds.png' } },
      { label:'YlOrBr', data: { value: 'YLORBR_LUT', src:'assets/plotting/icons/colormap-ylorbr.png' } },
      { label:'YlOrRd', data: { value: 'YLORRD_LUT', src:'assets/plotting/icons/colormap-ylorrd.png' } },
      { label:'OrRd', data: { value: 'ORRD_LUT', src:'assets/plotting/icons/colormap-orrd.png' } },
      { label:'PuRd', data: { value: 'PURD_LUT', src:'assets/plotting/icons/colormap-purd.png' } },
      { label:'RdPu', data: { value: 'RDPU_LUT', src:'assets/plotting/icons/colormap-rdpu.png' } },
      { label:'BuPu', data: { value: 'BUPU_LUT', src:'assets/plotting/icons/colormap-bupu.png' } },
      { label:'GnBu', data: { value: 'GNBU_LUT', src:'assets/plotting/icons/colormap-gnbu.png' } },
      { label:'YlGnBu', data: { value: 'YLGNBU_LUT', src:'assets/plotting/icons/colormap-ylgnbu.png' } },
      { label:'PuBuGn', data: { value: 'PUBUGN_LUT', src:'assets/plotting/icons/colormap-pubugn.png' } },
      { label:'BuGn', data: { value: 'BUGN_LUT', src:'assets/plotting/icons/colormap-bugn.png' } },
      { label:'YlGn', data: { value: 'YLGN_LUT', src:'assets/plotting/icons/colormap-ylgn.png' } },
      { label:'Greys Inv', data: { value: 'Greys', src:'assets/plotting/icons/colormap-greys-inv.png' } },
      { label:'Greens Inv', data: { value: 'Greens', src:'assets/plotting/icons/colormap-greens-inv.png' } },
      { label:'YlOrRd Inv', data: { value: 'YlOrRd', src:'assets/plotting/icons/colormap-ylorrd-inv.png' } },
      { label:'YlGnBu Inv', data: { value: 'YlGnBu', src:'assets/plotting/icons/colormap-ylgnbu-inv.png' } },
    ]
  },
  {
    label: 'Sequential (2)',
    data: null,
    children: [
      { label: 'binary', data: { value: 'BINARY_LUT', src: 'assets/plotting/icons/colormap-binary.png' } },
      { label: 'gist_yarg', data: { value: 'GIST_YARG_LUT', src: 'assets/plotting/icons/colormap-gist_yarg.png' } },
      { label: 'gist_gray', data: { value: 'GIST_GRAY_LUT', src: 'assets/plotting/icons/colormap-gist_gray.png' } },
      { label: 'gray', data: { value: 'GRAY_LUT', src: 'assets/plotting/icons/colormap-gray.png' } },
      { label: 'bone', data: { value: 'BONE_LUT', src: 'assets/plotting/icons/colormap-bone.png' } },
      { label: 'pink', data: { value: 'PINK_LUT', src: 'assets/plotting/icons/colormap-pink.png' } },
      { label: 'spring', data: { value: 'SPRING_LUT', src: 'assets/plotting/icons/colormap-spring.png' } },
      { label: 'summer', data: { value: 'SUMMER_LUT', src: 'assets/plotting/icons/colormap-summer.png' } },
      { label: 'autumn', data: { value: 'AUTUMN_LUT', src: 'assets/plotting/icons/colormap-autumn.png' } },
      { label: 'winter', data: { value: 'WINTER_LUT', src: 'assets/plotting/icons/colormap-winter.png' } },
      { label: 'cool', data: { value: 'COOL_LUT', src: 'assets/plotting/icons/colormap-cool.png' } },
      { label: 'Wistia', data: { value: 'WISTIA_LUT', src: 'assets/plotting/icons/colormap-wistia.png' } },
      { label: 'hot', data: { value: 'HOT_LUT', src: 'assets/plotting/icons/colormap-hot.png' } },
      { label: 'afmhot', data: { value: 'AFMHOT_LUT', src: 'assets/plotting/icons/colormap-afmhot.png' } },
      { label: 'gist_heat', data: { value: 'GIST_HEAT_LUT', src: 'assets/plotting/icons/colormap-gist_heat.png' } },
      { label: 'copper', data: { value: 'COPPER_LUT', src: 'assets/plotting/icons/colormap-copper.png' } },
      { label:'Bluered', data: { value: 'Bluered', src:'assets/plotting/icons/colormap-bluered.png' } },

    ]
  },
  {
    label: 'Perceptually Uniform Sequential',
    data: null,
    children: [
      { label:'Viridis', data: { value: 'Viridis', src:'assets/plotting/icons/colormap-viridis.png' } },
      { label: 'Magma', data: { value: 'MAGMA_LUT', src:'assets/plotting/icons/colormap-magma.png' } },
      { label: 'Inferno', data: { value: 'INFERNO_LUT', src:'assets/plotting/icons/colormap-inferno.png' } },
      { label:'Cividis', data: { value: 'Cividis', src:'assets/plotting/icons/colormap-cividis.png' } },
      { label:'Electric', data: { value: 'Electric', src: 'assets/plotting/icons/colormap-electric.png' } },
      { label:'Plasma', data: { value: 'PLASMA_LUT', src:'assets/plotting/icons/colormap-plasma.png' } },
    ]
  },
  {
    label: 'Diverging',
    data: null,
    children: [
      { label:'PiYG', data: { value: 'PIYG_LUT', src:'assets/plotting/icons/colormap-piyg.png' } },
      { label:'PRGn', data: { value: 'PRGN_LUT', src:'assets/plotting/icons/colormap-prgn.png' } },
      { label:'BrBG', data: { value: 'BRBG_LUT', src:'assets/plotting/icons/colormap-brbg.png' } },
      { label:'PuOr', data: { value: 'PUOR_LUT', src:'assets/plotting/icons/colormap-puor.png' } },
      { label:'RdGy', data: { value: 'RDGY_LUT', src:'assets/plotting/icons/colormap-rdgy.png' } },
      { label:'RdBu', data: { value: 'RDBU_LUT', src:'assets/plotting/icons/colormap-rdbu.png' } },
      { label:'RdYlBu', data: { value: 'RDYLBU_LUT', src:'assets/plotting/icons/colormap-rdylbu.png' } },
      { label:'RdYlGn', data: { value: 'RDYLGN_LUT', src:'assets/plotting/icons/colormap-rdylgn.png' } },
      { label:'Spectral', data: { value: 'SPECTRAL_LUT', src:'assets/plotting/icons/colormap-spectral.png' } },
      { label:'coolwarm', data: { value: 'COOLWARM_LUT', src:'assets/plotting/icons/colormap-coolwarm.png' } },
      { label:'bwr', data: { value: 'BWR_LUT', src:'assets/plotting/icons/colormap-bwr.png' } },
      { label:'seismic', data: { value: 'SEISMIC_LUT', src:'assets/plotting/icons/colormap-seismic.png' } },
      { label:'berlin', data: { value: 'BERLIN_LUT', src:'assets/plotting/icons/colormap-berlin.png' } },
      { label:'managua', data: { value: 'MANAGUA_LUT', src:'assets/plotting/icons/colormap-managua.png' } },
      { label:'vanimo', data: { value: 'VANIMO_LUT', src:'assets/plotting/icons/colormap-vanimo.png' } },
      { label:'Picnic', data: { value: 'Picnic', src:'assets/plotting/icons/colormap-picnic.png' } },
      { label:'Portland', data: { value: 'Portland', src:'assets/plotting/icons/colormap-portland.png' } },

    ]
  },
  {
    label: 'Cyclic',
    data: null,
    children: [
      { label:'twilight', data: { value: 'TWILIGHT_LUT', src:'assets/plotting/icons/colormap-twilight.png' } },
      { label:'twilight_shifted', data: { value: 'TWILIGHT_SHIFTED_LUT', src:'assets/plotting/icons/colormap-twilight_shifted.png' } },
      { label: 'hsv', data: { value: 'HSV_LUT', src: 'assets/plotting/icons/colormap-hsv.png' } },
    ]
  },
  {
    label: 'Qualitative',
    data: null,
    children: [
      { label:'Pastel1', data: { value: 'PASTEL1_LUT', src:'assets/plotting/icons/colormap-Pastel1.png' } },
      { label:'Pastel2', data: { value: 'PASTEL2_LUT', src:'assets/plotting/icons/colormap-pastel2.png' } },
      { label:'Accent', data: { value: 'ACCENT_LUT', src:'assets/plotting/icons/colormap-accent.png' } },
      { label:'Dark2', data: { value: 'DARK2_LUT', src:'assets/plotting/icons/colormap-dark2.png' } },
      { label:'Set1', data: { value: 'SET1_LUT', src:'assets/plotting/icons/colormap-set1.png' } },
      { label:'Set2', data: { value: 'SET2_LUT', src:'assets/plotting/icons/colormap-set2.png' } },
      { label:'Set3', data: { value: 'SET3_LUT', src: 'assets/plotting/icons/colormap-set3.png' } },
      { label:'tab10', data: { value: 'TAB10_LUT', src:'assets/plotting/icons/colormap-tab10.png' } },
      { label:'tab20', data: { value: 'TAB20_LUT', src:'assets/plotting/icons/colormap-tab20.png' } },
      { label:'tab20b', data: { value: 'TAB20B_LUT', src:'assets/plotting/icons/colormap-tab20b.png' } },
      { label:'tab20c', data: { value: 'TAB20C_LUT', src: 'assets/plotting/icons/colormap-tab20c.png' } }
    ]
  },
  {
    label: 'Miscellaneous',
    data: null,
    children: [
      { label:'flag', data: { value: 'FLAG_LUT', src: 'assets/plotting/icons/colormap-flag.png' } },
      { label:'prism', data: { value: 'PRISM_LUT', src: 'assets/plotting/icons/colormap-prism.png' } },
      { label:'ocean', data: { value: 'OCEAN_LUT', src: 'assets/plotting/icons/colormap-ocean.png' } },
      { label:'gist_earth', data: { value: 'GIST_EARTH_LUT', src: 'assets/plotting/icons/colormap-gist_earth.png' } },
      { label:'terrain', data: { value: 'TERRAIN_LUT', src: 'assets/plotting/icons/colormap-terrain.png' } },
      { label:'gist_stern', data: { value: 'GIST_STERN_LUT', src: 'assets/plotting/icons/colormap-gist_stern.png' } },
      { label:'gnuplot', data: { value: 'GNUPLOT_LUT', src: 'assets/plotting/icons/colormap-gnuplot.png' } },
      { label:'gnuplot2', data: { value: 'GNUPLOT2_LUT', src: 'assets/plotting/icons/colormap-gnuplot2.png' } },
      { label:'CMRmap', data: { value: 'CMRMAP_LUT', src: 'assets/plotting/icons/colormap-cmrmap.png' } },
      { label:'cubehelix', data: { value: 'CUBEHELIX_LUT', src: 'assets/plotting/icons/colormap-cubehelix.png' } },
      { label:'brg', data: { value: 'BRG_LUT', src: 'assets/plotting/icons/colormap-brg.png' } },
      { label:'gist_rainbow', data: { value: 'GIST_RAINBOW_LUT', src: 'assets/plotting/icons/colormap-gist_rainbow.png' } },
      { label:'rainbow', data: { value: 'RAINBOW_LUT', src:'assets/plotting/icons/colormap-rainbow.png' } },
      { label:'jet', data: { value: 'JET_LUT', src:'assets/plotting/icons/colormap-jet.png' } },
      { label:'turbo', data: { value: 'TURBO_LUT', src: 'assets/plotting/icons/colormap-turbo.png' } },
      { label:'nipy_spectral', data: { value: 'NIPY_SPECTRAL_LUT', src: 'assets/plotting/icons/colormap-nipy_spectral.png' } },
      { label:'gist_ncar', data: { value: 'GIST_NCAR_LUT', src: 'assets/plotting/icons/colormap-gist_ncar.png' } },
      { label:'Blackbody', data: { value: 'Blackbody', src:'assets/plotting/icons/colormap-blackbody.png' } },
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
   * The on-screen box a plot div is laid out in: the bounding rectangle of the
   * element with id `div`'s parent (callers pass the plot div's own id). An
   * empty Rectangle when there is no such element or it has no parent.
   * @param div
   */
  public getDomRectangle(div: string) {
    const domRect = new Rectangle();
    const parent = document.getElementById(div)?.parentElement;
    if (parent) {
      const rect = parent.getBoundingClientRect();
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
      const { xpoints, ypoints, closed } = parseSvgPath(fig.path as string);
      poly.npoints = xpoints.length;
      poly.xpoints = this.round(xpoints);
      poly.ypoints = this.round(ypoints);
      poly.closed = closed;
    } else if (fig.type === 'rect') {
      poly.npoints = 4;
      poly.xpoints = this.round([fig.x0, fig.x1, fig.x1, fig.x0]);
      poly.ypoints = this.round([fig.y1, fig.y1, fig.y0, fig.y0]);
    } else {
      console.warn('[visualizer] ignoring an unrecognised shape', fig?.type);
      return null;
    }
    return poly;
  }

  /**
   * Rounds a list of numbers
   * @param a
   */
  public round(a: number[]): number[] {
    const b: number[] = [];
    a.forEach((d: number) => b.push(Math.round(d)));
    return b;
  }

  /**
   * Returns true if the zoom is the same as the image size
   * @param rect Rectangle area
   * @param trueImgSize
   * @return true if rect is out of image size boundary
   */
  public isZoomSameAsImgSize(rect: Rectangle, trueImgSize: number[]) {
    return rect.x === trueImgSize[0] && rect.y === trueImgSize[2]
      && rect.width === trueImgSize[1] && rect.height === trueImgSize[3];
  }

  /**
   * Download a GeoJSON string as `<baseName without extension>.geojson`
   * (`rois.geojson` without a base name).
   */
  public saveToFile(jsonString: string, baseName?: string) {
    downloadGeoJson(jsonString, baseName);
  }

  /** Parse GeoJSON into regions; see {@link regionsFromGeoJson} in `models/region-geojson`. */
  public importROIsFromGeoJson(geoJsonStr: string): Region[] {
    return regionsFromGeoJson(geoJsonStr);
  }

  /** Serialise regions as GeoJSON; see {@link regionsToGeoJson} in `models/region-geojson`. */
  public exportROIsToGeoJson(rois: Region[]): string {
    return regionsToGeoJson(rois);
  }

  /** `#rrggbb` for an RGB triple; see {@link rgbToHex} in `contracts/color`. */
  public rgbToHex(r: number, g: number, b: number): string {
    return rgbToHex([r, g, b]);
  }

  /** RGB for a hex colour (`#rgb` / `#rrggbb`); black when missing or unparseable. */
  public hexToRgb(hex: string | undefined): number[] {
    return hexToRgb(hex) ?? [0, 0, 0];
  }

}
