import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composition, makeContext, type Env } from '@tasweerix/core';
import { closeTestBrowser, renderFrames } from '../../cli/src/testing';
import { box, camera3d, evaluateScene, extrudeGeometry, geometryBounds, light, mat4, parseGLB, parseGLTF, parseOBJ, scene3d, signedArea, sphere, text3d, triangulate, type Scene3DNode } from '../src';

const dir = join(__dirname, '.tmp');
const repo = join(__dirname, '../../..');
const close = (a: number[], b: number[], tol = 4) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  // Frame N has gray level N*4 (as in the renderer tests).
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', "nullsrc=s=64x64:r=30:d=2,geq=lum='N*4':cb=128:cr=128", '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', join(dir, 'ramp.mp4')]);
});
afterAll(closeTestBrowser);

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

const src = (body: string) => `import { composition, scene3d, box, sphere, plane, camera3d, light, layer3d, video, group, rect, keys } from 'tasweerix';\n${body}`;

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
