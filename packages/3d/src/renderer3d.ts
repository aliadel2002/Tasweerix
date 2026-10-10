import { parseColor, type Vec3 } from '@tasweerix/core';
import type { Geometry } from './geometry';
import { geometryBounds } from './geometry';
import { linearColor, type DrawItem, type EvalScene } from './evaluate';
import { isBuiltinEnvironment, type HDRImage } from './environment';
import { mat4, v3, type Mat4 } from './math3d';

const VERT = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec4 aColor;
uniform mat4 uModel;
uniform mat4 uViewProj;
uniform mat3 uNormalMat;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv;
out vec4 vColor;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = uNormalMat * aNormal;
  vUv = aUv;
  vColor = aColor;
  gl_Position = uViewProj * w;
}`;

/** Shared GLSL: color space, tone mapping and equirectangular environment lookups. */
const COMMON = `
const float PI = 3.14159265;
uniform float uExposure;
uniform int uToneMap;
uniform vec2 uEnvRot;
vec3 toLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 finish(vec3 color) {
  color *= uExposure;
  if (uToneMap == 1) color = aces(color);
  return toSrgb(clamp(color, 0.0, 1.0));
}
// -Z at the center, +Y at the top row; uEnvRot = (cos, sin) of the environment's rotation around Y.
vec2 envUv(vec3 d) {
  vec3 r = vec3(uEnvRot.x * d.x - uEnvRot.y * d.z, d.y, uEnvRot.y * d.x + uEnvRot.x * d.z);
  return vec2(atan(r.x, -r.z) / (2.0 * PI) + 0.5, acos(clamp(r.y, -1.0, 1.0)) / PI);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArrayShadow;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;
in vec4 vColor;
out vec4 outColor;
uniform vec4 uColor;
uniform float uMetal;
uniform float uRough;
uniform float uUnlit;
uniform float uHasMap;
uniform vec3 uEmissive;
uniform sampler2D uMap;
uniform float uReceiveShadow;
uniform vec3 uCamPos;
uniform vec3 uAmbient;
uniform int uNumDir;
uniform vec3 uDirDir[4];
uniform vec3 uDirColor[4];
uniform int uNumPoint;
uniform vec3 uPointPos[8];
uniform vec3 uPointColor[8];
uniform float uPointRange[8];
// Shadows: directional maps are layers of one depth array, point lights use 6 layers (cube faces) each.
uniform sampler2DArrayShadow uDirShadow;
uniform mat4 uDirShadowMat[4];
uniform vec4 uDirShadowInfo[4];   // layer (-1 = none), normal offset, depth bias
uniform vec2 uDirShadowTexel;
uniform sampler2DArrayShadow uPointShadow;
uniform vec4 uPointShadowInfo[8]; // first layer (-1 = none), near, far, normal offset per unit distance
uniform float uPointShadowTexel;
uniform vec3 uFaceRight[6];
uniform vec3 uFaceUp[6];
// Image-based lighting: prefiltered specular (roughness per mip level) and diffuse irradiance.
uniform float uHasEnv;
uniform sampler2D uEnvSpec;
uniform sampler2D uEnvDiff;
uniform float uEnvIntensity;
uniform float uEnvLevels;
uniform vec3 uFogColor;
uniform vec2 uFog;
${COMMON}
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
float dirShadow(int i, vec3 n) {
  vec4 info = uDirShadowInfo[i];
  if (info.x < 0.0 || uReceiveShadow < 0.5) return 1.0;
  vec4 c = uDirShadowMat[i] * vec4(vWorld + n * info.y, 1.0);
  vec3 p = c.xyz / c.w * 0.5 + 0.5;
  if (p.z > 1.0 || p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 1.0;
  float s = 0.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) s += texture(uDirShadow, vec4(p.xy + vec2(x, y) * uDirShadowTexel, info.x, p.z - info.z));
  return s / 9.0;
}
float pointShadow(int i, vec3 n) {
  vec4 info = uPointShadowInfo[i];
  if (info.x < 0.0 || uReceiveShadow < 0.5) return 1.0;
  vec3 d0 = vWorld - uPointPos[i];
  vec3 d = d0 + n * (info.w * length(d0));
  vec3 a = abs(d);
  int f;
  float m;
  if (a.x >= a.y && a.x >= a.z) { f = d.x > 0.0 ? 0 : 1; m = a.x; }
  else if (a.y >= a.z) { f = d.y > 0.0 ? 2 : 3; m = a.y; }
  else { f = d.z > 0.0 ? 4 : 5; m = a.z; }
  float nr = info.y;
  float fr = info.z;
  if (m >= fr) return 1.0;
  vec2 uv = vec2(dot(d, uFaceRight[f]), dot(d, uFaceUp[f])) / m * 0.5 + 0.5;
  // Perspective depth of the face's 90° projection, compared slightly in front of the surface.
  float mz = m * 0.995;
  float z = ((fr + nr) / (fr - nr) - 2.0 * fr * nr / ((fr - nr) * mz)) * 0.5 + 0.5;
  float layer = info.x + float(f);
  float s = 0.0;
  for (int x = 0; x < 2; x++) for (int y = 0; y < 2; y++) {
    vec2 q = clamp(uv + (vec2(x, y) - 0.5) * uPointShadowTexel, vec2(0.0), vec2(1.0));
    s += texture(uPointShadow, vec4(q, layer, z));
  }
  return s / 4.0;
}
// Split-sum environment BRDF (analytic fit, Karis 2014).
vec3 envBRDF(vec3 f0, float r, float ndv) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 rr = r * c0 + c1;
  float a004 = min(rr.x * rr.x, exp2(-9.28 * ndv)) * rr.x + rr.y;
  vec2 ab = vec2(-1.04, 1.04) * a004 + rr.zw;
  return f0 * ab.x + ab.y;
}
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
    for (int i = 0; i < 4; i++) { if (i >= uNumDir) break; color += shade(n, v, -uDirDir[i], uDirColor[i], albedo) * dirShadow(i, n); }
    for (int i = 0; i < 8; i++) {
      if (i >= uNumPoint) break;
      vec3 d = uPointPos[i] - vWorld;
      float dist = length(d);
      float att = 1.0 / (1.0 + dist * dist);
      if (uPointRange[i] > 0.0) att *= clamp(1.0 - pow(dist / uPointRange[i], 4.0), 0.0, 1.0);
      if (att <= 0.0) continue;
      color += shade(n, v, d / max(dist, 1e-5), uPointColor[i] * att, albedo) * pointShadow(i, n);
    }
    if (uHasEnv > 0.5) {
      float r = clamp(uRough, 0.0, 1.0);
      float ndv = max(dot(n, v), 1e-4);
      vec3 f0 = mix(vec3(0.04), albedo, uMetal);
      vec3 F = envBRDF(f0, r, ndv);
      vec3 kd = (1.0 - F) * (1.0 - uMetal);
      vec3 irr = texture(uEnvDiff, envUv(n)).rgb;
      vec3 spec = textureLod(uEnvSpec, envUv(reflect(-v, n)), r * uEnvLevels).rgb;
      color += (kd * albedo * irr + spec * F) * uEnvIntensity;
    }
    color += uEmissive;
  }
  if (uFog.y > 0.0) color = mix(color, uFogColor, clamp((length(vWorld - uCamPos) - uFog.x) / (uFog.y - uFog.x), 0.0, 1.0));
  outColor = vec4(finish(color) * base.a, base.a);
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

/** Full-screen triangle; vNdc is the clip-space position. */
const QUAD_VERT = `#version 300 es
out vec2 vNdc;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vNdc = p;
  gl_Position = vec4(p, 1.0, 1.0);
}`;

/**
 * Environment preprocessing, one equirectangular target texel per fragment:
 * mode 0 converts a source image, 1 renders a built-in environment, 2 prefilters GGX specular
 * for `uRoughness`, 3 convolves diffuse irradiance.
 */
const ENV_FRAG = `#version 300 es
precision highp float;
in vec2 vNdc;
out vec4 outColor;
uniform int uMode;
uniform int uPreset;
uniform sampler2D uSrc;
uniform float uSrcSrgb;
uniform float uSrcLod;
uniform float uRoughness;
uniform vec2 uSrcSize;
const float PI = 3.14159265;
vec3 dirOf(vec2 uv) {
  float phi = (uv.x - 0.5) * 2.0 * PI;
  float th = uv.y * PI;
  return vec3(sin(phi) * sin(th), cos(th), -cos(phi) * sin(th));
}
vec2 uvOf(vec3 d) { return vec2(atan(d.x, -d.z) / (2.0 * PI) + 0.5, acos(clamp(d.y, -1.0, 1.0)) / PI); }
float lobe(vec3 d, vec3 axis, float size) { return smoothstep(cos(size), cos(size * 0.6), dot(d, normalize(axis))); }
vec3 preset(vec3 d) {
  if (uPreset == 0) {
    // Studio: soft gray cyclorama with a key softbox, a fill and a rim light.
    float up = d.y * 0.5 + 0.5;
    vec3 c = mix(vec3(0.18), vec3(0.62), smoothstep(0.2, 0.75, up));
    c += vec3(6.0) * lobe(d, vec3(1.0, 1.1, 1.0), 0.35);
    c += vec3(2.2) * lobe(d, vec3(-1.2, 0.4, 0.8), 0.45);
    c += vec3(3.0) * lobe(d, vec3(0.2, 0.7, -1.0), 0.3);
    return c;
  }
  // Sky: blue gradient above the horizon, warm ground below, a bright sun with a glow.
  vec3 sunDir = normalize(vec3(0.45, 0.55, -0.7));
  float h = clamp(d.y, -1.0, 1.0);
  vec3 sky = mix(vec3(0.75, 0.85, 1.0), vec3(0.12, 0.3, 0.85), pow(max(h, 0.0), 0.6));
  vec3 ground = mix(vec3(0.38, 0.34, 0.3), vec3(0.18, 0.16, 0.14), pow(clamp(-h, 0.0, 1.0), 0.5));
  vec3 c = h >= 0.0 ? sky : ground;
  float s = dot(d, sunDir);
  c += vec3(1.0, 0.95, 0.85) * (smoothstep(0.9993, 0.9997, s) * 120.0 + pow(max(s, 0.0), 256.0) * 2.0 + pow(max(s, 0.0), 8.0) * 0.1);
  return c;
}
vec3 src(vec3 d, float lod) {
  vec3 c = textureLod(uSrc, uvOf(d), lod).rgb;
  return uSrcSrgb > 0.5 ? pow(max(c, 0.0), vec3(2.2)) : c;
}
vec2 hammersley(int i, int n) {
  uint b = uint(i);
  b = (b << 16u) | (b >> 16u);
  b = ((b & 0x55555555u) << 1u) | ((b & 0xAAAAAAAAu) >> 1u);
  b = ((b & 0x33333333u) << 2u) | ((b & 0xCCCCCCCCu) >> 2u);
  b = ((b & 0x0F0F0F0Fu) << 4u) | ((b & 0xF0F0F0F0u) >> 4u);
  b = ((b & 0x00FF00FFu) << 8u) | ((b & 0xFF00FF00u) >> 8u);
  return vec2(float(i) / float(n), float(b) * 2.3283064365386963e-10);
}
mat3 basis(vec3 n) {
  vec3 up = abs(n.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(up, n));
  return mat3(t, cross(n, t), n);
}
void main() {
  // Texture row 0 (v = 0) is the top of the environment (+Y), as in the source images.
  vec3 n = dirOf(vNdc * 0.5 + 0.5);
  // Solid angle of one source texel (equirectangular, at the equator) for filtered importance sampling.
  float texelSA = 4.0 * PI / (uSrcSize.x * uSrcSize.y);
  if (uMode == 0) { outColor = vec4(src(n, uSrcLod), 1.0); return; }
  if (uMode == 1) { outColor = vec4(preset(n), 1.0); return; }
  mat3 tbn = basis(n);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  if (uMode == 2) {
    float a = max(uRoughness * uRoughness, 1e-3);
    const int N = 96;
    for (int i = 0; i < N; i++) {
      vec2 xi = hammersley(i, N);
      float cosT = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
      float sinT = sqrt(1.0 - cosT * cosT);
      float ph = 2.0 * PI * xi.x;
      vec3 h = tbn * vec3(sinT * cos(ph), sinT * sin(ph), cosT);
      vec3 l = reflect(-n, h);
      float ndl = dot(n, l);
      if (ndl <= 0.0) continue;
      // N = V = R: pdf(l) = D(h) / 4.
      float d = a * a / (PI * pow(cosT * cosT * (a * a - 1.0) + 1.0, 2.0));
      float lod = max(0.5 * log2((1.0 / (float(N) * d / 4.0 + 1e-6)) / texelSA) + 1.0, 0.0);
      sum += src(l, lod) * ndl;
      wsum += ndl;
    }
  } else {
    const int N = 256;
    for (int i = 0; i < N; i++) {
      vec2 xi = hammersley(i, N);
      // Cosine-weighted hemisphere: pdf = cos / PI.
      float cosT = sqrt(1.0 - xi.y);
      float sinT = sqrt(xi.y);
      float ph = 2.0 * PI * xi.x;
      vec3 l = tbn * vec3(sinT * cos(ph), sinT * sin(ph), cosT);
      float lod = max(0.5 * log2((1.0 / (float(N) * cosT / PI + 1e-6)) / texelSA) + 1.0, 0.0);
      sum += src(l, lod);
      wsum += 1.0;
    }
  }
  outColor = vec4(sum / max(wsum, 1e-6), 1.0);
}`;

/** Draws the environment behind the scene (optionally blurred). */
const SKY_FRAG = `#version 300 es
precision highp float;
in vec2 vNdc;
out vec4 outColor;
uniform mat4 uInvViewProj;
uniform sampler2D uEnvBase;
uniform float uEnvIntensity;
uniform float uLod;
${COMMON}
void main() {
  vec4 a = uInvViewProj * vec4(vNdc, -1.0, 1.0);
  vec4 b = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 d = normalize(b.xyz / b.w - a.xyz / a.w);
  outColor = vec4(finish(textureLod(uEnvBase, envUv(d), uLod).rgb * uEnvIntensity), 1.0);
}`;

/** Equirectangular sizes of the prefiltered maps. */
const ENV_BASE = [1024, 512] as const;
const ENV_SPEC = [256, 128] as const;
const ENV_SPEC_LEVELS = 6;
const ENV_DIFF = [64, 32] as const;
const MAX_DIR_SHADOWS = 4;
const MAX_POINT_SHADOWS = 4;

/** Source of an environment map (the built-ins need none). */
export type EnvSource = { kind: 'image'; image: TexSource } | { kind: 'hdr'; image: HDRImage };

interface EnvMaps {
  base: WebGLTexture;
  spec: WebGLTexture;
  diff: WebGLTexture;
  baseLevels: number;
  lastUsed: number;
}

/** Cube face view bases for point light shadows: +X, −X, +Y, −Y, +Z, −Z. */
const FACES: { fwd: Vec3; up: Vec3 }[] = [
  { fwd: [1, 0, 0], up: [0, 1, 0] },
  { fwd: [-1, 0, 0], up: [0, 1, 0] },
  { fwd: [0, 1, 0], up: [0, 0, -1] },
  { fwd: [0, -1, 0], up: [0, 0, 1] },
  { fwd: [0, 0, 1], up: [0, 1, 0] },
  { fwd: [0, 0, -1], up: [0, 1, 0] },
];

type Program = { p: WebGLProgram; u: Map<string, WebGLUniformLocation | null> };

interface GpuMesh {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  count: number;
  hasColors: boolean;
  bounds: { min: Vec3; max: Vec3 };
  lastUsed: number;
  /** Deforming geometry (skinning, morphs): positions and normals are re-uploaded when it changes. */
  version?: string;
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
  private prog: Program;
  private depthProg: Program;
  private envProg: Program;
  private skyProg: Program;
  private meshes = new Map<string, GpuMesh>();
  private staticTex = new WeakMap<object, WebGLTexture>();
  private dynTex = new Map<string, WebGLTexture>();
  private msaa?: { fbo: WebGLFramebuffer; color: WebGLRenderbuffer; depth: WebGLRenderbuffer; w: number; h: number; samples: number };
  private plain?: { fbo: WebGLFramebuffer; color: WebGLRenderbuffer; depth: WebGLRenderbuffer; w: number; h: number };
  private shadowFbo: WebGLFramebuffer;
  private dirShadow?: { tex: WebGLTexture; size: number; layers: number };
  private pointShadow?: { tex: WebGLTexture; size: number; layers: number };
  private dummyShadow: WebGLTexture;
  private white: WebGLTexture;
  private black: WebGLTexture;
  private envs = new Map<string, EnvMaps>();
  private frame = 0;
  private aniso: number;
  private anisoExt: EXT_texture_filter_anisotropic | null;
  /** Float render targets (HDR environments); without them environments are clamped to 0..1. */
  readonly floatTargets: boolean;
  readonly maxSamples: number;

  constructor() {
    this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
    const gl = (this.canvas as OffscreenCanvas).getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: true, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available for 3D rendering');
    this.gl = gl;
    this.prog = this.program(VERT, FRAG);
    this.depthProg = this.program(DEPTH_VERT, DEPTH_FRAG);
    this.envProg = this.program(QUAD_VERT, ENV_FRAG);
    this.skyProg = this.program(QUAD_VERT, SKY_FRAG);
    this.maxSamples = gl.getParameter(gl.MAX_SAMPLES) as number;
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
    this.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
    this.aniso = this.anisoExt ? Math.min(8, gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) : 0;
    const pixel = (rgba: number[]) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
      return t;
    };
    this.white = pixel([255, 255, 255, 255]);
    this.black = pixel([0, 0, 0, 255]);
    this.shadowFbo = gl.createFramebuffer()!;
    this.dummyShadow = this.depthArray(1, 1);
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

  private loc(pr: Program, name: string) {
    if (!pr.u.has(name)) pr.u.set(name, this.gl.getUniformLocation(pr.p, name));
    return pr.u.get(name)!;
  }

  /** A depth texture array with hardware depth comparison (PCF lookups). */
  private depthArray(size: number, layers: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT24, size, size, layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    if (size === 1) {
      // Dummy: cleared to the far plane so lookups are fully lit.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
      for (let l = 0; l < layers; l++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, tex, 0, l);
        gl.clear(gl.DEPTH_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    return tex;
  }

  /** Shadow map arrays, reallocated when their size or layer count changes. */
  private shadowArray(which: 'dirShadow' | 'pointShadow', size: number, layers: number) {
    const cur = this[which];
    if (cur && cur.size === size && cur.layers >= layers) return cur;
    if (cur) this.gl.deleteTexture(cur.tex);
    const next = { tex: this.depthArray(size, layers), size, layers };
    this[which] = next;
    return next;
  }

  /** GPU buffers for a geometry, cached by key (evicted when unused for a while). */
  private mesh(key: string, build: () => Geometry, version?: string): GpuMesh {
    const gl = this.gl;
    let m = this.meshes.get(key);
    if (m) {
      m.lastUsed = this.frame;
      if (m.version !== version) {
        const g = build();
        gl.bindBuffer(gl.ARRAY_BUFFER, m.buffers[0]!);
        gl.bufferData(gl.ARRAY_BUFFER, g.positions, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, m.buffers[1]!);
        gl.bufferData(gl.ARRAY_BUFFER, g.normals, gl.DYNAMIC_DRAW);
        m.bounds = geometryBounds(g);
        m.version = version;
      }
      return m;
    }
    const g = build();
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
    m = { vao, buffers, count: g.indices.length, hasColors: !!g.colors, bounds: geometryBounds(g), lastUsed: this.frame, version };
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

  /** An equirectangular float (or 8-bit fallback) texture with `levels` mip levels. */
  private envTexture(w: number, h: number, levels: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    // A scratch unit, so the source bound to unit 5 stays bound while passes render into `t`.
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, levels, this.floatTargets ? gl.RGBA16F : gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Runs the environment shader into one mip level of `target`. */
  private envPass(target: WebGLTexture, level: number, w: number, h: number, set: (u: (n: string) => WebGLUniformLocation | null) => void) {
    const gl = this.gl;
    const P = this.envProg;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, null, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, level);
    gl.viewport(0, 0, w, h);
    gl.useProgram(P.p);
    const u = (n: string) => this.loc(P, n);
    gl.uniform1i(u('uSrc'), 5);
    set(u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
  }

  /**
   * Prefiltered maps for an environment (cached by key): the converted base map, GGX specular
   * levels for roughness 0…1 and diffuse irradiance.
   */
  private environment(key: string, source: EnvSource | null): EnvMaps | null {
    const cached = this.envs.get(key);
    if (cached) {
      cached.lastUsed = this.frame;
      return cached;
    }
    if (!source && !isBuiltinEnvironment(key)) return null;
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    const baseLevels = Math.floor(Math.log2(ENV_BASE[0])) + 1;
    const base = this.envTexture(ENV_BASE[0], ENV_BASE[1], baseLevels);
    gl.activeTexture(gl.TEXTURE5);
    let srcTex: WebGLTexture | null = null;
    if (source) {
      srcTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      let w: number;
      let mips = true;
      if (source.kind === 'hdr') {
        const { width, height, data } = source.image;
        w = width;
        const rgba = new Float32Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          rgba[i * 4] = data[i * 3]!;
          rgba[i * 4 + 1] = data[i * 3 + 1]!;
          rgba[i * 4 + 2] = data[i * 3 + 2]!;
          rgba[i * 4 + 3] = 1;
        }
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, rgba);
        // Half-float mipmaps need float render targets.
        mips = this.floatTargets;
      } else {
        w = source.image.width;
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source.image);
      }
      if (mips) gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const lod = mips ? Math.max(0, Math.log2(w / ENV_BASE[0])) : 0;
      this.envPass(base, 0, ENV_BASE[0], ENV_BASE[1], (u) => {
        gl.uniform1i(u('uMode'), 0);
        gl.uniform1f(u('uSrcSrgb'), source.kind === 'image' ? 1 : 0);
        gl.uniform1f(u('uSrcLod'), lod);
      });
    } else {
      this.envPass(base, 0, ENV_BASE[0], ENV_BASE[1], (u) => {
        gl.uniform1i(u('uMode'), 1);
        gl.uniform1i(u('uPreset'), key === 'studio' ? 0 : 1);
      });
    }
    // Everything below samples the base map (unit 5).
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, base);
    gl.generateMipmap(gl.TEXTURE_2D);
    if (srcTex) gl.deleteTexture(srcTex);
    const spec = this.envTexture(ENV_SPEC[0], ENV_SPEC[1], ENV_SPEC_LEVELS);
    for (let l = 0; l < ENV_SPEC_LEVELS; l++) {
      const roughness = l / (ENV_SPEC_LEVELS - 1);
      this.envPass(spec, l, ENV_SPEC[0] >> l, ENV_SPEC[1] >> l, (u) => {
        gl.uniform1i(u('uMode'), l === 0 ? 0 : 2);
        gl.uniform1f(u('uSrcSrgb'), 0);
        gl.uniform1f(u('uSrcLod'), Math.log2(ENV_BASE[0] / ENV_SPEC[0]));
        gl.uniform1f(u('uRoughness'), roughness);
        gl.uniform2f(u('uSrcSize'), ENV_BASE[0], ENV_BASE[1]);
      });
    }
    const diff = this.envTexture(ENV_DIFF[0], ENV_DIFF[1], 1);
    this.envPass(diff, 0, ENV_DIFF[0], ENV_DIFF[1], (u) => {
      gl.uniform1i(u('uMode'), 3);
      gl.uniform1f(u('uSrcSrgb'), 0);
      gl.uniform2f(u('uSrcSize'), ENV_BASE[0], ENV_BASE[1]);
    });
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.depthMask(true);
    // Keep a couple of environments (animated switches between two stay cheap).
    for (const [k, e] of this.envs) {
      if (this.envs.size < 2) break;
      if (this.frame - e.lastUsed > 0) {
        [e.base, e.spec, e.diff].forEach((t) => gl.deleteTexture(t));
        this.envs.delete(k);
      }
    }
    const maps = { base, spec, diff, baseLevels, lastUsed: this.frame };
    this.envs.set(key, maps);
    return maps;
  }

  /** Draws the meshes into the bound depth target (shadow passes). */
  private depthPass(viewProj: Mat4, meshes: { it: DrawItem; m: GpuMesh }[]) {
    const gl = this.gl;
    gl.uniformMatrix4fv(this.loc(this.depthProg, 'uViewProj'), false, viewProj);
    for (const { it, m } of meshes) {
      if (it.props.castShadow === false || it.props.unlit) continue;
      if (it.props.doubleSided || it.part?.doubleSided) gl.disable(gl.CULL_FACE);
      else gl.enable(gl.CULL_FACE);
      gl.uniformMatrix4fv(this.loc(this.depthProg, 'uModel'), false, it.matrix);
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
    }
  }

  /**
   * Renders a scene at `width × height` pixels. `textureOf` supplies the texture source of items
   * with maps (images, video frames, rendered 2D layers); `environmentOf` the decoded image of a
   * file environment.
   */
  render(
    scene: EvalScene,
    width: number,
    height: number,
    textureOf: (item: DrawItem) => { source: TexSource; dynamicKey?: string } | null,
    environmentOf: (src: string) => EnvSource | null = () => null,
  ): OffscreenCanvas | HTMLCanvasElement {
    const gl = this.gl;
    this.frame++;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const meshes = scene.items.map((it) => ({ it, m: this.mesh(it.geometry.key, it.geometry.build, it.geometry.version) }));
    const viewProj = mat4.multiply(scene.camera.proj(w / h), scene.camera.view);
    const env = scene.environment ? this.environment(scene.environment.src, isBuiltinEnvironment(scene.environment.src) ? null : environmentOf(scene.environment.src)) : null;

    // World-space corners of every mesh (shadow frusta).
    const pts: Vec3[] = [];
    for (const { it, m } of meshes) {
      const { min, max } = m.bounds;
      for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) pts.push(mat4.transformPoint(it.matrix, [x, y, z]));
    }

    const dirs = scene.lights.filter((l) => l.kind === 'directional').slice(0, 4);
    const points = scene.lights.filter((l) => l.kind === 'point').slice(0, 8);
    const dirShadowMats = new Float32Array(16 * 4);
    const dirInfo = new Float32Array(4 * 4).fill(-1);
    const pointInfo = new Float32Array(8 * 4).fill(-1);
    const faceRight: number[] = [];
    const faceUp: number[] = [];
    const faceViews = FACES.map((f) => mat4.lookAt([0, 0, 0], f.fwd, f.up));
    for (const v of faceViews) {
      faceRight.push(v[0]!, v[4]!, v[8]!);
      faceUp.push(v[1]!, v[5]!, v[9]!);
    }
    const shadowDirs = pts.length ? dirs.filter((l) => l.castShadow).slice(0, MAX_DIR_SHADOWS) : [];
    const shadowPoints = pts.length ? points.filter((l) => l.castShadow).slice(0, MAX_POINT_SHADOWS) : [];
    let dirSize = 1;
    let pointSize = 1;
    if (shadowDirs.length || shadowPoints.length) {
      gl.useProgram(this.depthProg.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
    }

    // ---- directional shadows: an orthographic light frustum fitted around the scene's bounding sphere
    if (shadowDirs.length) {
      const c = pts.reduce((a, p) => v3.add(a, p), [0, 0, 0] as Vec3).map((x) => x / pts.length) as Vec3;
      const r = Math.max(1e-3, ...pts.map((p) => v3.len(v3.sub(p, c))));
      const sm = this.shadowArray('dirShadow', Math.max(256, Math.min(4096, scene.shadowMapSize)), shadowDirs.length);
      dirSize = sm.size;
      gl.viewport(0, 0, sm.size, sm.size);
      shadowDirs.forEach((light, layer) => {
        const dir = v3.normalize(light.direction);
        const eye = v3.sub(c, v3.scale(dir, r * 2));
        const up: Vec3 = Math.abs(dir[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
        const lightVP = mat4.multiply(mat4.ortho(-r, r, -r, r, 0.01, r * 4), mat4.lookAt(eye, c, up));
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, sm.tex, 0, layer);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        this.depthPass(lightVP, meshes);
        const i = dirs.indexOf(light);
        dirShadowMats.set(lightVP, i * 16);
        // Normal offset of ~1.5 shadow texels, plus a small depth bias.
        dirInfo.set([layer, (3 * r) / sm.size, 0.0015, 0], i * 4);
      });
    }

    // ---- point light shadows: six 90° faces per light, layers of one depth array
    if (shadowPoints.length) {
      const sm = this.shadowArray('pointShadow', Math.max(64, Math.min(2048, scene.pointShadowMapSize)), shadowPoints.length * 6);
      pointSize = sm.size;
      gl.viewport(0, 0, sm.size, sm.size);
      shadowPoints.forEach((light, k) => {
        const far = light.range > 0 ? light.range : Math.max(1e-2, ...pts.map((p) => v3.len(v3.sub(p, light.position)))) * 1.01;
        const near = Math.min(0.05, far * 0.01);
        const proj = mat4.perspective(90, 1, near, far);
        FACES.forEach((f, fi) => {
          const view = mat4.lookAt(light.position, v3.add(light.position, f.fwd), f.up);
          gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, sm.tex, 0, k * 6 + fi);
          gl.clear(gl.DEPTH_BUFFER_BIT);
          // Skip meshes entirely behind the face.
          const facing = meshes.filter(({ it, m }) => {
            const { min, max } = m.bounds;
            const center = mat4.transformPoint(it.matrix, v3.scale(v3.add(min, max), 0.5));
            const radius = v3.len(v3.sub(mat4.transformPoint(it.matrix, max), mat4.transformPoint(it.matrix, min))) / 2;
            return v3.dot(v3.sub(center, light.position), f.fwd) > -radius;
          });
          this.depthPass(mat4.multiply(proj, view), facing);
        });
        pointInfo.set([k * 6, near, far, 3 / sm.size], points.indexOf(light) * 4);
      });
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
    const rot = ((scene.environment?.rotation ?? 0) * Math.PI) / 180;
    if (env && scene.environment?.background) {
      const S = this.skyProg;
      gl.useProgram(S.p);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.uniformMatrix4fv(this.loc(S, 'uInvViewProj'), false, mat4.invert(viewProj));
      gl.uniform1f(this.loc(S, 'uEnvIntensity'), scene.environment.intensity);
      gl.uniform1f(this.loc(S, 'uLod'), Math.max(0, Math.min(1, scene.environment.blur)) * (env.baseLevels - 3));
      gl.uniform1f(this.loc(S, 'uExposure'), scene.exposure);
      gl.uniform1i(this.loc(S, 'uToneMap'), scene.toneMapping === 'aces' ? 1 : 0);
      gl.uniform2f(this.loc(S, 'uEnvRot'), Math.cos(rot), Math.sin(rot));
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, env.base);
      gl.uniform1i(this.loc(S, 'uEnvBase'), 3);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.depthMask(true);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    const P = this.prog;
    gl.useProgram(P.p);
    const u = (n: string) => this.loc(P, n);
    gl.uniformMatrix4fv(u('uViewProj'), false, viewProj);
    gl.uniform3fv(u('uCamPos'), scene.camera.position);
    gl.uniform3fv(u('uAmbient'), scene.ambient);
    gl.uniform1i(u('uNumDir'), dirs.length);
    if (dirs.length) {
      gl.uniform3fv(u('uDirDir[0]'), dirs.flatMap((l) => v3.normalize(l.direction)));
      gl.uniform3fv(u('uDirColor[0]'), dirs.flatMap((l) => l.color));
    }
    gl.uniform1i(u('uNumPoint'), points.length);
    if (points.length) {
      gl.uniform3fv(u('uPointPos[0]'), points.flatMap((l) => l.position));
      gl.uniform3fv(u('uPointColor[0]'), points.flatMap((l) => l.color));
      gl.uniform1fv(u('uPointRange[0]'), points.map((l) => l.range));
    }
    gl.uniformMatrix4fv(u('uDirShadowMat[0]'), false, dirShadowMats);
    gl.uniform4fv(u('uDirShadowInfo[0]'), dirInfo);
    gl.uniform2f(u('uDirShadowTexel'), 1 / dirSize, 1 / dirSize);
    gl.uniform4fv(u('uPointShadowInfo[0]'), pointInfo);
    gl.uniform1f(u('uPointShadowTexel'), 1 / pointSize);
    gl.uniform3fv(u('uFaceRight[0]'), faceRight);
    gl.uniform3fv(u('uFaceUp[0]'), faceUp);
    gl.uniform3fv(u('uFogColor'), scene.fog?.color ?? [0, 0, 0]);
    gl.uniform2f(u('uFog'), scene.fog?.near ?? 0, scene.fog?.far ?? 0);
    gl.uniform1f(u('uExposure'), scene.exposure);
    gl.uniform1i(u('uToneMap'), scene.toneMapping === 'aces' ? 1 : 0);
    gl.uniform1f(u('uHasEnv'), env ? 1 : 0);
    gl.uniform1f(u('uEnvIntensity'), scene.environment?.intensity ?? 0);
    gl.uniform1f(u('uEnvLevels'), ENV_SPEC_LEVELS - 1);
    gl.uniform2f(u('uEnvRot'), Math.cos(rot), Math.sin(rot));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, shadowDirs.length ? this.dirShadow!.tex : this.dummyShadow);
    gl.uniform1i(u('uDirShadow'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, shadowPoints.length ? this.pointShadow!.tex : this.dummyShadow);
    gl.uniform1i(u('uPointShadow'), 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, env?.spec ?? this.black);
    gl.uniform1i(u('uEnvSpec'), 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, env?.diff ?? this.black);
    gl.uniform1i(u('uEnvDiff'), 4);
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
