import {
  CompNode,
  ellipsePath,
  flattenPath,
  group,
  GroupNode,
  image,
  mapPath,
  mat2d,
  parsePath,
  path,
  polygonPoints,
  rectPath,
  roundedPolygonPath,
  serializePath,
  smoothPolyline,
  starPoints,
  text,
  toCss,
  trimPolylines,
  type BaseProps,
  type Composition,
  type Env,
  type FrameContext,
  type Mat2D,
  type Paint,
  type PathData,
  type SceneNode,
  type Vec2,
} from '@tasweerix/core';
import { parseXml, type XmlNode } from './xml';

// ===================================================================== import

const num = (v: string | undefined, d = 0) => (v === undefined ? d : parseFloat(v));

function parseTransform(t: string | undefined): Mat2D {
  let m = mat2d.identity();
  if (!t) return m;
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(t))) {
    const a = r[2]!.split(/[\s,]+/).filter(Boolean).map(Number);
    let n: Mat2D;
    switch (r[1]) {
      case 'matrix':
        n = a as Mat2D;
        break;
      case 'translate':
        n = mat2d.translate(a[0] ?? 0, a[1] ?? 0);
        break;
      case 'scale':
        n = mat2d.scale(a[0] ?? 1, a[1] ?? a[0] ?? 1);
        break;
      case 'rotate': {
        const rad = ((a[0] ?? 0) * Math.PI) / 180;
        n = a.length > 2 ? mat2d.multiply(mat2d.multiply(mat2d.translate(a[1]!, a[2]!), mat2d.rotate(rad)), mat2d.translate(-a[1]!, -a[2]!)) : mat2d.rotate(rad);
        break;
      }
      case 'skewX':
        n = mat2d.skew(((a[0] ?? 0) * Math.PI) / 180, 0);
        break;
      case 'skewY':
        n = mat2d.skew(0, ((a[0] ?? 0) * Math.PI) / 180);
        break;
      default:
        n = mat2d.identity();
    }
    m = mat2d.multiply(m, n);
  }
  return m;
}

interface Style {
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  fillOpacity: number;
  strokeOpacity: number;
  lineCap: string;
  lineJoin: string;
  fillRule: string;
  fontSize: number;
  fontFamily: string;
  fontWeight: string;
  textAnchor: string;
  display: string;
}

const INHERIT: (keyof Style)[] = ['fill', 'stroke', 'strokeWidth', 'fillOpacity', 'strokeOpacity', 'lineCap', 'lineJoin', 'fillRule', 'fontSize', 'fontFamily', 'fontWeight', 'textAnchor'];
const ATTR: Record<string, keyof Style> = {
  fill: 'fill', stroke: 'stroke', 'stroke-width': 'strokeWidth', opacity: 'opacity', 'fill-opacity': 'fillOpacity', 'stroke-opacity': 'strokeOpacity',
  'stroke-linecap': 'lineCap', 'stroke-linejoin': 'lineJoin', 'fill-rule': 'fillRule', 'font-size': 'fontSize', 'font-family': 'fontFamily',
  'font-weight': 'fontWeight', 'text-anchor': 'textAnchor', display: 'display',
};

function styleOf(el: XmlNode, parent: Style): Style {
  const s: Style = { ...parent, opacity: 1, display: 'inline' };
  for (const k of INHERIT) s[k] = parent[k] as never;
  const set = (k: string, v: string) => {
    const key = ATTR[k.trim()];
    if (!key) return;
    const val = v.trim();
    (s as unknown as Record<string, unknown>)[key] = ['strokeWidth', 'opacity', 'fillOpacity', 'strokeOpacity', 'fontSize'].includes(key) ? parseFloat(val) : val;
  };
  for (const [k, v] of Object.entries(el.attrs)) set(k, v);
  for (const decl of (el.attrs.style ?? '').split(';')) {
    const [k, v] = decl.split(':');
    if (k && v) set(k, v);
  }
  return s;
}

const DEFAULT_STYLE: Style = { fill: '#000', stroke: 'none', strokeWidth: 1, opacity: 1, fillOpacity: 1, strokeOpacity: 1, lineCap: 'butt', lineJoin: 'miter', fillRule: 'nonzero', fontSize: 16, fontFamily: 'sans-serif', fontWeight: '400', textAnchor: 'start', display: 'inline' };

function shapeD(el: XmlNode): string | null {
  const a = el.attrs;
  switch (el.tag) {
    case 'path':
      return a.d ?? null;
    case 'rect': {
      const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height);
      const rx = Math.min(num(a.rx, num(a.ry)), w / 2);
      return serializePath(mapPath(rectPath(w, h, rx), ([px, py]) => [px + x + w / 2, py + y + h / 2]));
    }
    case 'circle': {
      const r = num(a.r);
      return serializePath(mapPath(ellipsePath(2 * r, 2 * r), ([px, py]) => [px + num(a.cx), py + num(a.cy)]));
    }
    case 'ellipse':
      return serializePath(mapPath(ellipsePath(2 * num(a.rx), 2 * num(a.ry)), ([px, py]) => [px + num(a.cx), py + num(a.cy)]));
    case 'line':
      return `M${num(a.x1)} ${num(a.y1)}L${num(a.x2)} ${num(a.y2)}`;
    case 'polyline':
    case 'polygon': {
      const n = (a.points ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
      let d = '';
      for (let i = 0; i + 1 < n.length; i += 2) d += `${i ? 'L' : 'M'}${n[i]} ${n[i + 1]}`;
      return el.tag === 'polygon' ? `${d}Z` : d;
    }
  }
  return null;
}

interface Ctx {
  defs: Map<string, XmlNode>;
}

function paintOf(v: string, opacity: number, ctx: Ctx, bbox: () => { x: number; y: number; width: number; height: number }, m: Mat2D): Paint {
  if (!v || v === 'none' || v === 'transparent') return null;
  const ref = /url\(#([^)]+)\)/.exec(v);
  if (ref) {
    const g = ctx.defs.get(ref[1]!);
    if (!g) return null;
    const stops: [number, string][] = g.children
      .filter((c) => c.tag === 'stop')
      .map((s) => {
        const st = styleOf(s, DEFAULT_STYLE);
        const color = s.attrs['stop-color'] ?? /stop-color:\s*([^;]+)/.exec(s.attrs.style ?? '')?.[1] ?? '#000';
        const op = num(s.attrs['stop-opacity'] ?? /stop-opacity:\s*([^;]+)/.exec(s.attrs.style ?? '')?.[1], 1) * opacity * st.opacity;
        const off = (s.attrs.offset ?? '0').endsWith('%') ? parseFloat(s.attrs.offset!) / 100 : num(s.attrs.offset);
        return [off, toCss(withOpacity(color, op))];
      });
    const userSpace = g.attrs.gradientUnits === 'userSpaceOnUse';
    const b = userSpace ? { x: 0, y: 0, width: 1, height: 1 } : bbox();
    const P = (x: number, y: number): Vec2 => mat2d.apply(m, userSpace ? [x, y] : [b.x + x * b.width, b.y + y * b.height]);
    const pct = (s: string | undefined, d: number) => (s === undefined ? d : s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s));
    if (g.tag === 'linearGradient')
      return { type: 'linear', from: P(pct(g.attrs.x1, 0), pct(g.attrs.y1, 0)), to: P(pct(g.attrs.x2, 1), pct(g.attrs.y2, 0)), stops };
    const c = P(pct(g.attrs.cx, 0.5), pct(g.attrs.cy, 0.5));
    const r = pct(g.attrs.r, 0.5) * (userSpace ? 1 : Math.max(b.width, b.height)) * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    return { type: 'radial', center: c, radius: r, stops };
  }
  return opacity < 1 ? toCss(withOpacity(v, opacity)) : v;
}

function withOpacity(c: string, o: number): [number, number, number, number] {
  const m = /^#([0-9a-f]{3,8})$/i.exec(c.trim());
  let rgb: [number, number, number, number] = [0, 0, 0, 1];
  if (m) {
    const h = m[1]!.length <= 4 ? m[1]!.split('').map((x) => x + x).join('') : m[1]!;
    rgb = [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  } else {
    const named: Record<string, [number, number, number]> = { black: [0, 0, 0], white: [1, 1, 1], red: [1, 0, 0], green: [0, 0.5, 0], blue: [0, 0, 1] };
    const n = named[c.trim().toLowerCase()];
    if (n) rgb = [...n, 1];
    else {
      const r = /rgba?\(([^)]+)\)/.exec(c);
      if (r) {
        const p = r[1]!.split(/[\s,]+/).map(Number);
        rgb = [p[0]! / 255, p[1]! / 255, p[2]! / 255, p[3] ?? 1];
      }
    }
  }
  return [rgb[0], rgb[1], rgb[2], rgb[3] * o];
}

/** Converts SVG markup into Tasweerix scene nodes (geometry baked into absolute paths). */
export function importSVG(markup: string, opts: { center?: boolean } = {}): GroupNode & { svgSize: Vec2 } {
  const root = parseXml(markup);
  const vb = (root.attrs.viewBox ?? '').split(/[\s,]+/).map(Number);
  const width = vb.length === 4 ? vb[2]! : num(root.attrs.width, 100);
  const height = vb.length === 4 ? vb[3]! : num(root.attrs.height, 100);
  const ctx: Ctx = { defs: new Map() };
  const collectDefs = (el: XmlNode) => {
    if (el.attrs.id) ctx.defs.set(el.attrs.id, el);
    el.children.forEach(collectDefs);
  };
  collectDefs(root);
  const base = vb.length === 4 ? mat2d.translate(-vb[0]!, -vb[1]!) : mat2d.identity();
  const out = group({ name: root.attrs.id ?? 'svg' }) as GroupNode & { svgSize: Vec2 };
  out.svgSize = [width, height];
  if (opts.center !== false) out.set({ anchor: [width / 2, height / 2] });
  else out.set({ position: [0, 0] });
  const walk = (el: XmlNode, parentStyle: Style, m: Mat2D, into: GroupNode) => {
    if (['defs', 'linearGradient', 'radialGradient', 'clipPath', 'mask', 'symbol', 'title', 'desc', 'metadata', 'style'].includes(el.tag)) return;
    const st = styleOf(el, parentStyle);
    if (st.display === 'none') return;
    const mm = mat2d.multiply(m, parseTransform(el.attrs.transform));
    if (el.tag === 'g' || el.tag === 'svg' || el.tag === 'a') {
      const g = group({ name: el.attrs.id });
      g.set({ position: [0, 0], opacity: st.opacity });
      el.children.forEach((c) => walk(c, st, mm, g));
      if (g.children.length) into.add(g);
      return;
    }
    const d = shapeD(el);
    if (d) {
      const pd = mapPath(parsePath(d), (p) => mat2d.apply(mm, p));
      const scale = Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2]));
      const raw = parsePath(d);
      const bbox = () => {
        const pts = flattenPath(raw, 1).flatMap((s) => s.points);
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      };
      const node = path(serializePath(pd), {
        name: el.attrs.id,
        position: [0, 0],
        fill: el.tag === 'line' ? null : paintOf(st.fill, st.fillOpacity, ctx, bbox, mm),
        stroke: paintOf(st.stroke, st.strokeOpacity, ctx, bbox, mm),
        strokeWidth: st.stroke && st.stroke !== 'none' ? st.strokeWidth * scale : 0,
        lineCap: st.lineCap as never,
        lineJoin: st.lineJoin as never,
        fillRule: st.fillRule as never,
        opacity: st.opacity,
      });
      into.add(node);
      return;
    }
    if (el.tag === 'text') {
      const p = mat2d.apply(mm, [num(el.attrs.x), num(el.attrs.y)]);
      const content = (el.text + el.children.map((c) => c.text).join('')).trim();
      if (content)
        into.add(
          text(content, {
            position: p,
            size: st.fontSize * Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2])),
            font: st.fontFamily.replace(/["']/g, '').split(',')[0]!.trim(),
            weight: st.fontWeight as never,
            fill: paintOf(st.fill, st.fillOpacity, ctx, () => ({ x: 0, y: 0, width: 1, height: 1 }), mm),
            align: st.textAnchor === 'middle' ? 'center' : st.textAnchor === 'end' ? 'right' : 'left',
            baseline: 'alphabetic',
            opacity: st.opacity,
          }),
        );
      return;
    }
    if (el.tag === 'image') {
      const href = el.attrs.href ?? el.attrs['xlink:href'];
      if (href) {
        const w = num(el.attrs.width);
        const h = num(el.attrs.height);
        const c = mat2d.apply(mm, [num(el.attrs.x) + w / 2, num(el.attrs.y) + h / 2]);
        into.add(image(href, { position: c, size: [w, h], fit: 'fill', opacity: st.opacity }));
      }
    }
  };
  root.children.forEach((c) => walk(c, styleOf(root, DEFAULT_STYLE), base, out));
  return out;
}

/** An SVG file loaded during prepare (works in browsers and Node). */
export class SvgFileNode extends GroupNode {
  constructor(readonly src: string, readonly opts: { center?: boolean } = {}) {
    super('group', {}, { name: src });
  }
  override async prepare(env: Env): Promise<void> {
    if (!this.children.length) {
      if (!env.loadBinary) throw new Error('svgFile(): environment cannot load files');
      const markup = new TextDecoder().decode(await env.loadBinary(this.src));
      const g = importSVG(markup, this.opts);
      this.add(...g.children);
      if (this.props.anchor === undefined) this.set({ anchor: g.get('anchor') ?? [0, 0] });
      this.meta.svgSize = g.svgSize;
    }
    await super.prepare(env);
  }
}
export const svgFile = (src: string, opts?: { center?: boolean }) => new SvgFileNode(src, opts);

// ===================================================================== export

export interface SvgExportOptions {
  /** Converts a text node to path data (e.g. via HarfBuzz); return null to emit <text>. */
  textToPath?: (node: SceneNode, props: Record<string, any>) => string | null;
  /** Include the composition background. */
  background?: boolean;
  precision?: number;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Serializes one frame of a composition to SVG (vector nodes, text, images; filters omitted). */
export function toSVG(comp: Composition, frame = 0, opts: SvgExportOptions = {}): string {
  let uid = 0;
  const defs: string[] = [];
  const P = opts.precision ?? 2;
  const f = (n: number) => +n.toFixed(P);
  const paint = (p: Paint): string => {
    if (p === null || p === undefined) return 'none';
    if (typeof p === 'string') return p;
    if (Array.isArray(p)) return toCss(p as never);
    const id = `g${uid++}`;
    const stops = 'stops' in p ? p.stops.map(([o, c]) => `<stop offset="${f(o)}" stop-color="${esc(toCss(c))}"/>`).join('') : '';
    if (p.type === 'linear') defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(p.from[0])}" y1="${f(p.from[1])}" x2="${f(p.to[0])}" y2="${f(p.to[1])}">${stops}</linearGradient>`);
    else if (p.type === 'radial') defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${f(p.center[0])}" cy="${f(p.center[1])}" r="${f(p.radius)}">${stops}</radialGradient>`);
    else return '#888';
    return `url(#${id})`;
  };
  const styleAttrs = (pr: Record<string, any>, closed = true) => {
    const a: string[] = [];
    a.push(`fill="${closed ? esc(paint(pr.fill)) : 'none'}"`);
    if (pr.fillRule === 'evenodd') a.push('fill-rule="evenodd"');
    if (pr.strokeWidth > 0 && pr.stroke) {
      a.push(`stroke="${esc(paint(pr.stroke))}" stroke-width="${f(pr.strokeWidth)}"`);
      if (pr.lineCap !== 'butt') a.push(`stroke-linecap="${pr.lineCap}"`);
      if (pr.lineJoin !== 'miter') a.push(`stroke-linejoin="${pr.lineJoin}"`);
      if (pr.dash?.length) a.push(`stroke-dasharray="${pr.dash.join(' ')}" stroke-dashoffset="${pr.dashOffset}"`);
    }
    return a.join(' ');
  };
  const geom = (n: SceneNode, pr: Record<string, any>): PathData | null => {
    switch (n.kind) {
      case 'rect':
        return rectPath(pr.size[0], pr.size[1], pr.radius);
      case 'ellipse':
        return ellipsePath(pr.size[0], pr.size[1], pr.startAngle, pr.endAngle, Math.abs(pr.endAngle - pr.startAngle) >= 360 || (pr.fill !== null && pr.fill !== undefined));
      case 'polygon':
        return roundedPolygonPath(polygonPoints(pr.sides, pr.radius), pr.cornerRadius);
      case 'star':
        return roundedPolygonPath(starPoints(pr.points, pr.outerRadius, pr.innerRadius), pr.cornerRadius);
      case 'path':
        return parsePath(pr.d);
      case 'polyline':
        return smoothPolyline(pr.points, pr.closed, pr.smooth);
      case 'solid': {
        const size = pr.size ?? [comp.width, comp.height];
        return rectPath(size[0], size[1]);
      }
    }
    return null;
  };

  const emit = (n: SceneNode, parentCtx: FrameContext, depth: number): string => {
    if (!n.activeAt(parentCtx.time)) return '';
    const local = n.localCtx(parentCtx);
    const pr = n.evaluate(local) as Record<string, any> & BaseProps;
    if (!pr.visible || pr.opacity <= 0) return '';
    let pos = pr.position;
    if ((n.props as Partial<BaseProps>).position === undefined && n.parent?.meta.isRoot) pos = [comp.width / 2, comp.height / 2];
    const sc: Vec2 = typeof pr.scale === 'number' ? [pr.scale, pr.scale] : pr.scale;
    const m = mat2d.compose(pos, sc, pr.rotation, pr.anchor, pr.skew);
    const tr = `transform="matrix(${m.map(f).join(' ')})"`;
    const op = pr.opacity < 1 ? ` opacity="${f(pr.opacity)}"` : '';
    const pad = '  '.repeat(depth);
    let inner = '';
    const g = geom(n, pr);
    if (g) {
      const trimmed = (pr.trimStart ?? 0) !== 0 || (pr.trimEnd ?? 1) !== 1;
      if (trimmed) {
        const polys = trimPolylines(flattenPath(g, 0.3), pr.trimStart, pr.trimEnd, pr.trimOffset);
        const d = polys.map((poly) => poly.map((p, i) => `${i ? 'L' : 'M'}${f(p[0])} ${f(p[1])}`).join('')).join('');
        inner = `<path d="${d}" ${styleAttrs({ ...pr, fill: null }, false)}/>`;
      } else {
        const fill = n.kind === 'solid' ? pr.color : pr.fill;
        inner = `<path d="${serializePath(g)}" ${styleAttrs({ ...pr, fill }, n.kind !== 'polyline' || pr.closed)}/>`;
      }
    } else if (n.kind === 'text') {
      const d = opts.textToPath?.(n, pr);
      if (d) inner = `<path d="${d}" ${styleAttrs(pr)}/>`;
      else {
        const anchor = pr.align === 'center' ? 'middle' : pr.align === 'right' || pr.align === 'end' ? 'end' : 'start';
        const lines = String(pr.text).split('\n');
        const lh = pr.size * pr.lineHeight;
        const y0 = pr.baseline === 'middle' ? -((lines.length - 1) * lh) / 2 + pr.size * 0.35 : 0;
        inner = `<text font-family="${esc(pr.font)}" font-size="${f(pr.size)}" font-weight="${pr.weight}" text-anchor="${anchor}" ${styleAttrs(pr)}${pr.direction === 'rtl' ? ' direction="rtl"' : ''}>${lines.map((l, i) => `<tspan x="0" y="${f(y0 + i * lh)}">${esc(l)}</tspan>`).join('')}</text>`;
      }
    } else if (n.kind === 'image' || n.kind === 'photo') {
      const size = pr.size ?? [100, 100];
      inner = `<image href="${esc(pr.src)}" x="${f(-size[0] / 2)}" y="${f(-size[1] / 2)}" width="${f(size[0])}" height="${f(size[1])}" preserveAspectRatio="${pr.fit === 'cover' ? 'xMidYMid slice' : pr.fit === 'fill' ? 'none' : 'xMidYMid meet'}"/>`;
    } else if (n.kind === 'comp' && (n as CompNode).inner) {
      const cn = n as CompNode & { inner: Composition };
      const ic = cn.inner.contextAt(cn.contentTime(local) * cn.inner.fps);
      inner = `<g transform="translate(${f(-cn.inner.width / 2)} ${f(-cn.inner.height / 2)})">${cn.inner.root.children.map((c) => emit(c, ic, depth + 1)).join('')}</g>`;
    }
    const cctx = n.childCtx(local);
    const kids = n.children.map((c) => emit(c, cctx, depth + 1)).join('');
    let maskAttr = '';
    if (n.maskSpec) {
      const id = `m${uid++}`;
      const content = emit(n.maskSpec.node, local, 0);
      const type = n.maskSpec.mode.startsWith('luma') ? 'luminance' : 'alpha';
      defs.push(`<mask id="${id}" mask-type="${type}" style="mask-type:${type}">${content}</mask>`);
      maskAttr = ` mask="url(#${id})"`;
    }
    const blend = pr.blend !== 'normal' ? ` style="mix-blend-mode:${pr.blend === 'add' ? 'plus-lighter' : pr.blend}"` : '';
    return `\n${pad}<g ${tr}${op}${blend}${n.name ? ` id="${esc(n.name)}"` : ''}>${inner}${maskAttr ? `<g${maskAttr}>${kids}</g>` : kids}</g>`;
  };

  const ctx = comp.contextAt(frame);
  const body = comp.root.children.map((c) => emit(c, ctx, 1)).join('');
  const bg = opts.background !== false && comp.background ? `\n  <rect width="${comp.width}" height="${comp.height}" fill="${esc(paint(comp.background))}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${comp.width}" height="${comp.height}" viewBox="0 0 ${comp.width} ${comp.height}">${defs.length ? `\n  <defs>${defs.join('')}</defs>` : ''}${bg}${body}\n</svg>\n`;
}
