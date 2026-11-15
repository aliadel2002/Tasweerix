import { useRef, useState } from 'preact/hooks';
import type { Inspection } from './api';
import { Icon } from './icons';
import { useT, type Strings } from './i18n';

export interface InspectorProps {
  data: Inspection | null;
  onEdit(key: string, value: unknown): void;
  onReveal(): void;
  message?: string;
}

const HIDDEN = new Set(['visible', 'features', 'variations', 'crop', 'smoothing', 'miterLimit', 'strokeFirst', 'fillRule', 'motionBlur']);

/** Which section a property belongs to. Anything not listed is the element's own content. */
const TRANSFORM = ['position', 'anchor', 'scale', 'rotation', 'skew'];
const APPEARANCE = ['opacity', 'blend', 'fill', 'stroke', 'strokeWidth', 'radius', 'shadow', 'color'];
/** Unit shown after a value, and how much one pixel of label drag changes it. */
const UNIT: Record<string, string> = { start: 's', duration: 's', rotation: '°', position: 'px', anchor: 'px', size: 'px', radius: 'px', strokeWidth: 'px' };
const STEP: Record<string, number> = { opacity: 0.01, scale: 0.01, start: 0.05, duration: 0.05, volume: 0.01, skew: 0.5, rotation: 0.5 };

/** Shows evaluated props at the playhead in sections; literal props are editable and written back to code. */
export function Inspector({ data, onEdit, onReveal, message }: InspectorProps) {
  const t = useT();
  if (!data) return <div class="inspector empty">{t.selectHint}</div>;
  const entries = Object.entries(data.props).filter(([k]) => !HIDDEN.has(k));
  const pick = (keys: string[]) => keys.flatMap((k) => entries.filter(([e]) => e === k));
  const groups: [string, [string, unknown][]][] = [
    [t.transform, pick(TRANSFORM)],
    [t.appearance, pick(APPEARANCE)],
    [t.content, entries.filter(([k]) => !TRANSFORM.includes(k) && !APPEARANCE.includes(k))],
  ];
  return (
    <div class="inspector">
      <div class="insp-head">
        <span class={`kind k-${data.kind}`} />
        <b dir="auto">{data.name ?? data.kind}</b>
        <span class="muted" dir="ltr">{data.id}</span>
        <button class="link" onClick={onReveal} title={t.showInCode} aria-label={t.showInCode}>
          <Icon name="code" />
        </button>
      </div>
      {message && (
        <div class="insp-msg" role="status">
          {message}
        </div>
      )}
      <Section title={t.timing}>
        <Row k="start" value={data.start} animated={false} t={t} onCommit={(v) => onEdit('start', v)} />
        {data.duration === null ? (
          [<label>duration</label>, <span class="muted">{t.open}</span>]
        ) : (
          <Row k="duration" value={data.duration} animated={false} t={t} onCommit={(v) => onEdit('duration', v)} />
        )}
      </Section>
      {groups.map(
        ([title, list]) =>
          list.length > 0 && (
            <Section title={title}>
              {list.map(([k, v]) => (
                // 2D nodes take `at`; 3D objects (Vec3 position) take `position`.
                <Row k={k} value={v} animated={data.animated.includes(k)} t={t} onCommit={(nv) => onEdit(k === 'position' && !(Array.isArray(v) && v.length === 3) ? 'at' : k, nv)} />
              ))}
            </Section>
          ),
      )}
      {data.filters.length > 0 && (
        <Section title={t.filters}>
          <div class="insp-filters" dir="ltr">
            {data.filters.map((f) => (
              <span class="chip">{f}</span>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <section class="insp-section">
      <h3>{title}</h3>
      <div class="insp-grid">{children}</div>
    </section>
  );
}

/** A label and its field. Dragging the label of a number scrubs the value. */
function Row({ k, value, animated, t, onCommit }: { k: string; value: unknown; animated: boolean; t: Strings; onCommit(v: unknown): void }) {
  const scrub = typeof value === 'number' && !animated;
  const drag = useRef<{ x: number; v: number } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const step = STEP[k] ?? 1;
  const at = (e: PointerEvent) => +(drag.current!.v + Math.round(e.clientX - drag.current!.x) * step * (e.shiftKey ? 10 : 1)).toFixed(3);
  return (
    <>
      <label
        class={`${animated ? 'anim' : ''} ${scrub ? 'scrub' : ''}`}
        title={animated ? t.inCode : ''}
        dir="ltr"
        onPointerDown={
          scrub
            ? (e) => {
                drag.current = { x: e.clientX, v: value as number };
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              }
            : undefined
        }
        onPointerMove={(e) => drag.current && setPreview(at(e))}
        onPointerUp={(e) => {
          if (!drag.current) return;
          const v = at(e);
          const changed = v !== drag.current.v;
          drag.current = null;
          setPreview(null);
          if (changed) onCommit(v);
        }}
      >
        {k}
        {animated ? ' ◆' : ''}
      </label>
      <Field value={preview ?? value} readOnly={animated} unit={UNIT[k]} onCommit={onCommit} />
    </>
  );
}

function Field({ value, readOnly, unit, onCommit }: { value: unknown; readOnly: boolean; unit?: string; onCommit(v: unknown): void }) {
  if (typeof value === 'number') return <NumberField value={value} readOnly={readOnly} unit={unit} onCommit={onCommit} />;
  if (typeof value === 'boolean') return <input type="checkbox" checked={value} disabled={readOnly} onChange={(e) => onCommit((e.target as HTMLInputElement).checked)} />;
  if (Array.isArray(value) && value.length <= 4 && value.every((x) => typeof x === 'number'))
    return (
      <span class="vec" dir="ltr">
        {value.map((x, i) => (
          <NumberField value={x} readOnly={readOnly} unit={i === value.length - 1 ? unit : undefined} onCommit={(v) => onCommit(value.map((y, j) => (j === i ? v : y)))} />
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
  return (
    <span class="muted" title={JSON.stringify(value)}>
      {typeof value === 'object' && value && 'type' in value ? `${(value as { type: string }).type} gradient` : 'object'}
    </span>
  );
}

function NumberField({ value, readOnly, unit, onCommit }: { value: number; readOnly?: boolean; unit?: string; onCommit(v: number): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(+value.toFixed(3));
  const input = (
    <input
      class="num"
      dir="ltr"
      inputMode="decimal"
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
  return unit ? (
    <span class="unit-wrap" dir="ltr">
      {input}
      <span class="unit">{unit}</span>
    </span>
  ) : (
    input
  );
}

function TextField({ value, readOnly, onCommit }: { value: string; readOnly?: boolean; onCommit(v: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      class="txt"
      dir="auto"
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
