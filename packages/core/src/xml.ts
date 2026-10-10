/** Minimal XML parser (SVG, FCPXML, xmeml): elements, attributes, text, CDATA; ignores comments/PIs/doctype. */
export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e] ?? m),
  );

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) stack[stack.length - 1]!.text += decode(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      i = src.indexOf('-->', lt) + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      stack[stack.length - 1]!.text += src.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (src[lt + 1] === '?' || src[lt + 1] === '!') {
      i = src.indexOf('>', lt) + 1;
      continue;
    }
    const gt = findTagEnd(src, lt);
    const body = src.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClose = body.endsWith('/');
    const m = /^([^\s/>]+)/.exec(body)!;
    const node: XmlNode = { tag: m[1]!, attrs: {}, children: [], text: '' };
    const attrRe = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(body.slice(m[1]!.length)))) node.attrs[a[1]!] = decode(a[3] ?? a[4] ?? '');
    stack[stack.length - 1]!.children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root.children.find((c) => c.tag !== '#text') ?? root;
}

function findTagEnd(s: string, from: number): number {
  let q: string | null = null;
  for (let i = from + 1; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>') return i;
  }
  return s.length - 1;
}
