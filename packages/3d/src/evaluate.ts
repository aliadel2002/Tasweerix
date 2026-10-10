import { parseColor, resolve, type FrameContext, type Paint, type SceneNode, type Vec3 } from '@tasweerix/core';
import type { Geometry } from './geometry';
import type { ModelMaterial } from './loaders';
import { mat4, v3, type Mat4 } from './math3d';
import { clipIndex, deformPart, isPosable, partMatrix, partWeights, poseModel } from './pose';
import { CAMERA_DEFAULTS, CameraNode, LightNode, MeshNode, Object3DNode, type Scene3DNode } from './nodes';

/** sRGB color string → linear RGBA. */
export function linearColor(c: string | null | undefined, fallback: [number, number, number, number] = [1, 1, 1, 1]): [number, number, number, number] {
  if (!c) return fallback;
  const p = parseColor(c) as number[];
  const lin = (x: number) => Math.pow(Math.max(0, x), 2.2);
  return [lin(p[0]!), lin(p[1]!), lin(p[2]!), p[3] ?? 1];
}

/** A drawable item of an evaluated scene. */
export interface DrawItem {
  node: MeshNode;
  /** Cache key and builder of the geometry; `version` changes when deforming geometry must be rebuilt. */
  geometry: { key: string; build(): Geometry; version?: string };
  matrix: Mat4;
  props: Record<string, any>;
  /** For model parts: the file's material (node props tint it). */
  part?: ModelMaterial;
  opacity: number;
  /** Node-local context of the mesh (for texture nodes). */
  local: FrameContext;
}

export interface EvalLight {
  kind: 'directional' | 'point' | 'ambient';
  color: [number, number, number];
  position: Vec3;
  /** Direction the light travels (directional). */
  direction: Vec3;
  range: number;
  castShadow: boolean;
}

export interface EvalCamera {
  view: Mat4;
  proj: (aspect: number) => Mat4;
  position: Vec3;
}

export interface EvalScene {
  items: DrawItem[];
  lights: EvalLight[];
  camera: EvalCamera;
  ambient: [number, number, number];
  background: Paint;
  fog: { color: [number, number, number]; near: number; far: number } | null;
  exposure: number;
  toneMapping: 'none' | 'aces';
  shadowMapSize: number;
  pointShadowMapSize: number;
  samples: number;
  /** Image-based lighting: a built-in ('studio', 'sky') or an image/.hdr path. */
  environment: { src: string; intensity: number; rotation: number; background: boolean; blur: number } | null;
}

const scaleVec = (s: Vec3 | number): Vec3 => (typeof s === 'number' ? [s, s, s] : s);
const partKeys = new WeakMap<object, string>();
let partId = 0;

/** Resolves a scene at its node-local frame: active objects, world matrices, camera and lights. */
export function evaluateScene(scene: Scene3DNode, local: FrameContext): EvalScene {
  const sp = scene.evaluate(local) as Record<string, any>;
  const items: DrawItem[] = [];
  const lights: EvalLight[] = [];
  let camera: { node: CameraNode; props: Record<string, any>; world: Mat4 } | undefined;
  const walk = (parent: SceneNode, ctx: FrameContext, world: Mat4, opacity: number) => {
    for (const child of parent.children) {
      if (!(child instanceof Object3DNode)) continue;
      if (!child.activeAt(ctx.time)) continue;
      const l = child.localCtx(ctx);
      const p = child.evaluate(l) as Record<string, any>;
      if (p.visible === false) continue;
      const m = mat4.multiply(world, mat4.compose(p.position as Vec3, p.rotation as Vec3, scaleVec(p.scale)));
      const op = opacity * (p.opacity ?? 1);
      if (child instanceof MeshNode) {
        if (child.model) {
          const model = child.model;
          const posed = isPosable(model);
          const clip = posed ? clipIndex(model, p.animation) : -1;
          const t = clip >= 0 ? clipTime(model.animations![clip]!.duration, p, l) : 0;
          const pose = posed ? poseModel(model, clip, t) : null;
          const morphs = p.morphs ? Object.fromEntries(Object.entries(p.morphs as Record<string, unknown>).map(([k, v]) => [k, resolve(v as number, l)])) : null;
          for (const part of model.parts) {
            let key = partKeys.get(part.geometry);
            if (!key) partKeys.set(part.geometry, (key = `part:${++partId}`));
            let geometry: DrawItem['geometry'] = { key, build: () => part.geometry };
            if (pose && (part.skin !== undefined || part.morph)) {
              const weights = part.morph ? partWeights(part, pose, morphs) : null;
              // Rebuilt only when the pose changes (clip time or weights).
              geometry = { key, build: () => deformPart(model, part, pose, weights), version: `${clip}:${t.toFixed(6)}:${weights?.join(',') ?? ''}` };
            }
            items.push({ node: child, geometry, matrix: mat4.multiply(m, pose ? partMatrix(part, pose) : part.matrix), props: p, part: part.material, opacity: op, local: l });
          }
        } else {
          const g = child.geometryOf(p, l);
          if (g) items.push({ node: child, geometry: g, matrix: m, props: p, opacity: op, local: l });
        }
      } else if (child instanceof LightNode) {
        const c = linearColor(p.color);
        const pos = mat4.transformPoint(world, p.position as Vec3);
        const target = mat4.transformPoint(world, p.target as Vec3);
        lights.push({ kind: p.kind, color: [c[0] * p.intensity, c[1] * p.intensity, c[2] * p.intensity], position: pos, direction: v3.normalize(v3.sub(target, pos)), range: p.range, castShadow: !!p.castShadow });
      } else if (child instanceof CameraNode) camera = { node: child, props: p, world };
      // Children of any 3D object follow its transform (groups, meshes with attached parts …).
      walk(child, child.childCtx(l), m, op);
    }
  };
  walk(scene, scene.childCtx(local), mat4.identity(), 1);
  const cam = cameraOf(camera?.props ?? CAMERA_DEFAULTS, camera?.world ?? mat4.identity());
  const environment = typeof sp.environment === 'string' && sp.environment ? { src: sp.environment as string, intensity: sp.environmentIntensity ?? 1, rotation: sp.environmentRotation ?? 0, background: !!sp.environmentBackground, blur: sp.environmentBlur ?? 0 } : null;
  const amb = linearColor(sp.ambient);
  // An environment replaces the scene's flat ambient (ambient light nodes still add).
  const ai = environment ? 0 : (sp.ambientIntensity ?? 0.35);
  const ambient: [number, number, number] = [amb[0] * ai, amb[1] * ai, amb[2] * ai];
  for (const l of lights) if (l.kind === 'ambient') for (let i = 0; i < 3; i++) ambient[i] += l.color[i]!;
  const directOrPoint = lights.filter((l) => l.kind !== 'ambient');
  // A default key light when the scene defines none.
  if (!lights.length) directOrPoint.push({ kind: 'directional', color: [1, 1, 1], position: [3, 5, 4], direction: v3.normalize([-3, -5, -4]), range: 0, castShadow: false });
  const fog = sp.fog ? { color: linearColor(sp.fog.color).slice(0, 3) as [number, number, number], near: sp.fog.near, far: sp.fog.far } : null;
  return { items, lights: directOrPoint, camera: cam, ambient, background: sp.background ?? null, fog, exposure: sp.exposure ?? 1, toneMapping: sp.toneMapping ?? 'none', shadowMapSize: sp.shadowMapSize ?? 2048, pointShadowMapSize: sp.pointShadowMapSize ?? 1024, samples: sp.samples ?? 4, environment };
}

/** Clip time in seconds: `animationTime` if set, else the node's local time × speed + offset, looped or held. */
function clipTime(duration: number, p: Record<string, any>, l: FrameContext): number {
  const t = typeof p.animationTime === 'number' ? p.animationTime : l.time * (p.animationSpeed ?? 1) + (p.animationOffset ?? 0);
  if (duration <= 0) return 0;
  if (p.loop === false) return Math.max(0, Math.min(duration, t));
  return ((t % duration) + duration) % duration;
}

function cameraOf(p: Record<string, any>, world: Mat4): EvalCamera {
  const pos = mat4.transformPoint(world, p.position as Vec3);
  let view: Mat4;
  if (p.target) {
    const target = mat4.transformPoint(world, p.target as Vec3);
    const up = mat4.transformDir(world, p.up as Vec3);
    view = mat4.lookAt(pos, target, up);
  } else {
    // No target: the camera's own rotation (looking down −Z).
    view = mat4.invert(mat4.multiply(world, mat4.compose(p.position as Vec3, p.rotation as Vec3, [1, 1, 1])));
  }
  if (p.roll) view = mat4.multiply(mat4.compose([0, 0, 0], [0, 0, -p.roll], [1, 1, 1]), view);
  const ortho = p.orthographic as number | null;
  return {
    view,
    position: pos,
    proj: (aspect) => (ortho ? mat4.ortho((-ortho * aspect) / 2, (ortho * aspect) / 2, -ortho / 2, ortho / 2, p.near, p.far) : mat4.perspective(p.fov, aspect, p.near, p.far)),
  };
}
