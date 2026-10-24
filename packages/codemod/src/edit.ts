import { parse as babelParse } from '@babel/parser';
import * as recast from 'recast';

type Node = recast.types.namedTypes.Node & { loc?: { start: { line: number; column: number }; end: { line: number; column: number } }; type: string; [k: string]: any };

/** A GUI edit addressed at a call site in source code (1-based line, 0-based column). */
export type Edit =
  /** Set/insert a property in the options object of the call: `rect({ at: [x, y] })`. */
  | { kind: 'set-prop'; line: number; column: number; key: string; value: unknown; aliases?: string[] }
  /** Replace the n-th argument of the call. */
  | { kind: 'set-arg'; line: number; column: number; index: number; value: unknown }
  /** Edit a keyframe inside `keys([...])` / `node.keys('prop', [...])`: field 0 = time, 1 = value. */
  | { kind: 'set-key'; line: number; column: number; key: number; field: 0 | 1; value: unknown }
  /** Remove a property from the options object. */
  | { kind: 'remove-prop'; line: number; column: number; key: string };

export class CodemodError extends Error {}

const parser = {
  parse(source: string) {
    return babelParse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], tokens: true, errorRecovery: false });
  },
};

export function parseSource(source: string): recast.types.ASTNode {
  return recast.parse(source, { parser });
}

/** Serializes a JS value to source code (numbers rounded sensibly). */
export function valueToCode(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(3));
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (typeof v === 'boolean' || v === null) return String(v);
  if (Array.isArray(v)) return `[${v.map(valueToCode).join(', ')}]`;
  if (typeof v === 'object' && v) return `{ ${Object.entries(v).map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : valueToCode(k)}: ${valueToCode(x)}`).join(', ')} }`;
  throw new CodemodError(`Cannot write value ${String(v)}`);
}

function exprFromCode(code: string): Node {
  const ast = recast.parse(`(${code});`, { parser }) as any;
  const expr = ast.program.body[0].expression as Node;
  // Drop the parentheses we added for parsing, and the original-source link so recast reprints it.
  if (expr.extra) delete expr.extra.parenthesized;
  recast.visit(expr, {
    visitNode(path) {
      const n = path.node as Node;
      if (n.extra && 'raw' in n.extra && n.type === 'StringLiteral') delete n.extra;
      this.traverse(path);
    },
  });
  return expr;
}

/** True when a node is a literal (or array/object/unary of literals) that GUI edits may overwrite. */
export function isLiteralLike(n: Node | null | undefined): boolean {
  if (!n) return false;
  switch (n.type) {
    case 'NumericLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
      return true;
    case 'TemplateLiteral':
      return n.expressions.length === 0;
    case 'UnaryExpression':
      return (n.operator === '-' || n.operator === '+') && isLiteralLike(n.argument);
    case 'ArrayExpression':
      return n.elements.every((e: Node | null) => isLiteralLike(e));
    case 'ObjectExpression':
      return n.properties.every((p: Node) => propKey(p) !== undefined && isLiteralLike(p.value));
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
      return isLiteralLike(n.expression);
  }
  return false;
}

function evalLiteral(n: Node): unknown {
  switch (n.type) {
    case 'NumericLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
      return n.value;
    case 'NullLiteral':
      return null;
    case 'TemplateLiteral':
      return n.quasis[0]?.value?.cooked ?? n.quasis[0]?.value?.raw ?? '';
    case 'UnaryExpression': {
      const v = Number(evalLiteral(n.argument));
      return n.operator === '-' ? -v : +v;
    }
    case 'ArrayExpression':
      return n.elements.map((e: Node) => evalLiteral(e));
    case 'ObjectExpression':
      return Object.fromEntries((n.properties as Node[]).map((p) => [propKey(p)!, evalLiteral(p.value)]));
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
      return evalLiteral(n.expression);
  }
  throw new CodemodError(`Unsupported literal node: ${n.type}`);
}

/** Finds the innermost call expression whose callee position matches (or encloses) line:column. */
function findCall(ast: recast.types.ASTNode, line: number, column: number): Node {
  let best: Node | null = null;
  let bestScore = Infinity;
  recast.visit(ast, {
    visitCallExpression(path) {
      const n = path.node as Node;
      const loc = n.loc;
      const callee = n.callee as Node;
      if (loc && callee.loc) {
        // V8 reports the column of the callee's property/identifier for calls.
        const target = callee.type === 'MemberExpression' ? (callee.property as Node).loc! : callee.loc;
        const exact = target.start.line === line && target.start.column === column;
        const inside = (loc.start.line < line || (loc.start.line === line && loc.start.column <= column)) && (loc.end.line > line || (loc.end.line === line && loc.end.column >= column));
        if (exact || inside) {
          const size = (loc.end.line - loc.start.line) * 10000 + (loc.end.column - loc.start.column);
          const score = exact ? -1 : size;
          if (score < bestScore) {
            bestScore = score;
            best = n;
          }
        }
      }
      this.traverse(path);
    },
    visitNewExpression(path) {
      this.traverse(path);
    },
  });
  if (!best) throw new CodemodError(`No call found at ${line}:${column}`);
  return best;
}

function propKey(p: Node): string | undefined {
  if (p.type !== 'ObjectProperty' || p.computed) return undefined;
  if (p.key.type === 'Identifier') return p.key.name;
  if (p.key.type === 'StringLiteral') return p.key.value;
  if (p.key.type === 'NumericLiteral') return String(p.key.value);
  return undefined;
}

/** Applies an edit and returns the new source (formatting elsewhere is preserved). */
export function applyEdit(source: string, edit: Edit): string {
  const ast = parseSource(source);
  const call = findCall(ast, edit.line, edit.column);
  const args = call.arguments as Node[];
  switch (edit.kind) {
    case 'set-prop':
    case 'remove-prop': {
      let obj = [...args].reverse().find((a) => a.type === 'ObjectExpression');
      const keysToMatch = edit.kind === 'set-prop' ? [edit.key, ...(edit.aliases ?? [])] : [edit.key];
      if (!obj) {
        if (edit.kind === 'remove-prop') return source;
        obj = exprFromCode('{}');
        args.push(obj);
      }
      const props = obj.properties as Node[];
      const idx = props.findIndex((p) => keysToMatch.includes(propKey(p) ?? ''));
      if (edit.kind === 'remove-prop') {
        if (idx >= 0) props.splice(idx, 1);
        break;
      }
      if (idx >= 0) {
        const p = props[idx]!;
        if (!isLiteralLike(p.value)) throw new CodemodError(`"${propKey(p)}" is computed in code; edit it in the editor`);
        p.value = exprFromCode(valueToCode(edit.value));
      } else {
        const tmp = exprFromCode(`{ ${edit.key}: ${valueToCode(edit.value)} }`);
        props.push(tmp.properties[0]);
      }
      break;
    }
    case 'set-arg': {
      const a = args[edit.index];
      if (a && !isLiteralLike(a)) throw new CodemodError(`Argument ${edit.index} is computed in code`);
      args[edit.index] = exprFromCode(valueToCode(edit.value));
      break;
    }
    case 'set-key': {
      const list = args.find((a) => a.type === 'ArrayExpression');
      if (!list) throw new CodemodError('Keyframes are not written as an array literal');
      const entry = list.elements[edit.key] as Node | undefined;
      if (!entry) throw new CodemodError(`Keyframe ${edit.key} not found`);
      if (entry.type === 'ArrayExpression') {
        const el = entry.elements[edit.field] as Node | undefined;
        if (el && !isLiteralLike(el)) throw new CodemodError('Keyframe is computed in code');
        entry.elements[edit.field] = exprFromCode(valueToCode(edit.value));
      } else if (entry.type === 'ObjectExpression') {
        const name = edit.field === 0 ? 't' : 'v';
        const p = (entry.properties as Node[]).find((x) => propKey(x) === name);
        if (!p) throw new CodemodError(`Keyframe has no "${name}"`);
        if (!isLiteralLike(p.value)) throw new CodemodError('Keyframe is computed in code');
        p.value = exprFromCode(valueToCode(edit.value));
      } else throw new CodemodError('Unsupported keyframe syntax');
      break;
    }
  }
  const singles = (source.match(/'/g) ?? []).length;
  const doubles = (source.match(/"/g) ?? []).length;
  return recast.print(ast, { quote: singles >= doubles ? 'single' : 'double' }).code;
}

/** Reads the literal value of an option (for the inspector), or undefined when computed. */
export function readProp(source: string, line: number, column: number, key: string): { value?: unknown; computed: boolean; present: boolean } {
  const call = findCall(parseSource(source), line, column);
  const obj = [...(call.arguments as Node[])].reverse().find((a) => a.type === 'ObjectExpression');
  const p = (obj?.properties as Node[] | undefined)?.find((x) => propKey(x) === key);
  if (!p) return { present: false, computed: false };
  if (!isLiteralLike(p.value)) return { present: true, computed: true };
  return { present: true, computed: false, value: evalLiteral(p.value) };
}
