import { parseColor, type Vec3 } from '@tasweerix/core';
import type { Geometry } from './geometry';
import { geometryBounds } from './geometry';
import { linearColor, type DrawItem, type EvalScene } from './evaluate';
import { mat4, v3, type Mat4 } from './math3d';

const VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec4 aColor;
uniform mat4 uModel;
uniform mat4 uViewProj;
uniform mat3 uNormalMat;
uniform mat4 uShadowMat;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv;
out vec4 vColor;
out vec4 vShadow;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = uNormalMat * aNormal;
  vUv = aUv;
  vColor = aColor;
  vShadow = uShadowMat * w;
  gl_Position = uViewProj * w;
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;
in vec4 vColor;
in vec4 vShadow;
out vec4 outColor;
uniform vec4 uColor;
uniform float uMetal;
uniform float uRough;
uniform float uUnlit;
uniform float uHasMap;
uniform vec3 uEmissive;
uniform sampler2D uMap;
uniform sampler2DShadow uShadowMap;
uniform float uHasShadow;
uniform float uReceiveShadow;
uniform float uShadowBias;
uniform vec2 uShadowTexel;
uniform vec3 uCamPos;
uniform vec3 uAmbient;
uniform int uNumDir;
uniform vec3 uDirDir[4];
uniform vec3 uDirColor[4];
uniform int uNumPoint;
uniform vec3 uPointPos[8];
uniform vec3 uPointColor[8];
uniform float uPointRange[8];
uniform vec3 uFogColor;
uniform vec2 uFog;
uniform float uExposure;
uniform int uToneMap;
const float PI = 3.14159265;
vec3 toLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
float dGGX(float ndh, float a) { float a2 = a * a; float d = ndh * ndh * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float gSmith(float ndv, float ndl, float r) { float k = (r + 1.0) * (r + 1.0) / 8.0; return ndv / (ndv * (1.0 - k) + k) * ndl / (ndl * (1.0 - k) + k); }
vec3 fSchlick(float c, vec3 f0) { return f0 + (1.0 - f0) * pow(1.0 - c, 5.0); }
vec3 shade(vec3 n, vec3 v, vec3 l, vec3 radiance, vec3 albedo) {
  float ndl = max(dot(n, l), 0.0);
  if (ndl <= 0.0) return vec3(0.0);
  vec3 h = normalize(v + l);
  float ndv = max(dot(n, v), 1e-4);
  float ndh = max(dot(n, h), 0.0);
  float r = clamp(uRough, 0.04, 1.0);
  vec3 f0 = mix(vec3(0.04), albedo, uMetal);
  vec3 f = fSchlick(max(dot(h, v), 0.0), f0);
  vec3 spec = dGGX(ndh, r * r) * gSmith(ndv, ndl, r) * f / (4.0 * ndv * ndl + 1e-4);
  vec3 kd = (1.0 - f) * (1.0 - uMetal);
  // Light intensities are scaled by PI so a white surface facing a unit light is white.
  return (kd * albedo / PI + spec) * radiance * PI * ndl;
}
float shadowFactor() {
  if (uHasShadow < 0.5 || uReceiveShadow < 0.5) return 1.0;
  vec3 p = vShadow.xyz / vShadow.w * 0.5 + 0.5;
  if (p.z > 1.0 || p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 1.0;
  float s = 0.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) s += texture(uShadowMap, vec3(p.xy + vec2(x, y) * uShadowTexel, p.z - uShadowBias));
  return s / 9.0;
}
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec4 base = uColor * vColor;
  if (uHasMap > 0.5) { vec4 t = texture(uMap, vUv); base *= vec4(toLinear(t.rgb), t.a); }
  if (base.a <= 0.002) discard;
  vec3 albedo = base.rgb;
  vec3 color;
  if (uUnlit > 0.5) color = albedo + uEmissive;
  else {
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 v = normalize(uCamPos - vWorld);
    color = uAmbient * albedo * (1.0 - 0.7 * uMetal);
    float sh = shadowFactor();
    for (int i = 0; i < 4; i++) { if (i >= uNumDir) break; color += shade(n, v, -uDirDir[i], uDirColor[i], albedo) * (i == 0 ? sh : 1.0); }
    for (int i = 0; i < 8; i++) {
      if (i >= uNumPoint) break;
      vec3 d = uPointPos[i] - vWorld;
      float dist = length(d);
      float att = 1.0 / (1.0 + dist * dist);
      if (uPointRange[i] > 0.0) att *= clamp(1.0 - pow(dist / uPointRange[i], 4.0), 0.0, 1.0);
      color += shade(n, v, d / max(dist, 1e-5), uPointColor[i] * att, albedo);
    }
    color += uEmissive;
  }
  if (uFog.y > 0.0) color = mix(color, uFogColor, clamp((length(vWorld - uCamPos) - uFog.x) / (uFog.y - uFog.x), 0.0, 1.0));
  color *= uExposure;
  if (uToneMap == 1) color = aces(color);
  outColor = vec4(toSrgb(clamp(color, 0.0, 1.0)) * base.a, base.a);
}`;

const DEPTH_VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
uniform mat4 uModel;
uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * uModel * vec4(aPos, 1.0); }`;
const DEPTH_FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(1.0); }`;

interface GpuMesh {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  count: number;
  hasColors: boolean;
  bounds: { min: Vec3; max: Vec3 };
  lastUsed: number;
}

/** Texture sources a frame can bind (images, decoded frames, 2D layer canvases). */
export type TexSource = TexImageSource & { width: number; height: number };

/**
 * WebGL2 renderer for evaluated 3D scenes. Owns its own context (independent of the 2D filter
 * pipeline) and returns a canvas holding the premultiplied-alpha image.
 */
export class Renderer3D {
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  private prog: { p: WebGLProgram; u: Map<string, WebGLUniformLocation | null> };
  private depthProg: { p: WebGLProgram; u: Map<string, WebGLUniformLocation | null> };
  private meshes = new Map<string, GpuMesh>();
  private staticTex = new WeakMap<object, WebGLTexture>();
  private dynTex = new Map<string, WebGLTexture>();
  private msaa?: { fbo: WebGLFramebuffer; color: WebGLRenderbuffer; depth: WebGLRenderbuffer; w: number; h: number; samples: number };
  private plain?: { fbo: WebGLFramebuffer; color: WebGLRenderbuffer; depth: WebGLRenderbuffer; w: number; h: number };
  private shadow?: { fbo: WebGLFramebuffer; tex: WebGLTexture; size: number };
  private dummyShadow: WebGLTexture;
  private white: WebGLTexture;
  private frame = 0;
  private aniso: number;
  private anisoExt: EXT_texture_filter_anisotropic | null;
  readonly maxSamples: number;

  constructor() {
    this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
    const gl = (this.canvas as OffscreenCanvas).getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: true, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available for 3D rendering');
    this.gl = gl;
    this.prog = this.program(VERT, FRAG);
    this.depthProg = this.program(DEPTH_VERT, DEPTH_FRAG);
    this.maxSamples = gl.getParameter(gl.MAX_SAMPLES) as number;
    this.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
    this.aniso = this.anisoExt ? Math.min(8, gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) : 0;
    this.white = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    this.dummyShadow = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.dummyShadow);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, 1, 1, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, new Uint32Array([0xffffffff]));
    this.shadowParams();
  }

  private program(vs: string, fs: string) {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`3D shader error: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`3D program error: ${gl.getProgramInfoLog(p)}`);
    return { p, u: new Map<string, WebGLUniformLocation | null>() };
  }

  private loc(pr: { p: WebGLProgram; u: Map<string, WebGLUniformLocation | null> }, name: string) {
    if (!pr.u.has(name)) pr.u.set(name, this.gl.getUniformLocation(pr.p, name));
    return pr.u.get(name)!;
  }

  private shadowParams() {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  }

  /** GPU buffers for a geometry, cached by key (evicted when unused for a while). */
  private mesh(key: string, build: () => Geometry): GpuMesh {
    let m = this.meshes.get(key);
    if (m) {
      m.lastUsed = this.frame;
      return m;
    }
    const g = build();
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffers: WebGLBuffer[] = [];
    const attr = (loc: number, data: Float32Array, size: number) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      buffers.push(b);
    };
    attr(0, g.positions, 3);
    attr(1, g.normals, 3);
    attr(2, g.uvs, 2);
    if (g.colors) attr(3, g.colors, 4);
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
    buffers.push(ib);
    gl.bindVertexArray(null);
    m = { vao, buffers, count: g.indices.length, hasColors: !!g.colors, bounds: geometryBounds(g), lastUsed: this.frame };
    this.meshes.set(key, m);
    return m;
  }

  private evict() {
    if (this.meshes.size < 128) return;
    for (const [k, m] of this.meshes) {
      if (this.frame - m.lastUsed > 30) {
        this.gl.deleteVertexArray(m.vao);
        m.buffers.forEach((b) => this.gl.deleteBuffer(b));
        this.meshes.delete(k);
      }
    }
  }

  private texParams(mip: boolean) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    if (this.anisoExt && this.aniso > 1) gl.texParameterf(gl.TEXTURE_2D, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, this.aniso);
  }

  private upload(tex: WebGLTexture, src: TexSource) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.texParams(true);
  }

  /** Texture for a static image (uploaded once). */
  imageTexture(src: TexSource): WebGLTexture {
    let t = this.staticTex.get(src);
    if (!t) {
      t = this.gl.createTexture()!;
      this.upload(t, src);
      this.staticTex.set(src, t);
    }
    return t;
  }

  /** Texture re-uploaded every frame (video frames, 2D layers), one slot per key. */
  dynamicTexture(key: string, src: TexSource): WebGLTexture {
    let t = this.dynTex.get(key);
    if (!t) this.dynTex.set(key, (t = this.gl.createTexture()!));
    this.upload(t, src);
    return t;
  }

  private targets(w: number, h: number, samples: number) {
    const gl = this.gl;
    const make = (s: number) => {
      const fbo = gl.createFramebuffer()!;
      const color = gl.createRenderbuffer()!;
      const depth = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, color);
      if (s > 1) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, s, gl.RGBA8, w, h);
      else gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      if (s > 1) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, s, gl.DEPTH_COMPONENT24, w, h);
      else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      return { fbo, color, depth, w, h };
    };
    const drop = (t?: { fbo: WebGLFramebuffer; color: WebGLRenderbuffer; depth: WebGLRenderbuffer }) => {
      if (!t) return;
      gl.deleteFramebuffer(t.fbo);
      gl.deleteRenderbuffer(t.color);
      gl.deleteRenderbuffer(t.depth);
    };
    if (samples > 1) {
      if (!this.msaa || this.msaa.w !== w || this.msaa.h !== h || this.msaa.samples !== samples) {
        drop(this.msaa);
        this.msaa = { ...make(samples), samples };
      }
      return this.msaa;
    }
    if (!this.plain || this.plain.w !== w || this.plain.h !== h) {
      drop(this.plain);
      this.plain = make(1);
    }
    return this.plain;
  }

  private shadowMap(size: number) {
    const gl = this.gl;
    if (this.shadow?.size === size) return this.shadow;
    if (this.shadow) {
      gl.deleteFramebuffer(this.shadow.fbo);
      gl.deleteTexture(this.shadow.tex);
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    this.shadowParams();
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    this.shadow = { fbo, tex, size };
    return this.shadow;
  }

  /**
   * Renders a scene at `width × height` pixels. `textureOf` supplies the texture source of items
   * with maps (images, video frames, rendered 2D layers).
   */
  render(scene: EvalScene, width: number, height: number, textureOf: (item: DrawItem) => { source: TexSource; dynamicKey?: string } | null): OffscreenCanvas | HTMLCanvasElement {
    const gl = this.gl;
    this.frame++;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const meshes = scene.items.map((it) => ({ it, m: this.mesh(it.geometry.key, it.geometry.build) }));
    const viewProj = mat4.multiply(scene.camera.proj(w / h), scene.camera.view);

    // ---- shadow pass (first shadow-casting directional light)
    const sun = scene.lights.find((l) => l.kind === 'directional' && l.castShadow);
    let shadowMat: Mat4 = mat4.identity();
    let shadowTex: WebGLTexture = this.dummyShadow;
    let shadowSize = 1;
    if (sun && meshes.length) {
      // Fit an orthographic light frustum around the scene's bounding sphere.
      const pts: Vec3[] = [];
      for (const { it, m } of meshes) {
        const { min, max } = m.bounds;
        for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) pts.push(mat4.transformPoint(it.matrix, [x, y, z]));
      }
      const c = pts.reduce((a, p) => v3.add(a, p), [0, 0, 0] as Vec3).map((x) => x / pts.length) as Vec3;
      const r = Math.max(1e-3, ...pts.map((p) => v3.len(v3.sub(p, c))));
      const dir = v3.normalize(sun.direction);
      const eye = v3.sub(c, v3.scale(dir, r * 2));
      const up: Vec3 = Math.abs(dir[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
      const lightVP = mat4.multiply(mat4.ortho(-r, r, -r, r, 0.01, r * 4), mat4.lookAt(eye, c, up));
      const sm = this.shadowMap(Math.max(256, Math.min(4096, scene.shadowMapSize)));
      gl.bindFramebuffer(gl.FRAMEBUFFER, sm.fbo);
      gl.viewport(0, 0, sm.size, sm.size);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.useProgram(this.depthProg.p);
      gl.uniformMatrix4fv(this.loc(this.depthProg, 'uViewProj'), false, lightVP);
      for (const { it, m } of meshes) {
        if (it.props.castShadow === false || it.props.unlit) continue;
        if (it.props.doubleSided || it.part?.doubleSided) gl.disable(gl.CULL_FACE);
        else gl.enable(gl.CULL_FACE);
        gl.uniformMatrix4fv(this.loc(this.depthProg, 'uModel'), false, it.matrix);
        gl.bindVertexArray(m.vao);
        gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
      }
      // The fragment shader maps clip space to texture space.
      shadowMat = lightVP;
      shadowTex = sm.tex;
      shadowSize = sm.size;
    }

    // ---- main pass
    const samples = Math.max(1, Math.min(scene.samples, this.maxSamples));
    const target = this.targets(w, h, samples);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, w, h);
    const bg = typeof scene.background === 'string' ? (parseColor(scene.background) as number[]) : null;
    if (bg) gl.clearColor(bg[0]! * (bg[3] ?? 1), bg[1]! * (bg[3] ?? 1), bg[2]! * (bg[3] ?? 1), bg[3] ?? 1);
    else gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    const P = this.prog;
    gl.useProgram(P.p);
    const u = (n: string) => this.loc(P, n);
    gl.uniformMatrix4fv(u('uViewProj'), false, viewProj);
    gl.uniformMatrix4fv(u('uShadowMat'), false, shadowMat);
    gl.uniform3fv(u('uCamPos'), scene.camera.position);
    gl.uniform3fv(u('uAmbient'), scene.ambient);
    const dirs = scene.lights.filter((l) => l.kind === 'directional');
    // The shadowed light must come first (the shader applies the shadow to light 0).
    if (sun) dirs.sort((a, b) => (a === sun ? -1 : b === sun ? 1 : 0));
    const points = scene.lights.filter((l) => l.kind === 'point');
    gl.uniform1i(u('uNumDir'), Math.min(4, dirs.length));
    if (dirs.length) {
      gl.uniform3fv(u('uDirDir[0]'), dirs.slice(0, 4).flatMap((l) => v3.normalize(l.direction)));
      gl.uniform3fv(u('uDirColor[0]'), dirs.slice(0, 4).flatMap((l) => l.color));
    }
    gl.uniform1i(u('uNumPoint'), Math.min(8, points.length));
    if (points.length) {
      gl.uniform3fv(u('uPointPos[0]'), points.slice(0, 8).flatMap((l) => l.position));
      gl.uniform3fv(u('uPointColor[0]'), points.slice(0, 8).flatMap((l) => l.color));
      gl.uniform1fv(u('uPointRange[0]'), points.slice(0, 8).map((l) => l.range));
    }
    gl.uniform3fv(u('uFogColor'), scene.fog?.color ?? [0, 0, 0]);
    gl.uniform2f(u('uFog'), scene.fog?.near ?? 0, scene.fog?.far ?? 0);
    gl.uniform1f(u('uExposure'), scene.exposure);
    gl.uniform1i(u('uToneMap'), scene.toneMapping === 'aces' ? 1 : 0);
    gl.uniform1f(u('uHasShadow'), sun ? 1 : 0);
    gl.uniform1f(u('uShadowBias'), 0.0015);
    gl.uniform2f(u('uShadowTexel'), 1 / shadowSize, 1 / shadowSize);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, shadowTex);
    gl.uniform1i(u('uShadowMap'), 1);
    gl.uniform1i(u('uMap'), 0);

    // Opaque first (front to back), then transparent (back to front) without depth writes.
    const camPos = scene.camera.position;
    const depthOf = (it: DrawItem) => v3.len(v3.sub([it.matrix[12]!, it.matrix[13]!, it.matrix[14]!], camPos));
    const isTransparent = (it: DrawItem) => it.opacity < 1 || !!it.props.transparent || !!it.part?.transparent || (it.part?.color?.[3] ?? 1) < 1;
    const opaque = meshes.filter((x) => !isTransparent(x.it)).sort((a, b) => depthOf(a.it) - depthOf(b.it));
    const transparent = meshes.filter((x) => isTransparent(x.it)).sort((a, b) => depthOf(b.it) - depthOf(a.it));
    const draw = ({ it, m }: (typeof meshes)[number]) => {
      const p = it.props;
      const col = linearColor(p.color);
      const pc = it.part?.color ?? [1, 1, 1, 1];
      // Model colors are linear already; node colors tint them.
      gl.uniform4f(u('uColor'), col[0] * pc[0]!, col[1] * pc[1]!, col[2] * pc[2]!, col[3] * pc[3]! * it.opacity);
      gl.uniform1f(u('uMetal'), it.part?.metalness !== undefined && it.props.metalness === 0 ? it.part.metalness : p.metalness);
      gl.uniform1f(u('uRough'), it.part?.roughness !== undefined && it.props.roughness === 0.5 ? it.part.roughness : p.roughness);
      gl.uniform1f(u('uUnlit'), p.unlit ? 1 : 0);
      gl.uniform1f(u('uReceiveShadow'), p.receiveShadow === false ? 0 : 1);
      const em = linearColor(p.emissive, [0, 0, 0, 1]);
      const pe = it.part?.emissive ?? [0, 0, 0];
      const ei = p.emissiveIntensity ?? 1;
      gl.uniform3f(u('uEmissive'), (em[0] + pe[0]) * ei, (em[1] + pe[1]) * ei, (em[2] + pe[2]) * ei);
      const tex = textureOf(it);
      gl.activeTexture(gl.TEXTURE0);
      if (tex) {
        gl.bindTexture(gl.TEXTURE_2D, tex.dynamicKey ? this.dynamicTexture(tex.dynamicKey, tex.source) : this.imageTexture(tex.source));
        gl.uniform1f(u('uHasMap'), 1);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, this.white);
        gl.uniform1f(u('uHasMap'), 0);
      }
      if (p.doubleSided || it.part?.doubleSided) gl.disable(gl.CULL_FACE);
      else {
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
      }
      gl.uniformMatrix4fv(u('uModel'), false, it.matrix);
      gl.uniformMatrix3fv(u('uNormalMat'), false, mat4.normalMatrix(it.matrix));
      gl.bindVertexArray(m.vao);
      if (!m.hasColors) gl.vertexAttrib4f(3, 1, 1, 1, 1);
      gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
    };
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    opaque.forEach(draw);
    if (transparent.length) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      transparent.forEach(draw);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);

    // ---- resolve into the canvas
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.evict();
    return this.canvas;
  }

  /** Reads the last rendered image (RGBA8, top-left origin, premultiplied). */
  readPixels(): Uint8Array {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const out = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    const row = w * 4;
    const flipped = new Uint8Array(out.length);
    for (let y = 0; y < h; y++) flipped.set(out.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
    return flipped;
  }
}
