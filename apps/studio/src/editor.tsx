import { useEffect, useRef } from 'preact/hooks';
import { Annotation, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';

export interface CodeEditorProps {
  /** File content from outside the editor (disk, a canvas edit, undo). Applied whenever `rev` changes. */
  value: string;
  /** Bumped by the owner each time `value` is new outside content. Typing never changes it. */
  rev: number;
  onChange(v: string): void;
  /** Undo and redo belong to the studio's one history, which also holds canvas, timeline and inspector edits. */
  onUndo(): void;
  onRedo(): void;
  label: string;
  /** Line to reveal & highlight (1-based). */
  reveal?: { line: number; nonce: number };
}

/** Marks a change the editor did not originate, so it is not reported back as typing. */
const external = Annotation.define<boolean>();

/**
 * CodeMirror 6 TypeScript editor. Typing is reported through `onChange`; outside content replaces only the
 * part of the document that differs, so the cursor and scroll position stay put.
 */
export function CodeEditor({ value, rev, onChange, onUndo, onRedo, label, reveal }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  const cb = useRef({ onChange, onUndo, onRedo });
  cb.current = { onChange, onUndo, onRedo };

  useEffect(() => {
    const run = (f: () => void) => () => (f(), true);
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          javascript({ typescript: true }),
          EditorView.lineWrapping,
          oneDark,
          keymap.of([
            { key: 'Mod-z', run: run(() => cb.current.onUndo()), preventDefault: true },
            { key: 'Mod-Shift-z', run: run(() => cb.current.onRedo()), preventDefault: true },
            { key: 'Mod-y', run: run(() => cb.current.onRedo()), preventDefault: true },
            ...defaultKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((t) => t.annotation(external))) cb.current.onChange(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12.5px' } }),
        ],
      }),
    });
    return () => view.current?.destroy();
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur === value) return;
    // Replace only the differing middle, which keeps the selection where it was.
    let a = 0;
    const max = Math.min(cur.length, value.length);
    while (a < max && cur.charCodeAt(a) === value.charCodeAt(a)) a++;
    let b = 0;
    while (b < max - a && cur.charCodeAt(cur.length - 1 - b) === value.charCodeAt(value.length - 1 - b)) b++;
    v.dispatch({ changes: { from: a, to: cur.length - b, insert: value.slice(a, value.length - b) }, annotations: external.of(true) });
  }, [rev]);

  useEffect(() => {
    const v = view.current;
    if (!v || !reveal) return;
    const line = v.state.doc.line(Math.min(Math.max(1, reveal.line), v.state.doc.lines));
    v.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
  }, [reveal?.nonce]);

  // Code stays left-to-right whatever the interface language is.
  return <div class="code" dir="ltr" ref={host} />;
}
