/**
 * Plotly layout builders for every plot type the Plotly backend renders. Pure:
 * the live service state they need (screen height, aspect lock, drag mode, the
 * current region shapes and colours) comes in through {@link ImageLayoutContext}.
 */

/** Plotly shape dicts, as `layout.shapes` takes them. */
export type PlotlyShapeDict = Record<string, unknown>;

/** The service state an image-aligned layout depends on. */
export interface ImageLayoutContext {
  screenHeight: number;
  /** Lock the y axis to x (square image pixels). */
  scaleratio: boolean;
  /** The active Plotly drag mode, or '' for none. */
  dragMode: string;
  /** The region shapes to draw over the image. */
  shapes: PlotlyShapeDict[];
  /** The active (selected) shape's fill colour. */
  fillColor: string;
  /** The outline colour of a newly drawn shape. */
  shapeColor: string;
}

/** One slider step per z-plane, each showing only its own trace. */
export function sliderSteps(sliceCount: number): Array<{ label: number; method: string; args: unknown[] }> {
  const steps = [];
  for (let i = 0; i < sliceCount; i++) {
    steps.push({
      label: i + 1,
      method: 'restyle',
      args: ['visible', Array(sliceCount).fill(false).fill(true, i, i + 1)],
    });
  }
  return steps;
}

/** Image axes over `xRange`/`yRange` (pass the y range reversed for an image). */
function imageAxes(ctx: ImageLayoutContext, xRange: number[], yRange: number[]) {
  return {
    xaxis: { constrain: 'range', constraintoward: 'center', side: 'top', ticks: '', range: xRange },
    yaxis: {
      constrain: 'range', constraintoward: 'center', range: yRange, ticks: '', ticksuffix: '  ',
      // autorange off so that Plotly does not overwrite the range for the y axis
      autorange: false,
      scaleanchor: ctx.scaleratio ? 'x' : false,
    },
  };
}

/** The heatmap / RGB image layout: image axes, the z-plane slider, the region shapes. */
export function heatmapLayout(ctx: ImageLayoutContext, xRange: number[], yRange: number[], sliceCount: number) {
  return {
    ...imageAxes(ctx, xRange, yRange),
    margin: { t: 30, b: 5, l: 55, r: 5 },
    height: ctx.screenHeight,
    sliders: [{
      pad: { t: 50 },
      currentvalue: { visible: true, prefix: 'Z-plane:', xanchor: 'right' },
      steps: sliderSteps(sliceCount),
    }],
    autosize: true,
    shapes: ctx.shapes,
    activeshape: { fillcolor: ctx.fillColor },
    dragmode: ctx.dragMode ? ctx.dragMode : false,
    newshape: { line: { color: ctx.shapeColor, width: 3 } },
  };
}

/** Image-aligned 2D axes without the z-plane slider (region scatter). */
export function overlayLayout(ctx: ImageLayoutContext, xRange: number[], yRange: number[]) {
  return {
    ...imageAxes(ctx, xRange, yRange),
    margin: { t: 30, b: 5, l: 55, r: 5 },
    height: ctx.screenHeight,
    autosize: true,
    shapes: ctx.shapes,
    dragmode: ctx.dragMode ? ctx.dragMode : false,
  };
}

/** Plain 2D chart axes (intensity profile / line plots). */
export function chartLayout(screenHeight: number) {
  return {
    margin: { t: 30, b: 45, l: 60, r: 20 },
    height: screenHeight,
    autosize: true,
    xaxis: { title: 'Position (px)' },
    yaxis: { title: 'Intensity' },
    dragmode: false,
  };
}

/** 3D scene for volumetric plot types (scatter3d, isosurface). */
export function volumeLayout(screenHeight: number) {
  return {
    margin: { t: 0, b: 0, l: 0, r: 0 },
    height: screenHeight,
    autosize: true,
    scene: {
      xaxis: { title: 'X' },
      yaxis: { title: 'Y' },
      zaxis: { title: 'Z-plane' },
      // 'cube' (not 'data'): a z-stack has far fewer planes than X/Y pixels,
      // so 'data' squashes the volume into a near-flat slab that reads as
      // empty edge-on. A cube gives the z dimension real height so the
      // isosurface/voxels are actually visible.
      aspectmode: 'cube',
    },
  };
}

/**
 * Scene layout for the surface plot: light-grey axis planes and a manual
 * aspect ratio whose z extent is `zRatio` of the x/y extent.
 */
export function surfaceLayout(zRatio: number) {
  const plane = {
    gridcolor: 'rgb(255, 255, 255)',
    zerolinecolor: 'rgb(255, 255, 255)',
    showbackground: true,
    backgroundcolor: 'rgb(230, 230,230)',
  };
  return {
    margin: { t: 0, b: 0, l: 0, r: 0 },
    scene: {
      xaxis: { ...plane },
      yaxis: { ...plane, backgroundcolor: 'rgb(230, 230, 230)' },
      zaxis: { ...plane },
      aspectratio: { x: 1, y: 1, z: zRatio },
      aspectmode: 'manual',
    },
  };
}
