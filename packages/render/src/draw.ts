import {
  CanvasNode,
  CompNode,
  ellipsePath,
  fitRect,
  flattenPath,
  parsePath,
  polygonPoints,
  rectPath,
  resolve,
  roundedPolygonPath,
  smoothPolyline,
  starPoints,
  trimPolylines,
  VideoNode,
  type PathData,
  type Rect,
  type ShapeStyle,
  type TextNode,
  type Vec2,
} from '@tasweerix/core';
import { FONT_FILE_RE } from './assets';
import { isVisiblePaint, toCanvasPaint } from './paint';
import { registerDrawer, Renderer, type DrawContext } from './renderer';
import type { Ctx2D } from './surface';
import { glyphStates, layoutText, type ResolvedText } from './text';
import { getTransition, customTransitionFrag, TransitionGroup } from './transitions';

// ------------------------------------------------------------ shapes

function pathToPath2D(p: PathData): Path2D {
  const out = new Path2D();
  for (const c of p) {
    if (c.c === 'M') out.moveTo(c.p[0], c.p[1]);
    else if (c.c === 'L') out.lineTo(c.p[0], c.p[1]);
    else if (c.c === 'C') out.bezierCurveTo(c.c1[0], c.c1[1], c.c2[0], c.c2[1], c.p[0], c.p[1]);
    else out.closePath();
  }
  return out;
}

const pathCache = new Map<string, PathData>();
function cachedParse(d: string): PathData {
  let p = pathCache.get(d);
  if (!p) {
    p = parsePath(d);
    if (pathCache.size > 2000) pathCache.clear();
    pathCache.set(d, p);
  }
  return p;
}

/** Fills/strokes geometry with ShapeStyle props, honoring trim paths and dashes. */
export function paintShape(d: DrawContext, geom: PathData, closedHint = true): void {
  const { ctx, props } = d;
  const s = props as unknown as ShapeStyle;
  const trimmed = s.trimStart !== 0 || s.trimEnd !== 1;
  let fillPath: Path2D | null = null;
  let strokePath: Path2D;
  if (trimmed) {
    const polys = trimPolylines(flattenPath(geom, 0.35), s.trimStart, s.trimEnd, s.trimOffset);
    strokePath = new Path2D();
    for (const poly of polys) {
      poly.forEach((pt, i) => (i ? strokePath.lineTo(pt[0], pt[1]) : strokePath.moveTo(pt[0], pt[1])));
    }
    // Trimmed shapes only show their fill when fully drawn (After-Effects-like behavior is stroke-only).
    fillPath = null;
  } else {
    strokePath = pathToPath2D(geom);
    fillPath = closedHint ? strokePath : null;
  }
  const doFill = () => {
    if (fillPath && isVisiblePaint(s.fill)) {
      const f = toCanvasPaint(ctx, s.fill, d.renderer.assets);
      if (f) {
        ctx.fillStyle = f;
        ctx.fill(fillPath, s.fillRule);
      }
    }
  };
  const doStroke = () => {
    if (s.strokeWidth > 0 && isVisiblePaint(s.stroke)) {
      const st = toCanvasPaint(ctx, s.stroke, d.renderer.assets);
      if (st) {
        ctx.strokeStyle = st;
        ctx.lineWidth = s.strokeWidth;
        ctx.lineCap = s.lineCap;
        ctx.lineJoin = s.lineJoin;
        ctx.miterLimit = s.miterLimit;
        ctx.setLineDash(s.dash ?? []);
        ctx.lineDashOffset = s.dashOffset;
        ctx.stroke(strokePath);
        ctx.setLineDash([]);
      }
    }
  };
  if (s.strokeFirst) {
    doStroke();
    doFill();
  } else {
    doFill();
    doStroke();
  }
}

registerDrawer('rect', (d) => {
  const size = d.props.size as Vec2;
  paintShape(d, rectPath(size[0], size[1], d.props.radius));
});
registerDrawer('ellipse', (d) => {
  const size = d.props.size as Vec2;
  const full = Math.abs(d.props.endAngle - d.props.startAngle) >= 360 - 1e-9;
  // Partial ellipses are pie wedges when filled, open arcs when only stroked.
  const pie = full || isVisiblePaint(d.props.fill);
  paintShape(d, ellipsePath(size[0], size[1], d.props.startAngle, d.props.endAngle, pie), pie);
});
registerDrawer('polygon', (d) => {
  paintShape(d, roundedPolygonPath(polygonPoints(d.props.sides, d.props.radius), d.props.cornerRadius));
});
registerDrawer('star', (d) => {
  paintShape(d, roundedPolygonPath(starPoints(d.props.points, d.props.outerRadius, d.props.innerRadius), d.props.cornerRadius));
});
registerDrawer('path', (d) => {
  const geom = cachedParse(d.props.d as string);
  paintShape(d, geom, true);
});
registerDrawer('polyline', (d) => {
  const pts = d.props.points as Vec2[];
  if (!pts?.length) return;
  paintShape(d, smoothPolyline(pts, d.props.closed, d.props.smooth), d.props.closed);
});

// ------------------------------------------------------------ fills

registerDrawer('solid', (d) => {
  const size = (d.props.size as Vec2 | null) ?? [d.frame.width, d.frame.height];
  const p = toCanvasPaint(d.ctx, d.props.color, d.renderer.assets);
  if (!p) return;
  d.ctx.fillStyle = p;
  d.ctx.fillRect(-size[0] / 2, -size[1] / 2, size[0], size[1]);
});

registerDrawer('canvas', (d) => {
  const n = d.node as CanvasNode;
  const size = (d.props.size as Vec2 | null) ?? [d.frame.width, d.frame.height];
  d.ctx.save();
  n.draw({ ctx: d.ctx as CanvasRenderingContext2D, frame: d.frame, size });
  d.ctx.restore();
});

registerDrawer('group', (d) => {
  const size = d.props.size as Vec2 | null;
  if (size && d.props.background) {
    const p = toCanvasPaint(d.ctx, d.props.background, d.renderer.assets);
    if (p) {
      d.ctx.fillStyle = p;
      d.ctx.fillRect(-size[0] / 2, -size[1] / 2, size[0], size[1]);
    }
  }
});

// ------------------------------------------------------------ media

export function drawMedia(d: DrawContext, img: CanvasImageSource & { width: number; height: number }, natW: number, natH: number, xf?: [number, number, number, number] | null) {
  const crop = d.props.crop as Rect | null;
  const sx = crop?.x ?? 0;
  const sy = crop?.y ?? 0;
  const sw = crop?.width ?? natW;
  const sh = crop?.height ?? natH;
  const size = (d.props.size as Vec2 | null) ?? [sw, sh];
  const fit = fitRect(sw, sh, size[0], size[1], d.props.fit);
  d.ctx.imageSmoothingEnabled = d.props.smoothing !== false;
  d.ctx.imageSmoothingQuality = 'high';
  // Source rect is expressed in natural pixels; the served frame may be scaled.
  const kx = img.width / natW;
  const ky = img.height / natH;
  const clip = d.props.fit === 'cover' || !!xf;
  if (clip) {
    d.ctx.save();
    d.ctx.beginPath();
    // A media transform stays inside the picture's own rectangle (or the box when covering it).
    if (d.props.fit === 'cover') d.ctx.rect(-size[0] / 2, -size[1] / 2, size[0], size[1]);
    else d.ctx.rect(-size[0] / 2 + fit.x, -size[1] / 2 + fit.y, fit.width, fit.height);
    d.ctx.clip();
  }
  if (xf) {
    const cx = -size[0] / 2 + fit.x + fit.width / 2;
    const cy = -size[1] / 2 + fit.y + fit.height / 2;
    d.ctx.translate(cx, cy);
    d.ctx.transform(xf[0], xf[1], -xf[1], xf[0], xf[2] * fit.width, xf[3] * fit.width);
    d.ctx.translate(-cx, -cy);
  }
  d.ctx.drawImage(img, sx * kx, sy * ky, sw * kx, sh * ky, -size[0] / 2 + fit.x, -size[1] / 2 + fit.y, fit.width, fit.height);
  if (clip) d.ctx.restore();
}

registerDrawer('image', (d) => {
  const img = d.renderer.assets.getImage(d.props.src as string);
  if (!img) return;
  drawMedia(d, img, img.width, img.height);
});

registerDrawer(
  'video',
  (d) => {
    const n = d.node as VideoNode;
    const t = n.sourceTime(d.frame);
    const img = d.renderer.videoFrames.get(Renderer.frameKey(n.src, t));
    if (!img) return;
    drawMedia(d, img, n.info?.width ?? img.width, n.info?.height ?? img.height, n.mediaTransform?.(t));
  },
  {
    async collect(node, local, renderer) {
      const n = node as VideoNode;
      const t = n.sourceTime(local);
      const key = Renderer.frameKey(n.src, t);
      if (renderer.videoFrames.has(key)) return;
      const size = resolve(n.props.size as Vec2 | null | undefined, local) ?? null;
      const hint = size ? { width: Math.round(size[0] * renderer.scale), height: Math.round(size[1] * renderer.scale) } : undefined;
      renderer.videoFrames.set(key, await renderer.assets.videoFrame(n.src, t, hint));
    },
  },
);

registerDrawer(
  'comp',
  (d) => {
    const n = d.node as CompNode;
    if (!n.inner) return;
    d.renderer.renderInnerComp(n.inner, n.contentTime(d.frame), d.ctx, d.matrix, d.ctx.globalAlpha, n.inputProps);
  },
  { drawsChildren: false },
);

// ------------------------------------------------------------ text

const fontFamilies = new Map<string, string>();
export function fontFamilyFor(font: string): string {
  return fontFamilies.get(font) ?? font;
}

type FontHook = (fontSrc: string, renderer: Renderer) => Promise<void>;
const fontHooks: FontHook[] = [];
/** Lets text engines (e.g. HarfBuzz) load font files before the first frame. */
export function onFontPrepare(hook: FontHook): void {
  fontHooks.push(hook);
}

function resolvedText(n: TextNode, props: Record<string, any>): ResolvedText {
  return { ...(props as ResolvedText), text: String(props.text ?? ''), fontFamily: fontFamilyFor(props.font) };
}

function drawTextRun(ctx: Ctx2D, text: string, x: number, y: number, props: Record<string, any>, rtl: boolean, d: DrawContext, path?: Path2D) {
  const s = props as unknown as ShapeStyle;
  const fill = isVisiblePaint(s.fill) ? toCanvasPaint(ctx, s.fill, d.renderer.assets) : null;
  const stroke = s.strokeWidth > 0 && isVisiblePaint(s.stroke) ? toCanvasPaint(ctx, s.stroke, d.renderer.assets) : null;
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = s.strokeWidth;
    ctx.lineJoin = 'round';
  }
  if (fill) ctx.fillStyle = fill;
  if (path) {
    ctx.save();
    ctx.translate(x, y);
    if (s.strokeFirst && stroke) ctx.stroke(path);
    if (fill) ctx.fill(path);
    if (!s.strokeFirst && stroke) ctx.stroke(path);
    ctx.restore();
    return;
  }
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.textAlign = 'left';
  if (s.strokeFirst && stroke) ctx.strokeText(text, x, y);
  if (fill) ctx.fillText(text, x, y);
  if (!s.strokeFirst && stroke) ctx.strokeText(text, x, y);
}

registerDrawer(
  'text',
  (d) => {
    const n = d.node as TextNode;
    const rp = resolvedText(n, d.props);
    if (!rp.text) return;
    const layout = layoutText(rp);
    const ctx = d.ctx;
    ctx.font = layout.font;
    (ctx as CanvasRenderingContext2D).letterSpacing = `${rp.letterSpacing}px`;
    (ctx as CanvasRenderingContext2D).wordSpacing = `${rp.wordSpacing}px`;
    ctx.textBaseline = 'alphabetic';
    const animated = n.glyphAnimators.length > 0;
    const pathBased = layout.glyphs.some((g) => g.path);
    if (!animated && !pathBased) {
      for (const line of layout.lines) drawTextRun(ctx, line.text, line.x, line.y, d.props, line.rtl, d);
      return;
    }
    const states = animated ? glyphStates(layout, n.glyphAnimators, d.frame) : null;
    // Cumulative tracking per line (in reading direction).
    const trackShift = new Map<number, number>();
    const baseAlpha = ctx.globalAlpha;
    layout.glyphs.forEach((g, i) => {
      const st = states?.[i];
      const shift = trackShift.get(g.line) ?? 0;
      if (st?.tracking) trackShift.set(g.line, shift + st.tracking);
      if (st && (st.opacity <= 0 || st.reveal <= 0)) return;
      const cx = g.x + g.width / 2 + (g.rtl ? -shift : shift);
      const cy = g.y - rp.size * 0.35;
      ctx.save();
      if (st) {
        ctx.translate(cx + st.x, cy + st.y);
        if (st.rotation) ctx.rotate((st.rotation * Math.PI) / 180);
        ctx.scale(st.scale * st.scaleX, st.scale * st.scaleY);
        ctx.translate(-cx, -cy);
        ctx.globalAlpha = baseAlpha * Math.min(1, st.opacity);
        if (st.blur > 0) ctx.filter = `blur(${st.blur * d.renderer.scale}px)`;
        if (st.reveal < 1) {
          ctx.beginPath();
          const w = g.width * st.reveal;
          ctx.rect(g.rtl ? g.x + g.width - w + (g.rtl ? -shift : shift) : g.x + shift, g.y - rp.size * 1.5, w, rp.size * 3);
          ctx.clip();
        }
      }
      const props = st?.fill ? { ...d.props, fill: st.fill } : d.props;
      drawTextRun(ctx, g.text, g.x + (g.rtl ? -shift : shift), g.y, props, g.rtl, d, g.path);
      ctx.restore();
    });
  },
  {
    // Fonts given as files are registered before the first frame.
    prepare: async (n, renderer) => {
      const node = n as TextNode;
      const font = node.props.font;
      const fonts = new Set<string>();
      if (typeof font === 'string') fonts.add(font);
      for (const f of fonts) {
        if (!FONT_FILE_RE.test(f)) continue;
        if (!fontFamilies.has(f)) fontFamilies.set(f, await renderer.assets.loadFont(f));
        await Promise.all(fontHooks.map((h) => h(f, renderer)));
      }
    },
  },
);

// ------------------------------------------------------------ transitions

registerDrawer(
  'xseq',
  (d) => {
    const g = d.node as TransitionGroup;
    const r = d.renderer;
    const cctx = g.childCtx(d.frame);
    const t = cctx.time;
    const active = g.children.map((c, i) => [c, i] as const).filter(([c]) => c.activeAt(t));
    if (active.length < 2) {
      d.drawChildren();
      return;
    }
    const [[a], [b, bi]] = active.slice(-2) as [[typeof g.children[0], number], [typeof g.children[0], number]];
    const spec = g.transitions[bi - 1];
    if (!spec || spec.type === 'cut' || spec.duration <= 0) {
      r.renderNode(b, cctx, d.ctx, d.matrix, d.ctx.globalAlpha);
      return;
    }
    const p = spec.ease(Math.min(1, Math.max(0, (t - b.start) / spec.duration)));
    const la = r.renderToLayer(a, cctx, d.matrix);
    const lb = r.renderToLayer(b, cctx, d.matrix);
    const gl = r.gl;
    const impl = spec.type === 'custom' ? { frag: customTransitionFrag(spec.source!) } : getTransition(spec.type);
    if (!impl) throw new Error(`Unknown transition "${spec.type}"`);
    const ta = gl.upload(la.surface);
    const tb = gl.upload(lb.surface);
    const fc = { gl, frame: d.frame, assets: r.assets, scale: r.scale };
    const img = gl.outputPass(impl.frag, { uTex: ta, uTo: tb, uProgress: p, ...(impl.uniforms?.(spec.params, fc) ?? {}) });
    d.ctx.save();
    d.ctx.setTransform(1, 0, 0, 1, 0, 0);
    d.ctx.drawImage(img, 0, 0);
    d.ctx.restore();
    img.close?.();
    [ta, tb].forEach((x) => gl.release(x));
    r.releaseLayer(la.surface);
    r.releaseLayer(lb.surface);
  },
  { drawsChildren: true },
);
