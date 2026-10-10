import { useState } from 'preact/hooks';
import type { Inspection } from './api';

export interface InspectorProps {
  data: Inspection | null;
  onEdit(key: string, value: unknown): void;
  onReveal(): void;
  message?: string;
}

const HIDDEN = new Set(['visible', 'features', 'variations', 'crop', 'smoothing', 'miterLimit', 'strokeFirst', 'fillRule', 'motionBlur']);

/** Shows evaluated props at the playhead; literal props are editable and written back to code. */
export function Inspector({ data, onEdit, onReveal, message }: InspectorProps) {
  if (!data) return <div class="inspector empty">Select an element on the canvas or timeline.</div>;
  const entries = Object.entries(data.props).filter(([k]) => !HIDDEN.has(k));
  return (
    <div class="inspector">
      <div class="insp-head">
        <span class={`kind k-${data.kind}`} />
        <b>{data.name ?? data.kind}</b>
        <span class="muted">{data.id}</span>
        <button class="link" onClick={onReveal} title="Show in code">
          ⟶ code
        </button>
      </div>
      {message && <div class="insp-msg">{message}</div>}
      <div class="insp-grid">
        <label>start</label>
        <NumberField value={data.start} onCommit={(v) => onEdit('start', v)} />
        <label>duration</label>
        {data.duration === null ? <span class="muted">open</span> : <NumberField value={data.duration} onCommit={(v) => onEdit('duration', v)} />}
        {entries.map(([k, v]) => {
          const animated = data.animated.includes(k);
          return [
            <label class={animated ? 'anim' : ''} title={animated ? 'animated / computed in code' : ''}>
              {k}
              {animated ? ' ◆' : ''}
            </label>,
            // 2D nodes take `at`; 3D objects (Vec3 position) take `position`.
            <Field value={v} readOnly={animated} onCommit={(nv) => onEdit(k === 'position' && !(Array.isArray(v) && v.length === 3) ? 'at' : k, nv)} />,
          ];
        })}
        {data.filters.length > 0 && [<label>filters</label>, <span class="muted">{data.filters.join(', ')}</span>]}
      </div>
    </div>
  );
}

function Field({ value, readOnly, onCommit }: { value: unknown; readOnly: boolean; onCommit(v: unknown): void }) {
  if (typeof value === 'number') return <NumberField value={value} readOnly={readOnly} onCommit={onCommit} />;
  if (typeof value === 'boolean') return <input type="checkbox" checked={value} disabled={readOnly} onChange={(e) => onCommit((e.target as HTMLInputElement).checked)} />;
  if (Array.isArray(value) && value.length <= 4 && value.every((x) => typeof x === 'number'))
    return (
      <span class="vec">
        {value.map((x, i) => (
          <NumberField value={x} readOnly={readOnly} onCommit={(v) => onCommit(value.map((y, j) => (j === i ? v : y)))} />
        ))}
      </span>
    );
  if (typeof value === 'string') {
    const isColor = /^#([0-9a-f]{3,8})$/i.test(value);
    return (
      <span class="vec">
        {isColor && <input type="color" value={value.length === 7 ? value : '#ffffff'} disabled={readOnly} onChange={(e) => onCommit((e.target as HTMLInputElement).value)} />}
        <TextField value={value} readOnly={readOnly} onCommit={onCommit} />
      </span>
    );
  }
  if (value === null || value === undefined) return <span class="muted">—</span>;
  return <span class="muted" title={JSON.stringify(value)}>{typeof value === 'object' && value && 'type' in value ? `${(value as { type: string }).type} gradient` : 'object'}</span>;
}

function NumberField({ value, readOnly, onCommit }: { value: number; readOnly?: boolean; onCommit(v: number): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(+value.toFixed(3));
  return (
    <input
      class="num"
      value={shown}
      readOnly={readOnly}
      onFocus={() => setDraft(String(+value.toFixed(3)))}
      onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={() => {
        if (draft !== null && draft !== String(+value.toFixed(3)) && !isNaN(Number(draft))) onCommit(Number(draft));
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const d = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
          onCommit(+(value + d).toFixed(3));
        }
      }}
    />
  );
}

function TextField({ value, readOnly, onCommit }: { value: string; readOnly?: boolean; onCommit(v: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      class="txt"
      value={draft ?? value}
      readOnly={readOnly}
      onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}
