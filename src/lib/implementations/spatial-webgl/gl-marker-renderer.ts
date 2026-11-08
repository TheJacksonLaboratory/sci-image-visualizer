/**
 * The WebGL2 drawing of the spatial mode's fallback (no WebGPU): one disc per observation, each
 * with its own position, diameter and RGBA, plus an optional RGBA raster under them (the gene
 * map). No scene graph, no camera of its own — the host hands it the current image→canvas
 * transform every frame, so it follows whatever viewer owns the camera (OpenSeadragon).
 *
 * Markers are instanced quads rather than `gl.POINTS`: a point's size is capped by
 * `ALIASED_POINT_SIZE_RANGE` (as low as 64 px on some drivers), and a Visium spot zoomed in is
 * far larger than that. The disc edge is anti-aliased in the fragment shader, and the output is
 * premultiplied so translucent markers (opacity, the muted ones outside a selection) blend over
 * the tissue as napari-js draws them.
 */

/** Image px → canvas CSS px: `canvas = (image − origin) · scale + offset`. Origin is subtracted
 *  first so large slide coordinates keep their precision in float32. */
export interface GlTransform {
  origin: [number, number];
  scale: [number, number];
  offset: [number, number];
}

/** The markers to draw. Colours are 4 floats per marker (0–1, straight alpha) or one RGBA
 *  broadcast to all; diameters are image px, per marker or one for all. */
export interface GlMarkers {
  positions: Float32Array;
  count: number;
  diameters: Float32Array | number;
  colors: Float32Array | readonly [number, number, number, number];
  /** Smallest drawn diameter, in screen px, at any zoom. */
  minScreenPx: number;
}

/** An RGBA raster placed over an image-px rectangle. */
export interface GlRaster {
  rgba: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  /** Where it lands, in image px. */
  rect: { x: number; y: number; width: number; height: number };
}

const MARKER_VS = `#version 300 es
in vec2 a_corner;
in vec2 a_pos;
in float a_diam;
in vec4 a_color;
uniform vec2 u_origin;
uniform vec2 u_scale;
uniform vec2 u_offset;
uniform vec2 u_size;
uniform float u_minPx;
out vec2 v_local;
out float v_radius;
out vec4 v_color;
void main() {
  if (a_color.a <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float radius = max(a_diam * abs(u_scale.x), u_minPx) * 0.5;
  // One extra pixel around the disc for the anti-aliased edge.
  float half_ = radius + 1.0;
  vec2 center = (a_pos - u_origin) * u_scale + u_offset;
  vec2 p = center + a_corner * half_;
  gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);
  v_local = a_corner * half_;
  v_radius = radius;
  v_color = a_color;
}`;

const MARKER_FS = `#version 300 es
precision mediump float;
in vec2 v_local;
in float v_radius;
in vec4 v_color;
out vec4 outColor;
void main() {
  float a = clamp(v_radius + 0.5 - length(v_local), 0.0, 1.0) * v_color.a;
  if (a <= 0.0) discard;
  outColor = vec4(v_color.rgb * a, a);
}`;

const RASTER_VS = `#version 300 es
in vec2 a_corner;
uniform vec4 u_rect;
uniform vec2 u_origin;
uniform vec2 u_scale;
uniform vec2 u_offset;
uniform vec2 u_size;
out vec2 v_uv;
void main() {
  vec2 img = u_rect.xy + a_corner * u_rect.zw;
  vec2 p = (img - u_origin) * u_scale + u_offset;
  gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);
  v_uv = a_corner;
}`;

const RASTER_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() { outColor = texture(u_tex, v_uv); }`;

interface Programs {
  marker: WebGLProgram;
  raster: WebGLProgram;
  quad: WebGLBuffer;
  unitQuad: WebGLBuffer;
  pos: WebGLBuffer;
  diam: WebGLBuffer;
  color: WebGLBuffer;
  markerVao: WebGLVertexArrayObject;
  rasterVao: WebGLVertexArrayObject;
  tex: WebGLTexture;
}

/** Whether this browser can give the fallback a WebGL2 context at all. */
export function webgl2Available(doc: Document = document): boolean {
  try {
    const gl = doc.createElement('canvas').getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

export class GlMarkerRenderer {
  private gl: WebGL2RenderingContext | null;
  private progs: Programs | null = null;
  private markers: GlMarkers | null = null;
  private raster: GlRaster | null = null;
  private visible = true;
  private lost = false;
  private readonly onLost = (e: Event) => {
    e.preventDefault(); // so the browser may restore it
    this.lost = true;
    this.progs = null;
  };
  private readonly onRestored = () => {
    this.lost = false;
    this.init();
    // Everything on the GPU went with the context: upload the kept copies again.
    if (this.markers) this.uploadMarkers(this.markers);
    if (this.raster) this.uploadRaster(this.raster);
    this.restored?.();
  };

  /**
   * @param canvas   the canvas to draw into; its backing size is the caller's (see {@link resize})
   * @param restored called once a lost context is back and re-uploaded, so the host can redraw
   */
  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly restored?: () => void,
  ) {
    this.gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!this.gl) throw new Error('WebGL2 is not available');
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.init();
  }

  private init(): void {
    const gl = this.gl;
    if (!gl) return;
    const marker = link(gl, MARKER_VS, MARKER_FS);
    const raster = link(gl, RASTER_VS, RASTER_FS);
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const unitQuad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, unitQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.createBuffer()!;
    const diam = gl.createBuffer()!;
    const color = gl.createBuffer()!;

    const markerVao = gl.createVertexArray()!;
    gl.bindVertexArray(markerVao);
    const corner = gl.getAttribLocation(marker, 'a_corner');
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    const aPos = gl.getAttribLocation(marker, 'a_pos');
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(aPos, 1);
    gl.bindVertexArray(null);

    const rasterVao = gl.createVertexArray()!;
    gl.bindVertexArray(rasterVao);
    const rCorner = gl.getAttribLocation(raster, 'a_corner');
    gl.bindBuffer(gl.ARRAY_BUFFER, unitQuad);
    gl.enableVertexAttribArray(rCorner);
    gl.vertexAttribPointer(rCorner, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.progs = { marker, raster, quad, unitQuad, pos, diam, color, markerVao, rasterVao, tex };
  }

  /** Size the drawing buffer to the canvas's CSS box at `dpr` device px per CSS px. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  /** Replace the markers (null: none). */
  setMarkers(markers: GlMarkers | null): void {
    this.markers = markers;
    if (markers) this.uploadMarkers(markers);
  }

  /** Recolour the markers already set, keeping their positions on the GPU. */
  setColors(colors: GlMarkers['colors']): void {
    if (!this.markers) return;
    this.markers = { ...this.markers, colors };
    this.uploadColors(this.markers);
  }

  /** Replace the raster under the markers (null: none). */
  setRaster(raster: GlRaster | null): void {
    this.raster = raster;
    if (raster) this.uploadRaster(raster);
  }

  private uploadMarkers(m: GlMarkers): void {
    const gl = this.gl;
    const p = this.progs;
    if (!gl || !p || this.lost) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, p.pos);
    gl.bufferData(gl.ARRAY_BUFFER, m.positions.subarray(0, m.count * 2), gl.STATIC_DRAW);
    gl.bindVertexArray(p.markerVao);
    const aDiam = gl.getAttribLocation(p.marker, 'a_diam');
    if (typeof m.diameters === 'number') {
      gl.disableVertexAttribArray(aDiam);
      gl.vertexAttrib1f(aDiam, m.diameters);
    } else {
      gl.bindBuffer(gl.ARRAY_BUFFER, p.diam);
      gl.bufferData(gl.ARRAY_BUFFER, m.diameters.subarray(0, m.count), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(aDiam);
      gl.vertexAttribPointer(aDiam, 1, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(aDiam, 1);
    }
    gl.bindVertexArray(null);
    this.uploadColors(m);
  }

  private uploadColors(m: GlMarkers): void {
    const gl = this.gl;
    const p = this.progs;
    if (!gl || !p || this.lost) return;
    gl.bindVertexArray(p.markerVao);
    const aColor = gl.getAttribLocation(p.marker, 'a_color');
    if (m.colors instanceof Float32Array) {
      gl.bindBuffer(gl.ARRAY_BUFFER, p.color);
      gl.bufferData(gl.ARRAY_BUFFER, m.colors.subarray(0, m.count * 4), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aColor);
      gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(aColor, 1);
    } else {
      gl.disableVertexAttribArray(aColor);
      const [r, g, b, a] = m.colors;
      gl.vertexAttrib4f(aColor, r, g, b, a);
    }
    gl.bindVertexArray(null);
  }

  private uploadRaster(r: GlRaster): void {
    const gl = this.gl;
    const p = this.progs;
    if (!gl || !p || this.lost) return;
    gl.bindTexture(gl.TEXTURE_2D, p.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const data =
      r.rgba instanceof Uint8Array ? r.rgba : new Uint8Array(r.rgba.buffer, r.rgba.byteOffset, r.rgba.length);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, r.width, r.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  /** Draw the raster, then the markers, under transform `t` (CSS px). */
  draw(t: GlTransform, cssWidth: number, cssHeight: number): void {
    const gl = this.gl;
    const p = this.progs;
    if (!gl || !p || this.lost) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.visible || !cssWidth || !cssHeight) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const r = this.raster;
    if (r) {
      gl.useProgram(p.raster);
      this.setView(gl, p.raster, t, cssWidth, cssHeight);
      gl.uniform4f(gl.getUniformLocation(p.raster, 'u_rect'), r.rect.x, r.rect.y, r.rect.width, r.rect.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, p.tex);
      gl.uniform1i(gl.getUniformLocation(p.raster, 'u_tex'), 0);
      gl.bindVertexArray(p.rasterVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    const m = this.markers;
    if (m && m.count > 0) {
      gl.useProgram(p.marker);
      this.setView(gl, p.marker, t, cssWidth, cssHeight);
      gl.uniform1f(gl.getUniformLocation(p.marker, 'u_minPx'), m.minScreenPx);
      gl.bindVertexArray(p.markerVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, m.count);
    }
    gl.bindVertexArray(null);
  }

  private setView(gl: WebGL2RenderingContext, prog: WebGLProgram, t: GlTransform, w: number, h: number): void {
    gl.uniform2f(gl.getUniformLocation(prog, 'u_origin'), t.origin[0], t.origin[1]);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_scale'), t.scale[0], t.scale[1]);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_offset'), t.offset[0], t.offset[1]);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_size'), w, h);
  }

  /** Release the GPU objects and the context. */
  dispose(): void {
    const gl = this.gl;
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (gl && this.progs && !this.lost) {
      const p = this.progs;
      gl.deleteProgram(p.marker);
      gl.deleteProgram(p.raster);
      for (const b of [p.quad, p.unitQuad, p.pos, p.diam, p.color]) gl.deleteBuffer(b);
      gl.deleteVertexArray(p.markerVao);
      gl.deleteVertexArray(p.rasterVao);
      gl.deleteTexture(p.tex);
    }
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.gl = null;
    this.progs = null;
    this.markers = null;
    this.raster = null;
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`WebGL shader failed to compile: ${log}`);
    }
    gl.attachShader(prog, sh);
    gl.deleteShader(sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`WebGL program failed to link: ${gl.getProgramInfoLog(prog)}`);
  }
  return prog;
}
