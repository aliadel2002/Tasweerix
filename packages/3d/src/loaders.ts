import { computeNormals, type Geometry } from './geometry';
import { mat4, type Mat4, type Vec3 } from './math3d';

/** Material values a model file can carry (all optional; node props fill the rest). */
export interface ModelMaterial {
  color?: [number, number, number, number];
  metalness?: number;
  roughness?: number;
  emissive?: [number, number, number];
  doubleSided?: boolean;
  /** Decoded base color texture (browser only). */
  texture?: CanvasImageSource & { width: number; height: number };
  transparent?: boolean;
}

export interface ModelPart {
  geometry: Geometry;
  material: ModelMaterial;
  /** Transform of the part inside the model (rest pose). */
  matrix: Mat4;
  name?: string;
  /** Index of the node holding the part (models with a node hierarchy). */
  node?: number;
  /** Skeleton: index into `Model.skins`, with 4 joint indices and weights per vertex. */
  skin?: number;
  /** Joint influences per vertex in `joints`/`weights` (4 or 8). */
  influences?: number;
  joints?: Uint32Array;
  weights?: Float32Array;
  /** Morph targets: position (and normal) deltas, default weights and target names. */
  morph?: MorphTargets;
}

export interface MorphTargets {
  positions: Float32Array[];
  normals: (Float32Array | undefined)[];
  weights: number[];
  names: string[];
}

/** A node of a model's hierarchy (rest pose as translation, rotation quaternion and scale). */
export interface ModelNodeData {
  name?: string;
  translation: Vec3;
  rotation: Quat;
  scale: Vec3;
  /** Fixed local matrix (nodes given as a matrix, which glTF forbids animating). */
  matrix?: Mat4;
  children: number[];
  /** Default morph weights of the node's mesh. */
  weights?: number[];
}

export interface ModelSkin {
  joints: number[];
  inverseBind: Mat4[];
}

export interface AnimationChannel {
  node: number;
  path: 'translation' | 'rotation' | 'scale' | 'weights';
  interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
  times: Float32Array;
  values: Float32Array;
}

export interface ModelAnimation {
  name: string;
  /** Seconds. */
  duration: number;
  channels: AnimationChannel[];
}

export type Quat = [number, number, number, number];

export interface Model {
  parts: ModelPart[];
  /** Notes about skipped features (non-triangle primitives, undecodable textures …). */
  warnings: string[];
  /** Node hierarchy, skeletons and animation clips (glTF). */
  nodes?: ModelNodeData[];
  roots?: number[];
  skins?: ModelSkin[];
  animations?: ModelAnimation[];
}

type Loader = (src: string, load: (path: string) => Promise<ArrayBuffer>) => Promise<Model>;
const loaders = new Map<string, Loader>();

/** Registers a model loader for a file extension (lowercase, without the dot). */
export function registerModelLoader(ext: string, loader: Loader): void {
  loaders.set(ext.toLowerCase(), loader);
}

export async function loadModel(src: string, load: (path: string) => Promise<ArrayBuffer>): Promise<Model> {
  const ext = (/\.([a-z0-9]+)(\?.*)?$/i.exec(src)?.[1] ?? '').toLowerCase();
  const l = loaders.get(ext);
  if (!l) throw new Error(`No 3D model loader for .${ext} (known: ${[...loaders.keys()].join(', ')})`);
  return l(src, load);
}

const dirOf = (p: string) => p.replace(/[^/\\]*$/, '');

// ------------------------------------------------------------------ OBJ

/** Wavefront OBJ (+ MTL diffuse colors): polygons are fan-triangulated; missing normals are computed. */
export async function parseOBJ(text: string, mtl?: string): Promise<Model> {
  const v: number[][] = [];
  const vt: number[][] = [];
  const vn: number[][] = [];
  const mats = new Map<string, ModelMaterial>();
  if (mtl) {
    let cur: ModelMaterial | undefined;
    for (const raw of mtl.split(/\r?\n/)) {
      const [k, ...a] = raw.trim().split(/\s+/);
      if (k === 'newmtl') mats.set(a.join(' '), (cur = { color: [0.8, 0.8, 0.8, 1], roughness: 0.6, metalness: 0 }));
      else if (cur && k === 'Kd') cur.color = [Number(a[0]), Number(a[1]), Number(a[2]), cur.color?.[3] ?? 1];
      else if (cur && (k === 'd' || k === 'Tr')) {
        const d = k === 'd' ? Number(a[0]) : 1 - Number(a[0]);
        cur.color = [...(cur.color ?? [0.8, 0.8, 0.8, 1]).slice(0, 3), d] as [number, number, number, number];
        cur.transparent = d < 1;
      } else if (cur && k === 'Ke') cur.emissive = [Number(a[0]), Number(a[1]), Number(a[2])];
      else if (cur && k === 'Ns') cur.roughness = Math.max(0.05, Math.min(1, Math.sqrt(2 / (Number(a[0]) + 2))));
    }
  }
  const groups = new Map<string, { p: number[]; n: number[]; uv: number[]; hasN: boolean }>();
  let mat = '';
  const group = () => {
    let g = groups.get(mat);
    if (!g) groups.set(mat, (g = { p: [], n: [], uv: [], hasN: true }));
    return g;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const [k, ...a] = line.split(/\s+/);
    if (k === 'v') v.push(a.map(Number));
    else if (k === 'vt') vt.push(a.map(Number));
    else if (k === 'vn') vn.push(a.map(Number));
    else if (k === 'usemtl') mat = a.join(' ');
    else if (k === 'f') {
      const g = group();
      const idx = (s: string, arr: number[][]) => {
        const n = Number(s);
        return n < 0 ? arr.length + n : n - 1;
      };
      const corners = a.map((c) => {
        const [pi, ti, ni] = c.split('/');
        return { p: v[idx(pi!, v)]!, t: ti ? vt[idx(ti, vt)] : undefined, n: ni ? vn[idx(ni, vn)] : undefined };
      });
      for (let i = 1; i < corners.length - 1; i++) {
        for (const c of [corners[0]!, corners[i]!, corners[i + 1]!]) {
          g.p.push(c.p[0]!, c.p[1]!, c.p[2]!);
          g.uv.push(c.t?.[0] ?? 0, 1 - (c.t?.[1] ?? 0));
          if (c.n) g.n.push(c.n[0]!, c.n[1]!, c.n[2]!);
          else g.hasN = false;
        }
      }
    }
  }
  const parts: ModelPart[] = [];
  for (const [name, g] of groups) {
    const indices = new Uint32Array(g.p.length / 3).map((_, i) => i);
    const positions = new Float32Array(g.p);
    const geometry: Geometry = { positions, normals: g.hasN && g.n.length === g.p.length ? new Float32Array(g.n) : computeNormals({ positions, indices }), uvs: new Float32Array(g.uv), indices };
    parts.push({ geometry, material: mats.get(name) ?? {}, matrix: mat4.identity(), name: name || undefined });
  }
  return { parts, warnings: [] };
}

registerModelLoader('obj', async (src, load) => {
  const text = new TextDecoder().decode(await load(src));
  const lib = /^mtllib\s+(.+)$/m.exec(text)?.[1]?.trim();
  let mtl: string | undefined;
  if (lib) mtl = await load(dirOf(src) + lib).then((b) => new TextDecoder().decode(b)).catch(() => undefined);
  return parseOBJ(text, mtl);
});

// ------------------------------------------------------------------ glTF 2.0

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

async function decodeImage(bytes: Uint8Array, mime: string): Promise<(CanvasImageSource & { width: number; height: number }) | undefined> {
  if (typeof createImageBitmap === 'undefined') return undefined;
  return createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
}

/**
 * glTF 2.0 (.gltf with embedded or external buffers, and binary .glb): mesh primitives (triangles),
 * the node hierarchy, PBR metallic-roughness factors, base color textures and emissive color,
 * skins (up to 8 influences per vertex), morph targets (sparse or dense) and animation clips.
 */
export async function parseGLTF(json: any, bin: Uint8Array | undefined, load: (uri: string) => Promise<ArrayBuffer>): Promise<Model> {
  const warnings = new Set<string>();
  const buffers: Uint8Array[] = await Promise.all(
    (json.buffers ?? []).map(async (b: any, i: number) => {
      if (b.uri === undefined) return bin ?? new Uint8Array(0);
      if (b.uri.startsWith('data:')) {
        const b64 = b.uri.slice(b.uri.indexOf(',') + 1);
        return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      }
      void i;
      return new Uint8Array(await load(decodeURIComponent(b.uri)));
    }),
  );
  const view = (i: number) => {
    const bv = json.bufferViews[i];
    const buf = buffers[bv.buffer]!;
    return { bytes: buf.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength), stride: bv.byteStride as number | undefined };
  };
  const read = (out: Float32Array | Uint32Array, bufferView: number, byteOffset: number, componentType: number, normalized: boolean, n: number, count: number, packed = false) => {
    const { bytes, stride } = view(bufferView);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[componentType as 5126]!;
    const step = packed ? size * n : (stride ?? size * n);
    for (let e = 0; e < count; e++) {
      for (let c = 0; c < n; c++) {
        const off = byteOffset + e * step + c * size;
        let val: number;
        switch (componentType) {
          case 5126: val = dv.getFloat32(off, true); break;
          case 5125: val = dv.getUint32(off, true); break;
          case 5123: val = dv.getUint16(off, true); break;
          case 5122: val = dv.getInt16(off, true); break;
          case 5121: val = dv.getUint8(off); break;
          default: val = dv.getInt8(off);
        }
        // Normalized integer attributes (quantized UVs, colors, weights, rotations).
        if (normalized && componentType !== 5126) val = Math.max(-1, val / ({ 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[componentType as 5121] ?? 1));
        out[e * n + c] = val;
      }
    }
  };
  const accessor = (i: number): Float32Array | Uint32Array => {
    const a = json.accessors[i];
    const n = COMPONENTS[a.type]!;
    const count = a.count as number;
    const out = a.componentType === 5126 || a.normalized ? new Float32Array(count * n) : new Uint32Array(count * n);
    if (a.bufferView !== undefined) read(out, a.bufferView, a.byteOffset ?? 0, a.componentType, !!a.normalized, n, count);
    // Sparse accessors (common for morph targets): values replace elements at the listed indices.
    if (a.sparse) {
      const sc = a.sparse.count as number;
      const idx = new Uint32Array(sc);
      read(idx, a.sparse.indices.bufferView, a.sparse.indices.byteOffset ?? 0, a.sparse.indices.componentType, false, 1, sc, true);
      const vals = out instanceof Float32Array ? new Float32Array(sc * n) : new Uint32Array(sc * n);
      read(vals, a.sparse.values.bufferView, a.sparse.values.byteOffset ?? 0, a.componentType, !!a.normalized, n, sc, true);
      for (let e = 0; e < sc; e++) for (let c = 0; c < n; c++) out[idx[e]! * n + c] = vals[e * n + c]!;
    }
    return out;
  };
  const images: Promise<(CanvasImageSource & { width: number; height: number }) | undefined>[] = (json.images ?? []).map(async (img: any) => {
    try {
      if (img.bufferView !== undefined) return decodeImage(view(img.bufferView).bytes, img.mimeType ?? 'image/png');
      if (img.uri?.startsWith('data:')) {
        const mime = /^data:([^;,]+)/.exec(img.uri)?.[1] ?? 'image/png';
        return decodeImage(Uint8Array.from(atob(img.uri.slice(img.uri.indexOf(',') + 1)), (c) => c.charCodeAt(0)), mime);
      }
      if (img.uri) return decodeImage(new Uint8Array(await load(decodeURIComponent(img.uri))), /\.jpe?g$/i.test(img.uri) ? 'image/jpeg' : 'image/png');
    } catch {
      warnings.add('a texture could not be decoded');
    }
    return undefined;
  });
  const decoded = await Promise.all(images);
  const materialOf = (i: number | undefined): ModelMaterial => {
    if (i === undefined) return {};
    const m = json.materials?.[i] ?? {};
    const pbr = m.pbrMetallicRoughness ?? {};
    const tex = pbr.baseColorTexture ? json.textures?.[pbr.baseColorTexture.index] : undefined;
    return {
      color: pbr.baseColorFactor ?? [1, 1, 1, 1],
      metalness: pbr.metallicFactor ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
      emissive: m.emissiveFactor,
      doubleSided: !!m.doubleSided,
      texture: tex?.source !== undefined ? decoded[tex.source] : undefined,
      transparent: m.alphaMode === 'BLEND',
    };
  };
  const nodes: ModelNodeData[] = (json.nodes ?? []).map((node: any) => ({
    name: node.name,
    translation: (node.translation ?? [0, 0, 0]) as Vec3,
    rotation: (node.rotation ?? [0, 0, 0, 1]) as Quat,
    scale: (node.scale ?? [1, 1, 1]) as Vec3,
    matrix: node.matrix ? new Float32Array(node.matrix) : undefined,
    children: node.children ?? [],
    weights: node.weights,
  }));
  const skins: ModelSkin[] = (json.skins ?? []).map((sk: any) => {
    const ibm = sk.inverseBindMatrices !== undefined ? accessor(sk.inverseBindMatrices) : undefined;
    return { joints: sk.joints as number[], inverseBind: (sk.joints as number[]).map((_, j) => (ibm ? Float32Array.from(ibm.subarray(j * 16, j * 16 + 16)) : mat4.identity())) };
  });
  const parts: ModelPart[] = [];
  const visit = (ni: number, parent: Mat4) => {
    const node = json.nodes[ni];
    const nd = nodes[ni]!;
    const local = nd.matrix ?? mat4.fromQuat(nd.translation, nd.rotation, nd.scale);
    const world = mat4.multiply(parent, local);
    if (node.mesh !== undefined) {
      const mesh = json.meshes[node.mesh];
      for (const prim of mesh.primitives) {
        if (prim.mode !== undefined && prim.mode !== 4) {
          warnings.add('non-triangle primitives');
          continue;
        }
        const positions = accessor(prim.attributes.POSITION) as Float32Array;
        const count = positions.length / 3;
        const indices = prim.indices !== undefined ? Uint32Array.from(accessor(prim.indices)) : new Uint32Array(count).map((_, i) => i);
        const normals = prim.attributes.NORMAL !== undefined ? Float32Array.from(accessor(prim.attributes.NORMAL)) : computeNormals({ positions, indices });
        const uvs = prim.attributes.TEXCOORD_0 !== undefined ? Float32Array.from(accessor(prim.attributes.TEXCOORD_0)) : new Float32Array(count * 2);
        const colors = prim.attributes.COLOR_0 !== undefined ? toRGBA(Float32Array.from(accessor(prim.attributes.COLOR_0)), count) : undefined;
        const part: ModelPart = { geometry: { positions: Float32Array.from(positions), normals, uvs, indices, colors }, material: materialOf(prim.material), matrix: world, name: mesh.name, node: ni };
        if (node.skin !== undefined && prim.attributes.JOINTS_0 !== undefined && prim.attributes.WEIGHTS_0 !== undefined) {
          // JOINTS_0/WEIGHTS_0 (+ JOINTS_1/WEIGHTS_1): 4 or 8 influences per vertex.
          const sets = prim.attributes.JOINTS_1 !== undefined && prim.attributes.WEIGHTS_1 !== undefined ? [0, 1] : [0];
          const js = sets.map((k) => accessor(prim.attributes[`JOINTS_${k}`]));
          const ws = sets.map((k) => accessor(prim.attributes[`WEIGHTS_${k}`]));
          const per = 4 * sets.length;
          part.skin = node.skin;
          part.influences = per;
          part.joints = new Uint32Array(count * per);
          part.weights = new Float32Array(count * per);
          for (let v = 0; v < count; v++) {
            for (let k = 0; k < sets.length; k++) {
              for (let c = 0; c < 4; c++) {
                part.joints[v * per + k * 4 + c] = js[k]![v * 4 + c]!;
                part.weights[v * per + k * 4 + c] = ws[k]![v * 4 + c]!;
              }
            }
          }
        }
        if (prim.targets?.length) {
          const names: string[] = mesh.extras?.targetNames ?? [];
          part.morph = {
            positions: prim.targets.map((t: any) => (t.POSITION !== undefined ? Float32Array.from(accessor(t.POSITION)) : new Float32Array(count * 3))),
            normals: prim.targets.map((t: any) => (t.NORMAL !== undefined ? Float32Array.from(accessor(t.NORMAL)) : undefined)),
            weights: prim.targets.map((_: unknown, i: number) => nd.weights?.[i] ?? mesh.weights?.[i] ?? 0),
            names: prim.targets.map((_: unknown, i: number) => names[i] ?? String(i)),
          };
        }
        parts.push(part);
      }
    }
    for (const c of node.children ?? []) visit(c, world);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  const roots: number[] = scene?.nodes ?? (json.nodes ?? []).map((_: unknown, i: number) => i);
  for (const r of roots) visit(r, mat4.identity());
  const animations: ModelAnimation[] = (json.animations ?? []).map((an: any, ai: number) => {
    const channels: AnimationChannel[] = [];
    for (const ch of an.channels ?? []) {
      const path = ch.target?.path;
      if (ch.target?.node === undefined || !['translation', 'rotation', 'scale', 'weights'].includes(path)) {
        warnings.add(`animation channels targeting ${path ?? 'unknown'}`);
        continue;
      }
      const smp = an.samplers[ch.sampler];
      const times = Float32Array.from(accessor(smp.input));
      channels.push({ node: ch.target.node, path, interpolation: smp.interpolation ?? 'LINEAR', times, values: Float32Array.from(accessor(smp.output)) });
    }
    const duration = Math.max(0, ...channels.map((c) => c.times[c.times.length - 1] ?? 0));
    return { name: an.name ?? `animation ${ai}`, duration, channels };
  });
  return { parts, warnings: [...warnings].map((w) => `${w} not imported`), nodes, roots, skins, animations };
}

function toRGBA(c: Float32Array, count: number): Float32Array {
  if (c.length === count * 4) return c;
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    out[i * 4] = c[i * 3]!;
    out[i * 4 + 1] = c[i * 3 + 1]!;
    out[i * 4 + 2] = c[i * 3 + 2]!;
    out[i * 4 + 3] = 1;
  }
  return out;
}

/** Splits a .glb container into its JSON and binary chunks. */
export function parseGLB(buf: ArrayBuffer): { json: any; bin?: Uint8Array } {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a binary glTF (.glb) file');
  let off = 12;
  let json: any;
  let bin: Uint8Array | undefined;
  while (off < buf.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const data = new Uint8Array(buf, off + 8, len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  return { json, bin };
}

registerModelLoader('glb', async (src, load) => {
  const { json, bin } = parseGLB(await load(src));
  return parseGLTF(json, bin, (uri) => load(dirOf(src) + uri));
});
registerModelLoader('gltf', async (src, load) => {
  const json = JSON.parse(new TextDecoder().decode(await load(src)));
  return parseGLTF(json, undefined, (uri) => load(dirOf(src) + uri));
});
