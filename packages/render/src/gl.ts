import type { Surface } from './surface';
import { createSurface } from './surface';

export interface Tex {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
}

export type UniformValue = number | boolean | number[] | Float32Array | Tex | WebGLTexture3D;
export interface WebGLTexture3D {
  tex3d: WebGLTexture;
  size: number;
}

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
uniform float uFlip;
void main() {
  vUv = aPos;
  vec2 p = aPos * 2.0 - 1.0;
  if (uFlip > 0.5) p.y = -p.y;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/** Common GLSL helpers injected in every filter shader. */
export const GLSL_PRELUDE = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uSize;
uniform float uTime;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec4 premul(vec4 c) { return vec4(c.rgb * c.a, c.a); }
vec4 unpremul(vec4 c) { return c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
vec4 sampleP(sampler2D t, vec2 uv) { return premul(texture(t, uv)); }
`;

/**
 * Thin WebGL2 wrapper: compiles shaders on demand, manages pooled render targets and runs
 * full-screen passes. All textures hold straight (non-premultiplied) alpha.
 */
export class GLPipeline {
  readonly canvas: Surface;
  readonly gl: WebGL2RenderingContext;
  private programs = new Map<string, { prog: WebGLProgram; uniforms: Map<string, WebGLUniformLocation | null> }>();
  private pool: Tex[] = [];
  private inUse = new Set<Tex>();
  private quad: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private texFormat: { internal: number; type: number };
  time = 0;

  /** True when running on a software rasterizer (SwiftShader / llvmpipe). */
  readonly software: boolean;

  /**
   * @param precision 'half' uses RGBA16F intermediates (less banding), 'byte' uses RGBA8 (faster on
   * software renderers). 'auto' picks byte on software GL.
   */
  constructor(width = 1, height = 1, precision: 'auto' | 'half' | 'byte' = 'auto') {
    this.canvas = createSurface(width, height);
    const gl = (this.canvas as OffscreenCanvas).getContext('webgl2', {
      premultipliedAlpha: false,
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    const floatOk = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    this.software = /swiftshader|llvmpipe|software/i.test(rendererName);
    const useHalf = floatOk && (precision === 'half' || (precision === 'auto' && !this.software));
    this.texFormat = useHalf ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.disable(gl.BLEND);
  }

  private program(fragSrc: string) {
    let p = this.programs.get(fragSrc);
    if (p) return p;
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        throw new Error(`Shader compile error: ${log}\n${src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')}`);
      }
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Program link error: ${gl.getProgramInfoLog(prog)}`);
    p = { prog, uniforms: new Map() };
    this.programs.set(fragSrc, p);
    return p;
  }

  /** Allocates (or reuses) a render target. */
  target(width: number, height: number): Tex {
    const gl = this.gl;
    const idx = this.pool.findIndex((t) => t.width === width && t.height === height);
    if (idx >= 0) {
      const t = this.pool.splice(idx, 1)[0]!;
      this.inUse.add(t);
      return t;
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.texFormat.internal, width, height, 0, gl.RGBA, this.texFormat.type, null);
    this.texParams();
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const t = { tex, fbo, width, height };
    this.inUse.add(t);
    return t;
  }

  release(t: Tex | undefined | null): void {
    if (!t || !this.inUse.has(t)) return;
    this.inUse.delete(t);
    this.pool.push(t);
    if (this.pool.length > 24) {
      const old = this.pool.shift()!;
      this.gl.deleteTexture(old.tex);
      this.gl.deleteFramebuffer(old.fbo);
    }
  }

  /** Releases every texture handed out (call at end of a frame). */
  releaseAll(): void {
    for (const t of [...this.inUse]) this.release(t);
  }

  private texParams(filter: number = this.gl.LINEAR) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Uploads a canvas / image / bitmap into a new render target. */
  upload(src: TexImageSource, width?: number, height?: number): Tex {
    const gl = this.gl;
    const w = width ?? (src as { width: number }).width;
    const h = height ?? (src as { height: number }).height;
    const t = this.target(w, h);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    // Re-specify as RGBA8 from the source, then copy into the float target via a pass.
    const tmp = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tmp);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.texParams();
    this.run(COPY_FRAG, { uTex: { tex: tmp, fbo: null as unknown as WebGLFramebuffer, width: w, height: h } }, t);
    gl.deleteTexture(tmp);
    return t;
  }

  /** Uploads raw RGBA float data as a texture (for LUTs / curves). */
  dataTexture(width: number, height: number, data: Float32Array): Tex {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
    this.texParams(gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return { tex, fbo: null as unknown as WebGLFramebuffer, width, height };
  }

  texture3D(size: number, data: Float32Array): WebGLTexture3D {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, size, size, size, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return { tex3d: tex, size };
  }

  deleteTex(t: Tex | WebGLTexture3D): void {
    if ('tex3d' in t) this.gl.deleteTexture(t.tex3d);
    else this.gl.deleteTexture(t.tex);
  }

  /**
   * Runs a fragment shader into `out` (or a new target sized like the first texture input).
   * Uniforms: numbers → float, arrays → vecN / float[], Tex → sampler2D, 3D tex → sampler3D.
   */
  run(frag: string, uniforms: Record<string, UniformValue>, out?: Tex | null, toScreen = false): Tex {
    const gl = this.gl;
    const firstTex = Object.values(uniforms).find((u) => typeof u === 'object' && u && 'tex' in u) as Tex | undefined;
    const w = out?.width ?? firstTex?.width ?? (this.canvas.width as number);
    const h = out?.height ?? firstTex?.height ?? (this.canvas.height as number);
    const target = toScreen ? null : (out ?? this.target(w, h));
    const { prog, uniforms: locs } = this.program(frag);
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    if (toScreen) {
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else gl.bindFramebuffer(gl.FRAMEBUFFER, target!.fbo);
    gl.viewport(0, 0, w, h);
    const loc = (name: string) => {
      if (!locs.has(name)) locs.set(name, gl.getUniformLocation(prog, name));
      return locs.get(name)!;
    };
    let unit = 0;
    const all: Record<string, UniformValue> = { uSize: [w, h], uTime: this.time, uFlip: toScreen ? 1 : 0, ...uniforms };
    for (const [name, v] of Object.entries(all)) {
      const l = loc(name);
      if (l === null) continue;
      if (typeof v === 'number') gl.uniform1f(l, v);
      else if (typeof v === 'boolean') gl.uniform1f(l, v ? 1 : 0);
      else if (v && typeof v === 'object' && 'tex3d' in v) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_3D, v.tex3d);
        gl.uniform1i(l, unit++);
      } else if (v && typeof v === 'object' && 'tex' in v) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, v.tex);
        gl.uniform1i(l, unit++);
      } else {
        const arr = v as number[];
        if (name.endsWith('[0]') || arr.length > 4) gl.uniform1fv(l, arr);
        else if (arr.length === 1) gl.uniform1f(l, arr[0]!);
        else if (arr.length === 2) gl.uniform2fv(l, arr);
        else if (arr.length === 3) gl.uniform3fv(l, arr);
        else gl.uniform4fv(l, arr);
      }
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return target as Tex;
  }

  /** Renders a texture to the GL canvas (top-left origin) so it can be drawn into a 2D canvas. */
  present(t: Tex): Surface {
    this.run(COPY_FRAG, { uTex: t }, null, true);
    return this.canvas;
  }

  /** Presents a texture and returns a drawable snapshot (ImageBitmap when supported). Close it after use. */
  output(t: Tex): CanvasImageSource & { close?: () => void } {
    this.present(t);
    const c = this.canvas as OffscreenCanvas;
    if (typeof c.transferToImageBitmap === 'function') return c.transferToImageBitmap();
    return this.canvas;
  }

  /** Reads back pixels (RGBA8, top-left origin). */
  readPixels(t: Tex): Uint8ClampedArray {
    this.present(t);
    const gl = this.gl;
    const out = new Uint8Array(t.width * t.height * 4);
    gl.readPixels(0, 0, t.width, t.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    // Flip rows (GL origin is bottom-left).
    const row = t.width * 4;
    const flipped = new Uint8ClampedArray(out.length);
    for (let y = 0; y < t.height; y++) flipped.set(out.subarray(y * row, (y + 1) * row), (t.height - 1 - y) * row);
    return flipped;
  }
}

export const COPY_FRAG = `${GLSL_PRELUDE}
void main() { outColor = texture(uTex, vUv); }`;
