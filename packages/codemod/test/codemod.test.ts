import { describe, expect, it } from 'vitest';
import { applyEdit, CodemodError, readProp, valueToCode } from '../src';

const SRC = `import { composition, rect, text, keys } from 'tasweerix';

// A comment that must survive
export default composition({ width: 1280, height: 720 }, (c) => {
  c.add(rect({ size: [200, 100], fill: '#ff0055', at: [640, 360] }));
  c.add(text('Hello',   { size: 64 }));   // weird spacing kept
  c.add(rect({ opacity: keys([[0, 0], ['1s', 1, 'outCubic']]) }));
  const pos = [10, 20];
  c.add(rect({ at: pos }));
});
`;

const lineCol = (needle: string, nth = 0) => {
  const lines = SRC.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    let idx = -1;
    while ((idx = lines[i]!.indexOf(needle, idx + 1)) >= 0) {
      if (count++ === nth) return { line: i + 1, column: idx };
    }
  }
  throw new Error('not found');
};

describe('codemod', () => {
  it('updates an existing literal prop and preserves formatting elsewhere', () => {
    const out = applyEdit(SRC, { kind: 'set-prop', ...lineCol('rect('), key: 'at', aliases: ['position'], value: [700.123456, 300] });
    expect(out).toContain("at: [700.123, 300]");
    expect(out).toContain('// A comment that must survive');
    expect(out).toContain("c.add(text('Hello',   { size: 64 }));   // weird spacing kept");
  });
  it('inserts a missing prop', () => {
    const out = applyEdit(SRC, { kind: 'set-prop', ...lineCol('text('), key: 'at', value: [100, 200] });
    expect(out).toMatch(/text\('Hello',\s+\{\s*size: 64,\s*at: \[100, 200\]\s*\}\)/);
  });
  it('edits keyframes inside keys([...])', () => {
    const out = applyEdit(SRC, { kind: 'set-key', ...lineCol('keys('), key: 1, field: 0, value: '1.5s' });
    expect(out).toContain("['1.5s', 1, 'outCubic']");
    const out2 = applyEdit(SRC, { kind: 'set-key', ...lineCol('keys('), key: 0, field: 1, value: 0.25 });
    expect(out2).toContain('[[0, 0.25]');
  });
  it('refuses to overwrite computed values', () => {
    expect(() => applyEdit(SRC, { kind: 'set-prop', ...lineCol('rect(', 2), key: 'at', value: [1, 2] })).toThrow(CodemodError);
    expect(readProp(SRC, lineCol('rect(', 2).line, lineCol('rect(', 2).column, 'at')).toEqual({ present: true, computed: true });
    expect(readProp(SRC, lineCol('rect(').line, lineCol('rect(').column, 'fill').value).toBe('#ff0055');
  });
  it('serializes values', () => {
    expect(valueToCode({ a: 1, 'b-c': [true, null, "it's"] })).toBe("{ a: 1, 'b-c': [true, null, 'it\\'s'] }");
  });
});
