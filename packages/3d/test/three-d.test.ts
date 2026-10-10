import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composition, makeContext, type Env } from '@tasweerix/core';
import { closeTestBrowser, renderFrames } from '../../cli/src/testing';
import { writeFileSync } from 'node:fs';
import { box, camera3d, equirectUv, evaluateScene, extrudeGeometry, geometryBounds, light, mat4, model, parseGLB, parseGLTF, parseHDR, parseOBJ, scene3d, signedArea, sphere, text3d, triangulate, type Scene3DNode } from '../src';

const dir = join(__dirname, '.tmp');
const repo = join(__dirname, '../../..');
const close = (a: number[], b: number[], tol = 4) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  // Frame N has gray level N*4 (as in the renderer tests).
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', "nullsrc=s=64x64:r=30:d=2,geq=lum='N*4':cb=128:cr=128", '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', join(dir, 'ramp.mp4')]);
});
afterAll(closeTestBrowser);

/** A .gltf JSON with one embedded buffer holding `arrays` (one buffer view each, in order). */
function packGLTF(arrays: (Float32Array | Uint16Array | Uint8Array)[], json: Record<string, unknown>): any {
  const views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  let len = 0;
  for (const a of arrays) {
    views.push({ buffer: 0, byteOffset: len, byteLength: a.byteLength });
    len += Math.ceil(a.byteLength / 4) * 4;
  }
  const bin = new Uint8Array(len);
  arrays.forEach((a, i) => bin.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), views[i]!.byteOffset));
  return { asset: { version: '2.0' }, ...json, buffers: [{ byteLength: len, uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}` }], bufferViews: views };
}

/**
 * A 2×2 quad (x, y in −1..1) skinned to two joints: the bottom edge follows the root joint, the top
 * edge a "tip" joint that an animation moves from x = 0 to x = 2 over one second. A morph target
 * ("drop") lowers the bottom-left corner by one unit; the clip animates its weight from 0 to 1.
 */
function skinnedQuad(): any {
  const pos = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const joints = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const ibm = new Float32Array([...mat4.identity(), ...mat4.translation([0, -1, 0])]);
  const times = new Float32Array([0, 1]);
  const moves = new Float32Array([0, 1, 0, 2, 1, 0]);
  const drop = new Float32Array([0, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const dropW = new Float32Array([0, 1]);
  return packGLTF([pos, nrm, idx, joints, weights, ibm, times, moves, drop, dropW], {
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0, skin: 0 }, { name: 'root', children: [2] }, { name: 'tip', translation: [0, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, JOINTS_0: 3, WEIGHTS_0: 4 }, indices: 2, targets: [{ POSITION: 8 }] }], weights: [0], extras: { targetNames: ['drop'] } }],
    skins: [{ joints: [1, 2], inverseBindMatrices: 5 }],
    animations: [{ name: 'slide', channels: [{ sampler: 0, target: { node: 2, path: 'translation' } }, { sampler: 1, target: { node: 0, path: 'weights' } }], samplers: [{ input: 6, output: 7 }, { input: 6, output: 9 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
      { bufferView: 3, componentType: 5121, count: 4, type: 'VEC4' },
      { bufferView: 4, componentType: 5126, count: 4, type: 'VEC4' },
      { bufferView: 5, componentType: 5126, count: 2, type: 'MAT4' },
      { bufferView: 6, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 7, componentType: 5126, count: 2, type: 'VEC3' },
      { bufferView: 8, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 9, componentType: 5126, count: 2, type: 'SCALAR' },
    ],
  });
}

/** Total area of a triangulation. */
function triArea(points: [number, number][], tris: number[]): number {
  let a = 0;
  for (let i = 0; i < tris.length; i += 3) a += Math.abs(signedArea([points[tris[i]!]!, points[tris[i + 1]!]!, points[tris[i + 2]!]!]));
  return a;
}

describe('3D geometry', () => {
  it('triangulates polygons with holes', () => {
    const outer: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const hole: [number, number][] = [[3, 3], [3, 7], [7, 7], [7, 3]];
    const { points, triangles } = triangulate(outer, [hole]);
    expect(triArea(points as [number, number][], triangles)).toBeCloseTo(100 - 16, 6);
    // A concave "L" shape.
    const l = triangulate([[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]]);
    expect(l.triangles.length / 3).toBe(4);
    expect(triArea(l.points as [number, number][], l.triangles)).toBeCloseTo(7, 6);
  });

  it('extrudes SVG paths into closed solids', () => {
    // A ring: outer and inner circles (holes found by nesting, whatever the winding).
    const g = extrudeGeometry('M 0 -50 A 50 50 0 1 1 0 50 A 50 50 0 1 1 0 -50 Z M 0 -20 A 20 20 0 1 0 0 20 A 20 20 0 1 0 0 -20 Z', { depth: 0.4, scale: 0.01 });
    const b = geometryBounds(g);
    expect(b.min[0]).toBeCloseTo(-0.5, 2);
    expect(b.max[1]).toBeCloseTo(0.5, 2);
    expect(b.min[2]).toBeCloseTo(-0.2, 6);
    // Front cap area ≈ π(0.5² − 0.2²).
    let area = 0;
    for (let i = 0; i < g.indices.length; i += 3) {
      const [a, c, d] = [g.indices[i]!, g.indices[i + 1]!, g.indices[i + 2]!];
      if (g.normals[a * 3 + 2]! < 0.99) continue;
      area += Math.abs(signedArea([[g.positions[a * 3]!, g.positions[a * 3 + 1]!], [g.positions[c * 3]!, g.positions[c * 3 + 1]!], [g.positions[d * 3]!, g.positions[d * 3 + 1]!]]));
    }
    expect(area).toBeCloseTo(Math.PI * (0.25 - 0.04), 2);
  });

  it('loads OBJ and glTF binary models', async () => {
    const obj = await parseOBJ('mtllib x.mtl\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nusemtl red\nf 1 2 3 4\n', 'newmtl red\nKd 1 0 0\n');
    expect(obj.parts).toHaveLength(1);
    expect(obj.parts[0]!.geometry.indices.length).toBe(6);
    expect(obj.parts[0]!.material.color).toEqual([1, 0, 0, 1]);
    expect(Array.from(obj.parts[0]!.geometry.normals.slice(0, 3))).toEqual([0, 0, 1]);

    // A one-triangle .glb with a translated node and a base color.
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const idx = new Uint16Array([0, 1, 2, 0]);
    const bin = new Uint8Array(pos.byteLength + idx.byteLength);
    bin.set(new Uint8Array(pos.buffer), 0);
    bin.set(new Uint8Array(idx.buffer), pos.byteLength);
    const json = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ translation: [0, 2, 0], children: [1] }, { mesh: 0, scale: [2, 2, 2] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [0, 1, 0, 1], metallicFactor: 0.5, roughnessFactor: 0.25 } }],
      buffers: [{ byteLength: bin.byteLength }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: 6 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }],
    };
    const enc = new TextEncoder().encode(JSON.stringify(json));
    const jlen = Math.ceil(enc.length / 4) * 4;
    const blen = Math.ceil(bin.length / 4) * 4;
    const glb = new Uint8Array(12 + 8 + jlen + 8 + blen);
    const dv = new DataView(glb.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, glb.length, true);
    dv.setUint32(12, jlen, true);
    dv.setUint32(16, 0x4e4f534a, true);
    glb.fill(0x20, 20, 20 + jlen);
    glb.set(enc, 20);
    dv.setUint32(20 + jlen, blen, true);
    dv.setUint32(24 + jlen, 0x004e4942, true);
    glb.set(bin, 28 + jlen);
    const { json: j, bin: b } = parseGLB(glb.buffer);
    const model = await parseGLTF(j, b, async () => new ArrayBuffer(0));
    expect(model.parts).toHaveLength(1);
    const part = model.parts[0]!;
    expect(part.material).toMatchObject({ color: [0, 1, 0, 1], metalness: 0.5, roughness: 0.25 });
    expect(mat4.transformPoint(part.matrix, [1, 0, 0])).toEqual([2, 2, 0]);
    expect(Array.from(part.geometry.normals.slice(0, 3))).toEqual([0, 0, 1]);
  });

  it('imports skins, morph targets and animation clips from glTF', async () => {
    const m = await parseGLTF(skinnedQuad(), undefined, async () => new ArrayBuffer(0));
    expect(m.warnings).toEqual([]);
    expect(m.animations?.map((a) => [a.name, a.duration])).toEqual([['slide', 1]]);
    const node = model('quad.gltf');
    node.model = m;
    const at = (t: number, extra: Record<string, unknown> = {}) => {
      Object.assign(node.props, extra);
      const scene = evaluateScene(scene3d(node), makeContext({ time: t, fps: 30, width: 100, height: 100 }));
      const it = scene.items[0]!;
      const p = it.geometry.build().positions;
      // Vertices in scene space (bottom-left, bottom-right, top-right, top-left).
      return [0, 1, 2, 3].map((v) => mat4.transformPoint(it.matrix, [p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!]).map((x) => +x.toFixed(4)));
    };
    // Rest pose at t = 0.
    expect(at(0)).toEqual([[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]]);
    // Halfway: the tip joint moved 1 unit right, the morph weight is 0.5.
    expect(at(0.5)).toEqual([[-1, -1.5, 0], [1, -1, 0], [2, 1, 0], [0, 1, 0]]);
    // Looping wraps the clip; animationTime scrubs; morph overrides by name; null keeps the rest pose.
    expect(at(1.25)[2]).toEqual([1.5, 1, 0]);
    expect(at(0, { animationTime: 0.75 })[3]).toEqual([0.5, 1, 0]);
    expect(at(0, { animationTime: null, morphs: { drop: 1 } })[0]).toEqual([-1, -2, 0]);
    expect(at(0.5, { animation: null, morphs: null })).toEqual([[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]]);
    expect(at(2, { animation: 'slide', loop: false })[2]).toEqual([3, 1, 0]);
  });

  it('decodes Radiance .hdr files (flat and run-length encoded)', () => {
    const header = (w: number, h: number) => new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`);
    // Flat: 2×1 pixels, 0.5 gray and (1, 2, 0) (mantissas × 2^(e − 136)).
    const flat = new Uint8Array([...header(2, 1), 128, 128, 128, 128, 64, 128, 0, 130]);
    expect(Array.from(parseHDR(flat.buffer).data)).toEqual([0.5, 0.5, 0.5, 1, 2, 0]);
    // RLE: one 8-pixel scanline, every plane a run (R, G, B = 128, E = 129 → 1.0) except G literal.
    const g = [10, 20, 30, 40, 50, 60, 70, 80];
    const rle = new Uint8Array([...header(8, 1), 2, 2, 0, 8, 128 + 8, 128, 8, ...g, 128 + 8, 128, 128 + 8, 129]);
    const img = parseHDR(rle.buffer);
    expect(img.width).toBe(8);
    expect(Array.from(img.data.filter((_, i) => i % 3 === 1))).toEqual(g.map((v) => v / 128));
    expect(img.data[0]).toBe(1);
    expect(equirectUv([0, 0, -1])).toEqual([0.5, 0.5]);
    expect(equirectUv([0, 1, 0])[1]).toBe(0);
  });

  it('builds shaped (Arabic) 3D text from a font file', async () => {
    const env: Env = { kind: 'node', probe: async () => ({}), loadBinary: async (p) => readFileSync(join(repo, p)).buffer as ArrayBuffer };
    const comp = await composition({ width: 320, height: 180 }, (c) => {
      c.add(scene3d(text3d('سلام', { font: 'assets/fonts/Cairo-Bold.ttf', size: 1, depth: 0.3 })));
    }).create({ env });
    const scene = evaluateScene(comp.root.children[0] as Scene3DNode, comp.contextAt(0));
    const g = scene.items[0]!.geometry.build();
    const b = geometryBounds(g);
    // Joined Arabic letters: one connected word about 2 units wide, centered vertically.
    expect(b.max[0] - b.min[0]).toBeGreaterThan(1);
    expect(b.max[0] - b.min[0]).toBeLessThan(3);
    expect(b.max[2] - b.min[2]).toBeCloseTo(0.3, 6);
    expect(g.indices.length).toBeGreaterThan(300);
  });
});

describe('3D scene evaluation', () => {
  it('uses the last active camera and adds a default light', () => {
    const s = scene3d(camera3d({ position: [0, 0, 5], duration: 1 }), camera3d({ position: [5, 0, 0], start: 1 }), box());
    const at = (t: number) => evaluateScene(s, makeContext({ time: t, fps: 30, width: 100, height: 100 }));
    expect(at(0.5).camera.position).toEqual([0, 0, 5]);
    expect(at(1.5).camera.position).toEqual([5, 0, 0]);
    expect(at(0.5).lights).toHaveLength(1);
    const lit = evaluateScene(scene3d(light.point({ position: [1, 2, 3], intensity: 2 }), sphere()), makeContext({ fps: 30, width: 100, height: 100 }));
    expect(lit.lights[0]).toMatchObject({ kind: 'point', position: [1, 2, 3], color: [2, 2, 2] });
  });
});

const src = (body: string) => `import { composition, scene3d, box, sphere, plane, camera3d, light, layer3d, model, video, group, rect, keys } from 'tasweerix';\n${body}`;

describe('3D rendering (headless Chromium, WebGL2)', () => {
  it('renders unlit colors exactly and occludes by depth', async () => {
    const { frames } = await renderFrames({
      dir,
      frames: [0],
      source: src(`export default composition({ width: 200, height: 100, fps: 10, duration: 1, background: '#000000' }, (c) => {
        c.add(scene3d(
          camera3d({ position: [0, 0, 10], target: [0, 0, 0], orthographic: 2 }),
          plane({ size: [4, 2], color: '#ff8000', unlit: true }),
          box({ size: [1, 1, 1], position: [0, 0, 1], color: '#0040ff', unlit: true }),
          box({ size: [3, 3, 0.1], position: [0, 0, -3], color: '#00ff00', unlit: true }),
        ));
      });`),
    });
    const f = frames[0]!;
    expect(close(f.at(10, 50), [255, 128, 0, 255])).toBe(true);
    expect(close(f.at(100, 50), [0, 64, 255, 255])).toBe(true);
  });

  it('shades lit surfaces over a transparent background', async () => {
    const { frames } = await renderFrames({
      dir,
      frames: [0],
      source: src(`export default composition({ width: 200, height: 200, fps: 10, duration: 1, background: null }, (c) => {
        c.add(scene3d({ ambientIntensity: 0.2 },
          camera3d({ position: [0, 10, 0.001], target: [0, 0, 0], orthographic: 6 }),
          light.directional({ position: [0, 10, 0], target: [0, 0, 0], intensity: 1, castShadow: true }),
          plane({ size: [5, 5], rotation: [-90, 0, 0], color: '#ffffff' }),
          box({ size: [1, 0.2, 1], position: [1.5, 2, 0], color: '#ffffff', castShadow: true }),
        ));
      });`),
    });
    const f = frames[0]!;
    // Top view: the lit floor is near white; outside the 5-unit floor the scene stays transparent.
    const floor = f.at(40, 100);
    expect(floor[0]).toBeGreaterThan(220);
    expect(f.at(2, 2)[3]).toBe(0);
  });

  it('casts a visible shadow from a slanted light', async () => {
    const { frames } = await renderFrames({
      dir,
      frames: [0],
      source: src(`export default composition({ width: 200, height: 200, fps: 10, duration: 1, background: '#000' }, (c) => {
        c.add(scene3d({ ambientIntensity: 0.1 },
          camera3d({ position: [0, 10, 0.001], target: [0, 0, 0], orthographic: 6 }),
          light.directional({ position: [5, 5, 0], target: [0, 0, 0], intensity: 1, castShadow: true }),
          plane({ size: [6, 6], rotation: [-90, 0, 0], color: '#ffffff' }),
          box({ size: [0.6, 0.6, 0.6], position: [0, 1.5, 0], color: '#ff0000' }),
        ));
      });`),
    });
    const f = frames[0]!;
    // Light from +x at 45°: the shadow of a box 1.5 above the floor lands 1.5 units toward −x.
    const shadow = f.at(100 - (1.5 * 200) / 6, 100);
    const lit = f.at(100 + (1.5 * 200) / 6, 100);
    expect(lit[0]).toBeGreaterThan(150);
    expect(shadow[0]).toBeLessThan(lit[0] * 0.5);
    // The box itself (red) is seen from above.
    expect(f.at(100, 100)[0]).toBeGreaterThan(f.at(100, 100)[1] + 50);
  });

  it('casts shadows from several directional lights', async () => {
    const { frames } = await renderFrames({
      dir,
      frames: [0],
      source: src(`export default composition({ width: 200, height: 200, fps: 10, duration: 1, background: '#000' }, (c) => {
        c.add(scene3d({ ambientIntensity: 0.05 },
          camera3d({ position: [0, 10, 0.001], target: [0, 0, 0], orthographic: 4 }),
          light.directional({ position: [5, 5, 0], target: [0, 0, 0], intensity: 0.6, castShadow: true }),
          light.directional({ position: [0, 5, 5], target: [0, 0, 0], intensity: 0.6, castShadow: true }),
          plane({ size: [6, 6], rotation: [-90, 0, 0], color: '#ffffff' }),
          box({ size: [0.5, 0.5, 0.5], position: [0, 1, 0], color: '#ff0000' }),
        ));
      });`),
    });
    const f = frames[0]!;
    // 50 px per unit; screen up is −z. Each light throws the box's shadow 1 unit away from it.
    const lit = f.at(150, 150)[0];
    expect(lit).toBeGreaterThan(150);
    expect(f.at(50, 100)[0]).toBeLessThan(lit * 0.8);
    expect(f.at(100, 50)[0]).toBeLessThan(lit * 0.8);
  });

  it('casts omnidirectional shadows from point lights', async () => {
    const { frames } = await renderFrames({
      dir,
      frames: [0],
      source: src(`export default composition({ width: 200, height: 200, fps: 10, duration: 1, background: '#000' }, (c) => {
        c.add(scene3d({ ambientIntensity: 0 },
          camera3d({ position: [0, 10, 0.001], target: [0, 0, 0], orthographic: 4 }),
          light.point({ position: [2, 3, 0], intensity: 20, castShadow: true }),
          plane({ size: [6, 6], rotation: [-90, 0, 0], color: '#ffffff' }),
          box({ size: [0.5, 0.5, 0.5], position: [0, 1, 0], color: '#ff0000' }),
        ));
      });`),
    });
    const f = frames[0]!;
    // The ray from the light through the box hits the floor at x = −1.
    const shadow = f.at(50, 100)[0];
    const lit = f.at(50, 150)[0];
    expect(lit).toBeGreaterThan(60);
    expect(shadow).toBeLessThan(lit * 0.4);
  });

  it('lights and reflects with environments (built-in and .hdr)', async () => {
    // A uniform 0.5 gray .hdr (16×8, flat scanlines).
    const px = new Uint8Array(16 * 8 * 4).fill(128);
    writeFileSync(join(dir, 'gray.hdr'), Buffer.concat([Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 8 +X 16\n'), Buffer.from(px)]));
    const scene = (x: number, env: string, extra = '') => `scene3d({ size: [100, 100], at: [${x}, 50], environment: ${env}, ambientIntensity: 0 ${extra} },
      camera3d({ position: [0, 0, 4], target: [0, 0, 0], fov: 90 }),
      light.ambient({ intensity: 0 }),
      sphere({ radius: 1, metalness: 1, roughness: 0.15, color: '#ffffff' }),
    )`;
    const { frames } = await renderFrames({
      dir,
      frames: [0],
      source: src(`export default composition({ width: 400, height: 100, fps: 10, duration: 1, background: '#000' }, (c) => {
        c.add(${scene(50, "'sky'", ', environmentBackground: true')});
        c.add(${scene(150, 'null')});
        c.add(${scene(250, "'gray.hdr'", ', environmentBackground: true')});
        c.add(${scene(350, "'studio'")});
      });`),
    });
    const f = frames[0]!;
    // Sky background: blue above the horizon, warm ground below.
    const top = f.at(50, 2);
    const bottom = f.at(50, 97);
    expect(top[2]).toBeGreaterThan(top[0] + 30);
    expect(bottom[0]).toBeGreaterThan(bottom[2]);
    // A chrome sphere reflects the environment; without one it stays black.
    expect(Math.max(...f.at(50, 40).slice(0, 3))).toBeGreaterThan(60);
    expect(Math.max(...f.at(150, 40).slice(0, 3))).toBeLessThan(10);
    expect(Math.max(...f.at(350, 40).slice(0, 3))).toBeGreaterThan(40);
    // A uniform 0.5 .hdr: the background is sRGB(0.5) and the chrome sphere reflects about the same.
    expect(close(f.at(205, 5), [186, 186, 186, 255], 6)).toBe(true);
    expect(close(f.at(250, 50), [186, 186, 186, 255], 25)).toBe(true);
  });

  it('plays skinned glTF animations', async () => {
    writeFileSync(join(dir, 'skin.gltf'), JSON.stringify(skinnedQuad()));
    const { frames } = await renderFrames({
      dir,
      frames: [0, 5],
      source: src(`export default composition({ width: 200, height: 200, fps: 10, duration: 1, background: '#000' }, (c) => {
        c.add(scene3d(
          camera3d({ position: [0, 0, 10], target: [0, 0, 0], orthographic: 4 }),
          model('skin.gltf', { color: '#00ff00', unlit: true, doubleSided: true, morphs: { drop: 0 } }),
        ));
      });`),
    });
    // 50 px per unit around (100, 100). Rest: a square; at 0.5 s the top edge has slid 1 unit right.
    const [rest, moved] = frames as [(typeof frames)[0], (typeof frames)[0]];
    expect(rest.at(60, 55)[1]).toBeGreaterThan(200);
    expect(rest.at(175, 55)[1]).toBeLessThan(20);
    expect(moved.at(60, 55)[1]).toBeLessThan(20);
    expect(moved.at(175, 55)[1]).toBeGreaterThan(200);
  });

  it('maps video frames and 2D layers onto 3D planes', async () => {
    const ids = [0, 12, 45];
    const { frames } = await renderFrames({
      dir,
      frames: ids,
      source: src(`export default composition({ width: 128, height: 64, fps: 30, duration: 2, background: '#000' }, (c) => {
        c.add(scene3d(
          camera3d({ position: [0, 0, 10], target: [0, 0, 0], orthographic: 2 }),
          layer3d(video('ramp.mp4', { size: [64, 64] }), { mapSize: [64, 64], size: [2, 2], position: [-1, 0, 0] }),
          layer3d(group(rect({ size: [64, 64], fill: '#00ff00' })), { mapSize: [64, 64], size: [2, 2], position: [1, 0, 0] }),
        ));
      });`),
    });
    const toR = (n: number) => Math.max(0, Math.min(255, ((n * 4 - 16) * 255) / 219));
    frames.forEach((f, i) => {
      expect(Math.abs(f.at(32, 32)[0] - toR(ids[i]!)), `frame ${ids[i]}`).toBeLessThanOrEqual(4);
      expect(close(f.at(96, 32), [0, 255, 0, 255])).toBe(true);
    });
  });
});
