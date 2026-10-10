import { mat2d, type SceneNode, type Vec2 } from '@tasweerix/core';
import { createSurface, ctx2d, registerDrawer, type Ctx2D, type DrawContext, type Renderer, type Surface } from '@tasweerix/render';
import { evaluateScene, type DrawItem } from './evaluate';
import { MeshNode, Object3DNode, type Scene3DNode } from './nodes';
import { Renderer3D, type TexSource } from './renderer3d';

const renderers = new WeakMap<Renderer, Renderer3D>();
const layers = new WeakMap<Renderer, Map<string, { surface: Surface; ctx: Ctx2D }>>();

/** The 3D renderer attached to a 2D renderer (one WebGL2 context each). */
export function renderer3dFor(r: Renderer): Renderer3D {
  let r3 = renderers.get(r);
  if (!r3) renderers.set(r, (r3 = new Renderer3D()));
  return r3;
}

const MAX_SIZE = 4096;

/** Renders a texture node (video, comp, group …) into a reusable surface for this frame. */
function layerTexture(d: DrawContext, it: DrawItem, node: SceneNode): TexSource {
  const r = d.renderer;
  const size = (it.props.mapSize as Vec2 | null) ?? [d.frame.width, d.frame.height];
  const w = Math.max(1, Math.round(size[0] * r.scale));
  const h = Math.max(1, Math.round(size[1] * r.scale));
  let map = layers.get(r);
  if (!map) layers.set(r, (map = new Map()));
  let l = map.get(it.node.id);
  if (!l || l.surface.width !== w || l.surface.height !== h) {
    const surface = createSurface(w, h);
    l = { surface, ctx: ctx2d(surface) };
    map.set(it.node.id, l);
  }
  const c = l.ctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, w, h);
  r.renderNode(node, it.node.childCtx(it.local), c, mat2d.multiply(mat2d.scale(r.scale), mat2d.translate(size[0] / 2, size[1] / 2)), 1);
  return l.surface as TexSource;
}

registerDrawer(
  'scene3d',
  (d) => {
    const node = d.node as Scene3DNode;
    const size = (d.props.size as Vec2 | null) ?? [d.frame.width, d.frame.height];
    const m = d.matrix;
    // Device pixels per scene pixel (renderer scale and the node's own scaling).
    const px = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    let w = size[0] * px;
    let h = size[1] * px;
    const over = Math.max(w, h) / MAX_SIZE;
    if (over > 1) {
      w /= over;
      h /= over;
    }
    const scene = evaluateScene(node, d.frame);
    const r3 = renderer3dFor(d.renderer);
    const canvas = r3.render(scene, w, h, (it) => {
      if (it.part?.texture) return { source: it.part.texture as TexSource };
      if (it.node.mapNode) return { source: layerTexture(d, it, it.node.mapNode), dynamicKey: it.node.id };
      const map = it.props.map;
      if (typeof map === 'string' && map) {
        const img = d.renderer.assets.getImage(map);
        return img ? { source: img as TexSource } : null;
      }
      return null;
    });
    const img = typeof (canvas as OffscreenCanvas).transferToImageBitmap === 'function' ? (canvas as OffscreenCanvas).transferToImageBitmap() : canvas;
    d.ctx.drawImage(img, -size[0] / 2, -size[1] / 2, size[0], size[1]);
    (img as ImageBitmap).close?.();
  },
  {
    drawsChildren: true,
    // Image textures load before the first frame (video and layer maps render per frame).
    async prepare(node, renderer) {
      const tasks: Promise<unknown>[] = [];
      node.walk((n) => {
        if (n instanceof MeshNode && typeof n.props.map === 'string' && n.props.map) tasks.push(renderer.assets.loadImage(n.props.map));
        return n === node || n instanceof Object3DNode ? undefined : false;
      });
      await Promise.all(tasks);
    },
  },
);
