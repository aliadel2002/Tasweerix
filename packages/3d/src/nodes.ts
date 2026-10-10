import { SceneNode, type Animatable, type Driver, type Env, type FrameContext, type NodeOptions, type Paint, type TimeInput, type Vec2, type Vec3 } from '@tasweerix/core';
import { boxGeometry, cylinderGeometry, extrudeGeometry, planeGeometry, sphereGeometry, torusGeometry, type Geometry } from './geometry';
import { loadModel, type Model } from './loaders';
import { loadTextFont, text3dGeometry, type Text3DProps } from './text3d';

type A<T> = { [K in keyof T]?: Animatable<T[K]> };

/** Timing options shared by every 3D object (no 2D transform options). */
export interface Options3D {
  name?: string;
  start?: TimeInput;
  duration?: TimeInput;
  end?: TimeInput;
}

export interface Transform3D {
  /** World units, y up. */
  position: Vec3;
  /** Euler angles in degrees (applied X, then Y, then Z, as in three.js). */
  rotation: Vec3;
  scale: Vec3 | number;
  visible: boolean;
  opacity: number;
}

export interface MaterialProps {
  /** Base color (CSS color). */
  color: string;
  /** Image used as base color texture (multiplied with `color`). For video or 2D layers, pass a node. */
  map: string | null;
  /** Texture size in pixels for node maps (default: the composition size). */
  mapSize: Vec2 | null;
  metalness: number;
  roughness: number;
  emissive: string;
  emissiveIntensity: number;
  /** Ignores lights (keeps texture colors exact, e.g. for 2D layers in 3D space). */
  unlit: boolean;
  doubleSided: boolean;
  /** Blended after opaque objects (set automatically when opacity < 1). */
  transparent: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
}

const TRANSFORM_DEFAULTS: Transform3D = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1, visible: true, opacity: 1 };
export const MATERIAL_DEFAULTS: MaterialProps = {
  color: '#ffffff',
  map: null,
  mapSize: null,
  metalness: 0,
  roughness: 0.5,
  emissive: '#000000',
  emissiveIntensity: 1,
  unlit: false,
  doubleSided: false,
  transparent: false,
  castShadow: true,
  receiveShadow: true,
};

function split<P>(o: (A<P> & Options3D) | undefined): [Record<string, unknown>, NodeOptions] {
  const { name, start, duration, end, ...rest } = (o ?? {}) as A<P> & Options3D;
  return [rest as Record<string, unknown>, { name, start, duration, end }];
}

/** Base class of every node inside a `scene3d()`. */
export class Object3DNode extends SceneNode<any> {
  constructor(kind: string, props: Record<string, unknown>, opts: NodeOptions) {
    super(kind, props as never, opts);
    this.meta.is3d = true;
  }
  override defaults(): Record<string, unknown> {
    return { ...TRANSFORM_DEFAULTS };
  }
}

/** How a mesh gets its geometry: a cache key plus a builder. */
export interface GeometrySource {
  key: string;
  build(): Geometry;
}

/** A mesh: primitive, extrusion, text, loaded model or custom geometry, with a material. */
export class MeshNode extends Object3DNode {
  /** Builds geometry from evaluated props (null for models). */
  geometryOf: (props: Record<string, any>, frame: FrameContext) => GeometrySource | null;
  /** 2D node rendered as the texture each frame (video, comp, group, text …). */
  mapNode?: SceneNode;
  model?: Model;
  modelSrc?: string;
  constructor(kind: string, geometryOf: MeshNode['geometryOf'], props: Record<string, unknown>, opts: NodeOptions) {
    const { map, ...rest } = props;
    super(kind, rest, opts);
    this.geometryOf = geometryOf;
    if (map instanceof SceneNode) this.setMap(map);
    else if (map !== undefined) this.props.map = map;
  }
  override defaults(): Record<string, unknown> {
    return { ...TRANSFORM_DEFAULTS, ...MATERIAL_DEFAULTS };
  }
  /** Uses a 2D node (video, nested composition, group …) as this mesh's texture. */
  setMap(node: SceneNode): this {
    if (this.mapNode) this.remove(this.mapNode);
    node.meta.role = 'texture';
    this.add(node);
    this.mapNode = node;
    return this;
  }
  override async prepare(env: Env): Promise<void> {
    if (this.kind === 'text3d' && typeof this.props.font === 'string') await loadTextFont(this.props.font, env);
    if (this.modelSrc && !this.model) {
      if (!env.loadBinary) throw new Error('model(): this environment cannot load files');
      this.model = await loadModel(this.modelSrc, (p) => env.loadBinary!(p));
      if (this.model.warnings.length) this.meta.warnings = this.model.warnings;
    }
    await super.prepare(env);
  }
}

export interface LightProps {
  kind: 'directional' | 'point' | 'ambient';
  color: string;
  intensity: number;
  /** Directional lights shine from `position` toward `target`. */
  target: Vec3;
  /** Point light reach (0 = unlimited, physical falloff). */
  range: number;
  castShadow: boolean;
}

export class LightNode extends Object3DNode {
  override defaults(): Record<string, unknown> {
    return { ...TRANSFORM_DEFAULTS, kind: 'directional', color: '#ffffff', intensity: 1, target: [0, 0, 0], range: 0, castShadow: false, position: [3, 5, 4] };
  }
}

export interface CameraProps {
  /** Point the camera looks at (null: use `rotation` instead). */
  target: Vec3 | null;
  /** Vertical field of view in degrees. */
  fov: number;
  near: number;
  far: number;
  up: Vec3;
  /** Degrees around the viewing direction. */
  roll: number;
  /** Orthographic view height in world units (null = perspective). */
  orthographic: number | null;
}

export const CAMERA_DEFAULTS = { ...TRANSFORM_DEFAULTS, position: [0, 1.5, 6] as Vec3, target: [0, 0, 0] as Vec3 | null, fov: 45, near: 0.1, far: 1000, up: [0, 1, 0] as Vec3, roll: 0, orthographic: null as number | null };

export class CameraNode extends Object3DNode {
  override defaults(): Record<string, unknown> {
    return { ...CAMERA_DEFAULTS };
  }
}

export class Group3DNode extends Object3DNode {}

export interface Scene3DProps {
  /** Viewport size in composition pixels (default: the composition size). */
  size: Vec2 | null;
  /** Background color (null = transparent, so 2D layers below show through). */
  background: Paint;
  /** Ambient light color and intensity. */
  ambient: string;
  ambientIntensity: number;
  /** Linear fog: color and [near, far] distances from the camera (null = off). */
  fog: { color: string; near: number; far: number } | null;
  exposure: number;
  /** 'aces' filmic tone mapping or 'none'. */
  toneMapping: 'none' | 'aces';
  /** Shadow map resolution. */
  shadowMapSize: number;
  /** Multisampling (1 disables). */
  samples: number;
}

/** A 3D viewport: renders its 3D children with a camera into a 2D layer of the composition. */
export class Scene3DNode extends SceneNode<Scene3DProps> {
  override defaults() {
    return { size: null, background: null, ambient: '#ffffff', ambientIntensity: 0.35, fog: null, exposure: 1, toneMapping: 'none' as const, shadowMapSize: 2048, samples: 4 };
  }
}

// ------------------------------------------------------------------ factories

type Kids3D = (Object3DNode | (A<Scene3DProps & { position: Vec2; scale: number; opacity: number; rotation: number }> & Options3D & { at?: Animatable<Vec2> }))[];

/**
 * A 3D scene as a layer of the composition:
 *   c.add(scene3d(camera3d({ position: [0, 2, 6] }), light.directional(), box({ rotation: keys(...) })))
 * The last active camera child is used (cut between cameras by timing them). Without lights a
 * default key light and ambient are used.
 */
export function scene3d(...items: Kids3D): Scene3DNode {
  const nodes = items.filter((c): c is Object3DNode => c instanceof SceneNode);
  const o = (items.find((c) => !(c instanceof SceneNode)) ?? {}) as Record<string, unknown>;
  const { name, start, duration, end, at, ...props } = o;
  const s = new Scene3DNode('scene3d', props as never, { name: name as string, start: start as TimeInput, duration: duration as TimeInput, end: end as TimeInput, at: at as Animatable<Vec2> });
  if (nodes.length) s.add(...nodes);
  return s;
}

export function group3d(...items: (Object3DNode | (A<Transform3D> & Options3D))[]): Group3DNode {
  const nodes = items.filter((c): c is Object3DNode => c instanceof SceneNode);
  const [p, o] = split(items.find((c) => !(c instanceof SceneNode)) as A<Transform3D> & Options3D);
  const g = new Group3DNode('group3d', p, o);
  if (nodes.length) g.add(...nodes);
  return g;
}

export type MeshOptions<P = {}> = A<Transform3D & Omit<MaterialProps, 'map'> & P> & { map?: string | SceneNode | null } & Options3D;

const k = (kind: string, p: Record<string, unknown>) => `${kind}:${JSON.stringify(p)}`;

export function meshNode(kind: string, geometryOf: MeshNode['geometryOf'], o?: MeshOptions<any>): MeshNode {
  const [p, opts] = split(o);
  return new MeshNode(kind, geometryOf, p, opts);
}

export function box(o?: MeshOptions<{ size: Vec3 }>): MeshNode {
  const n = meshNode('box', (p) => ({ key: k('box', { s: p.size }), build: () => boxGeometry(...(p.size as Vec3)) }), o);
  n.props.size ??= [1, 1, 1];
  return n;
}
export function sphere(o?: MeshOptions<{ radius: number; segments: number }>): MeshNode {
  const n = meshNode('sphere', (p) => ({ key: k('sphere', { r: p.radius, s: p.segments }), build: () => sphereGeometry(p.radius, p.segments, Math.max(3, Math.round(p.segments / 2))) }), o);
  n.props.radius ??= 0.5;
  n.props.segments ??= 48;
  return n;
}
export function plane(o?: MeshOptions<{ size: Vec2 }>): MeshNode {
  const n = meshNode('plane', (p) => ({ key: k('plane', { s: p.size }), build: () => planeGeometry((p.size as Vec2)[0], (p.size as Vec2)[1]) }), o);
  n.props.size ??= [1, 1];
  return n;
}
export function cylinder(o?: MeshOptions<{ radius: number; radiusTop: number | null; height: number; segments: number }>): MeshNode {
  const n = meshNode('cylinder', (p) => ({ key: k('cyl', { r: p.radius, t: p.radiusTop, h: p.height, s: p.segments }), build: () => cylinderGeometry(p.radiusTop ?? p.radius, p.radius, p.height, p.segments) }), o);
  n.props.radius ??= 0.5;
  n.props.radiusTop ??= null;
  n.props.height ??= 1;
  n.props.segments ??= 48;
  return n;
}
export function cone(o?: MeshOptions<{ radius: number; height: number; segments: number }>): MeshNode {
  const n = meshNode('cone', (p) => ({ key: k('cone', { r: p.radius, h: p.height, s: p.segments }), build: () => cylinderGeometry(0, p.radius, p.height, p.segments) }), o);
  n.props.radius ??= 0.5;
  n.props.height ??= 1;
  n.props.segments ??= 48;
  return n;
}
export function torus(o?: MeshOptions<{ radius: number; tube: number }>): MeshNode {
  const n = meshNode('torus', (p) => ({ key: k('torus', { r: p.radius, t: p.tube }), build: () => torusGeometry(p.radius, p.tube) }), o);
  n.props.radius ??= 0.5;
  n.props.tube ??= 0.18;
  return n;
}

/** Extruded SVG path (y-down path units, scaled by `scale` world units per path unit). */
export function extrude(d: Animatable<string>, o?: MeshOptions<{ depth: number; scale: number; smoothAngle: number }>): MeshNode {
  const n = meshNode('extrude', (p) => ({ key: k('extrude', { d: p.d, z: p.depth, s: p.scale, a: p.smoothAngle }), build: () => extrudeGeometry(p.d, { depth: p.depth, scale: p.scale, smoothAngle: p.smoothAngle }) }), o);
  n.props.d = d;
  n.props.depth ??= 0.2;
  n.props.scale ??= 0.01;
  n.props.smoothAngle ??= 35;
  return n;
}

/** A mesh from your own geometry data. */
export function mesh(geometry: Geometry, o?: MeshOptions): MeshNode {
  const id = `custom:${Math.random().toString(36).slice(2)}`;
  return meshNode('mesh', () => ({ key: id, build: () => geometry }), o);
}

/** A glTF (.glb/.gltf) or OBJ model. Node material props tint and override the file's materials. */
export function model(src: string, o?: MeshOptions): MeshNode {
  const n = meshNode('model', () => null, o);
  n.modelSrc = src;
  // Model files carry their own colors: white tint by default.
  return n;
}

/**
 * A 2D node (video, image, comp, text, group …) on a plane in 3D space: an After Effects-style 3D
 * layer. `size` is in world units (default: 2 units tall with the texture's aspect).
 */
export function layer3d(content: SceneNode, o?: MeshOptions<{ size: Vec2 | null }>): MeshNode {
  const n = meshNode('layer3d', (p, frame) => {
    const ts = (p.mapSize as Vec2 | null) ?? [frame.width, frame.height];
    const size = (p.size as Vec2 | null) ?? [2 * (ts[0] / ts[1]), 2];
    return { key: k('plane', { s: size }), build: () => planeGeometry(size[0], size[1]) };
  }, { unlit: true, doubleSided: true, transparent: true, castShadow: false, ...(o ?? {}) });
  n.props.size ??= null;
  n.setMap(content);
  return n;
}

/** Extruded text from a font file (HarfBuzz shaping and bidi, as for 2D text). */
export function text3d(text: Animatable<string>, o: MeshOptions<Omit<Text3DProps, 'text'>> & { font: string }): MeshNode {
  const n = meshNode('text3d', (p) => ({ key: k('text3d', { t: p.text, f: p.font, s: p.size, d: p.depth, a: p.align, l: p.letterSpacing, h: p.lineHeight, r: p.direction }), build: () => text3dGeometry(p as unknown as Text3DProps) }), o);
  n.props.text = text;
  n.props.size ??= 1;
  n.props.depth ??= 0.25;
  n.props.align ??= 'center';
  n.props.letterSpacing ??= 0;
  n.props.lineHeight ??= 1.2;
  n.props.direction ??= 'auto';
  n.meta.fontFile = o.font;
  return n;
}

export function camera3d(o?: A<Transform3D & CameraProps> & Options3D): CameraNode {
  const [p, opts] = split(o);
  return new CameraNode('camera3d', p, opts);
}

export const light = {
  /** Sun-like light from `position` toward `target`; `castShadow` enables a shadow map. */
  directional(o?: A<Transform3D & Omit<LightProps, 'kind'>> & Options3D): LightNode {
    const [p, opts] = split(o);
    return new LightNode('light3d', { ...p, kind: 'directional' }, opts);
  },
  /** Light radiating from a point with distance falloff. */
  point(o?: A<Transform3D & Omit<LightProps, 'kind'>> & Options3D): LightNode {
    const [p, opts] = split(o);
    return new LightNode('light3d', { position: [0, 2, 2], ...p, kind: 'point' }, opts);
  },
  /** Adds uniform light (on top of the scene's `ambient`). */
  ambient(o?: A<Pick<LightProps, 'color' | 'intensity'>> & Options3D): LightNode {
    const [p, opts] = split(o);
    return new LightNode('light3d', { ...p, kind: 'ambient' }, opts);
  },
};

/**
 * Circular camera (or object) path around a target: a position driver.
 *   camera3d({ position: orbit({ radius: 6, height: 2, speed: 30 }) })
 */
export function orbit(o: { radius?: number; height?: number; speed?: number; startAngle?: number; center?: Vec3 } = {}): Driver<Vec3> {
  const r = o.radius ?? 6;
  const c = o.center ?? [0, 0, 0];
  return (ctx: FrameContext) => {
    const a = (((o.startAngle ?? 0) + (o.speed ?? 30) * ctx.time) * Math.PI) / 180;
    return [c[0] + r * Math.sin(a), c[1] + (o.height ?? 1.5), c[2] + r * Math.cos(a)];
  };
}

export type { Text3DProps };
