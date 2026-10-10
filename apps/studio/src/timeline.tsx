import { useEffect, useRef, useState } from 'preact/hooks';
import type { AudioRow, CompInfo, PreviewApi, TimelineRow } from './api';

export interface TimelineProps {
  info: CompInfo;
  rows: TimelineRow[];
  audio: AudioRow[];
  time: number;
  selected: string | null;
  runtime: PreviewApi | null;
  onSeek(t: number): void;
  onSelect(id: string): void;
  /** Moves / trims a node: start & duration in parent-relative seconds deltas. */
  onRetime(row: TimelineRow, change: { start?: number; duration?: number }): void;
  onKeyMove(row: TimelineRow, prop: string, index: number, newGlobalTime: number): void;
}

const ROW_H = 24;
const LABEL_W = 150;

/** Timeline: one track per node, clip bars, keyframes, audio waveforms, markers and a playhead. */
export function Timeline(p: TimelineProps) {
  const [pxPerSec, setPx] = useState(80);
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<null | { kind: 'move' | 'trim' | 'key'; row: TimelineRow; x0: number; dt: number; prop?: string; index?: number; t0?: number }>(null);
  const width = Math.max(600, p.info.duration * pxPerSec + 80);
  const t2x = (t: number) => t * pxPerSec;

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => setDrag((d) => (d ? { ...d, dt: snap((e.clientX - d.x0) / pxPerSec, p.info.fps) } : d));
    const up = () => {
      setDrag((d) => {
        if (d && Math.abs(d.dt) > 1e-6) {
          if (d.kind === 'move') p.onRetime(d.row, { start: d.dt });
          else if (d.kind === 'trim') p.onRetime(d.row, { duration: d.dt });
          else if (d.kind === 'key') p.onKeyMove(d.row, d.prop!, d.index!, d.t0! + d.dt);
        }
        return null;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => window.removeEventListener('pointermove', move);
  }, [drag?.kind, drag?.row.id, pxPerSec]);

  const seekFromEvent = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - r.left + (scroller.current?.scrollLeft ?? 0) - LABEL_W;
    p.onSeek(Math.max(0, Math.min(p.info.duration, x / pxPerSec)));
  };

  const ticks: number[] = [];
  const step = pxPerSec > 160 ? 0.5 : pxPerSec > 60 ? 1 : pxPerSec > 25 ? 2 : 5;
  for (let t = 0; t <= p.info.duration + 1e-9; t += step) ticks.push(t);

  return (
    <div class="timeline">
      <div class="tl-toolbar">
        <span>Timeline</span>
        <input type="range" min={10} max={400} value={pxPerSec} onInput={(e) => setPx(Number((e.target as HTMLInputElement).value))} title="Zoom" />
      </div>
      <div class="tl-scroll" ref={scroller}>
        <div class="tl-inner" style={{ width: `${width + LABEL_W}px` }}>
          <div class="tl-ruler" onPointerDown={(e) => seekFromEvent(e)} onPointerMove={(e) => e.buttons & 1 && seekFromEvent(e)}>
            <div class="tl-label" />
            {ticks.map((t) => (
              <span class="tl-tick" style={{ left: `${LABEL_W + t2x(t)}px` }}>
                {t.toFixed(step < 1 ? 1 : 0)}s
              </span>
            ))}
            {p.info.markers.map((m) => (
              <span class="tl-marker" title={m.label} style={{ left: `${LABEL_W + t2x(m.time)}px`, borderColor: m.color ?? '#facc15' }} />
            ))}
          </div>
          {p.rows.map((row) => {
            const isSel = row.id === p.selected;
            const moving = drag && drag.row.id === row.id;
            const start = row.start + (moving && drag.kind === 'move' ? drag.dt : 0);
            const end = row.end + (moving ? drag.dt : 0);
            return (
              <div class={`tl-row ${isSel ? 'sel' : ''}`} style={{ height: `${ROW_H}px` }} onPointerDown={() => p.onSelect(row.id)}>
                <div class="tl-label" style={{ paddingLeft: `${8 + row.depth * 12}px` }} title={row.kind}>
                  <span class={`kind k-${row.kind}`} />
                  {row.name}
                </div>
                <div
                  class={`tl-bar k-${row.kind}`}
                  style={{ left: `${LABEL_W + t2x(start)}px`, width: `${Math.max(2, t2x(end - start))}px` }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    p.onSelect(row.id);
                    setDrag({ kind: 'move', row, x0: e.clientX, dt: 0 });
                  }}
                >
                  <div
                    class="tl-trim"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setDrag({ kind: 'trim', row, x0: e.clientX, dt: 0 });
                    }}
                  />
                </div>
                {row.keyframes.flatMap((k) =>
                  k.times.map((t, i) => {
                    const active = drag?.kind === 'key' && drag.row.id === row.id && drag.prop === k.prop && drag.index === i;
                    return (
                      <span
                        class="tl-key"
                        title={`${k.prop} @ ${t.toFixed(2)}s`}
                        style={{ left: `${LABEL_W + t2x(t + (active ? drag!.dt : 0))}px` }}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          p.onSelect(row.id);
                          setDrag({ kind: 'key', row, x0: e.clientX, dt: 0, prop: k.prop, index: i, t0: t });
                        }}
                      />
                    );
                  }),
                )}
              </div>
            );
          })}
          {p.audio.map((a) => (
            <div class="tl-row audio" style={{ height: `${ROW_H * 1.5}px` }}>
              <div class="tl-label">♪ {a.name.split('/').pop()}</div>
              <div class="tl-bar k-audio" style={{ left: `${LABEL_W + t2x(a.start)}px`, width: `${Math.max(2, t2x(a.end - a.start))}px` }}>
                {a.src && p.runtime && <Waveform runtime={p.runtime} src={a.src} width={Math.max(2, t2x(a.end - a.start))} height={ROW_H * 1.5 - 4} />}
              </div>
            </div>
          ))}
          <div class="tl-playhead" style={{ left: `${LABEL_W + t2x(p.time)}px` }} />
        </div>
      </div>
    </div>
  );
}

function snap(dt: number, fps: number): number {
  return Math.round(dt * fps) / fps;
}

const waveCache = new Map<string, Promise<{ min: number[]; max: number[] }>>();
function Waveform({ runtime, src, width, height }: { runtime: PreviewApi; src: string; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let p = waveCache.get(src);
    if (!p) {
      p = runtime.waveform(src, 1200);
      waveCache.set(src, p);
    }
    p.then((w) => {
      const c = ref.current;
      if (!c) return;
      c.width = Math.max(1, Math.round(width));
      c.height = Math.round(height);
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      const mid = c.height / 2;
      for (let x = 0; x < c.width; x++) {
        const i = Math.floor((x / c.width) * w.min.length);
        const lo = w.min[i] ?? 0;
        const hi = w.max[i] ?? 0;
        ctx.fillRect(x, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
      }
    }).catch(() => {});
  }, [src, width, height]);
  return <canvas ref={ref} class="tl-wave" />;
}
