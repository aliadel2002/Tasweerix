import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { videoThumb, type AudioRow, type CompInfo, type PreviewApi, type TimelineRow } from './api';
import { Icon } from './icons';
import { useT } from './i18n';

/** A retime in seconds, relative to where the clip is now. `trimStart` moves the left edge and keeps the right one. */
export interface Retime {
  start?: number;
  duration?: number;
  trimStart?: number;
}

export interface TimelineProps {
  info: CompInfo;
  rows: TimelineRow[];
  audio: AudioRow[];
  time: number;
  selected: string | null;
  runtime: PreviewApi | null;
  onSeek(t: number): void;
  onSelect(id: string): void;
  onRetime(row: TimelineRow, change: Retime): void;
  onKeyMove(row: TimelineRow, prop: string, index: number, newGlobalTime: number): void;
}

const ROW_H = 26;
const LABEL_W = 170;
const SNAP_PX = 7;

type Drag = { kind: 'move' | 'trim' | 'trim-start' | 'key'; row: TimelineRow; x0: number; dt: number; snapped: number | null; prop?: string; index?: number; t0?: number };

/** Timeline: one track per node, clip bars with thumbnails, keyframes, audio waveforms, markers and a playhead. */
export function Timeline(p: TimelineProps) {
  const t = useT();
  const [pxPerSec, setPx] = useState(80);
  const [snapOn, setSnapOn] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const width = Math.max(600, p.info.duration * pxPerSec + 80);
  const t2x = (s: number) => s * pxPerSec;
  const fps = p.info.fps;

  // Rows under a collapsed group are hidden.
  const rows = useMemo(() => {
    const byId = new Map(p.rows.map((r) => [r.id, r]));
    return p.rows.filter((r) => {
      for (let a = r.parent; a; a = byId.get(a)?.parent) if (collapsed.has(a)) return false;
      return true;
    });
  }, [p.rows, collapsed]);

  // Latest values for the drag listeners, which are attached once per drag.
  const live = useRef({ p, pxPerSec, snapOn });
  live.current = { p, pxPerSec, snapOn };

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) =>
      setDrag((d) => {
        if (!d) return d;
        const { p: cur, pxPerSec: pps, snapOn: on } = live.current;
        const raw = (e.clientX - d.x0) / pps;
        // Edges of the dragged thing, as times: these are what can snap.
        const edges = d.kind === 'key' ? [d.t0!] : d.kind === 'trim' ? [d.row.end] : d.kind === 'trim-start' ? [d.row.start] : [d.row.start, d.row.end];
        let dt = snapFrame(raw, cur.info.fps);
        let snapped: number | null = null;
        if (on && !e.altKey) {
          const targets = [0, cur.info.duration, cur.time, ...cur.info.markers.map((m) => m.time), ...cur.rows.filter((r) => r.id !== d.row.id).flatMap((r) => [r.start, r.end])];
          let best = SNAP_PX / pps;
          for (const edge of edges)
            for (const target of targets) {
              const off = Math.abs(edge + raw - target);
              if (off < best) {
                best = off;
                dt = target - edge;
                snapped = target;
              }
            }
        }
        // A clip keeps at least one frame; a clamp that overrides the snap also hides its guide.
        const len = d.row.end - d.row.start;
        const wanted = dt;
        if (d.kind === 'trim') dt = Math.max(dt, 1 / cur.info.fps - len);
        if (d.kind === 'trim-start') dt = Math.min(dt, len - 1 / cur.info.fps);
        return { ...d, dt, snapped: dt === wanted ? snapped : null };
      });
    const up = () => {
      setDrag((d) => {
        if (d && Math.abs(d.dt) > 1e-6) {
          const cur = live.current.p;
          if (d.kind === 'move') cur.onRetime(d.row, { start: d.dt });
          else if (d.kind === 'trim') cur.onRetime(d.row, { duration: d.dt });
          else if (d.kind === 'trim-start') cur.onRetime(d.row, { trimStart: d.dt });
          else if (d.kind === 'key') cur.onKeyMove(d.row, d.prop!, d.index!, d.t0! + d.dt);
        }
        return null;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag?.kind, drag?.row.id, drag?.prop, drag?.index]);

  const seekFromEvent = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - r.left - LABEL_W;
    p.onSeek(Math.max(0, Math.min(p.info.duration, x / pxPerSec)));
  };

  const fit = () => {
    const w = (scroller.current?.clientWidth ?? 800) - LABEL_W - 24;
    setPx(Math.max(10, Math.min(400, Math.floor(w / Math.max(0.1, p.info.duration)))));
  };

  const ticks: number[] = [];
  const step = pxPerSec > 160 ? 0.5 : pxPerSec > 60 ? 1 : pxPerSec > 25 ? 2 : 5;
  for (let s = 0; s <= p.info.duration + 1e-9; s += step) ticks.push(s);

  // Arrow keys on a focused clip or keyframe move it by a frame (ten with Shift).
  const nudge = (e: KeyboardEvent, apply: (dt: number) => void) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    apply(((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1)) / fps);
  };

  return (
    <div class="timeline" dir="ltr">
      <div class="tl-toolbar">
        <span class="tl-title">{t.timeline}</span>
        <input type="range" min={10} max={400} value={pxPerSec} onInput={(e) => setPx(Number((e.target as HTMLInputElement).value))} title={t.zoom} aria-label={t.zoom} />
        <button class="tool" onClick={fit} title={t.fit} aria-label={t.fit}>
          <Icon name="fit" />
        </button>
        <button class={`tool ${snapOn ? 'on' : ''}`} onClick={() => setSnapOn((s) => !s)} title={t.snap} aria-label={t.snap} aria-pressed={snapOn}>
          <Icon name="magnet" />
        </button>
      </div>
      <div class="tl-scroll" ref={scroller}>
        <div class="tl-inner" style={{ width: `${width + LABEL_W}px` }}>
          <div class="tl-ruler" onPointerDown={(e) => seekFromEvent(e)} onPointerMove={(e) => e.buttons & 1 && seekFromEvent(e)}>
            <div class="tl-label" />
            {ticks.map((s) => (
              <span class="tl-tick" style={{ left: `${LABEL_W + t2x(s)}px` }}>
                {s.toFixed(step < 1 ? 1 : 0)}s
              </span>
            ))}
            {p.info.markers.map((m) => (
              <span class="tl-marker" title={m.label} style={{ left: `${LABEL_W + t2x(m.time)}px`, borderColor: m.color ?? '#facc15' }} />
            ))}
          </div>
          {rows.map((row) => {
            const isSel = row.id === p.selected;
            const d = drag && drag.row.id === row.id ? drag : null;
            const start = row.start + (d && (d.kind === 'move' || d.kind === 'trim-start') ? d.dt : 0);
            const end = row.end + (d && (d.kind === 'move' || d.kind === 'trim') ? d.dt : 0);
            const w = Math.max(2, t2x(end - start));
            const closed = collapsed.has(row.id);
            return (
              <div class={`tl-row ${isSel ? 'sel' : ''}`} style={{ height: `${ROW_H}px` }} onPointerDown={() => p.onSelect(row.id)}>
                <div class="tl-label" style={{ paddingLeft: `${6 + row.depth * 12}px` }} title={`${row.name} · ${row.kind}`}>
                  {row.group ? (
                    <button
                      class={`twisty ${closed ? '' : 'open'}`}
                      aria-expanded={!closed}
                      aria-label={`${closed ? t.expand : t.collapse} ${row.name}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() =>
                        setCollapsed((c) => {
                          const n = new Set(c);
                          if (!n.delete(row.id)) n.add(row.id);
                          return n;
                        })
                      }
                    >
                      <Icon name="chevron" size={12} />
                    </button>
                  ) : (
                    <span class="twisty-gap" />
                  )}
                  <span class={`kind k-${row.kind}`} />
                  <span class="tl-name" dir="auto">{row.name}</span>
                </div>
                <div
                  class={`tl-bar k-${row.kind}`}
                  style={{ left: `${LABEL_W + t2x(start)}px`, width: `${w}px` }}
                  tabIndex={0}
                  role="button"
                  aria-label={t.clip(row.name)}
                  onFocus={() => p.onSelect(row.id)}
                  onKeyDown={(e) => nudge(e, (dt) => p.onRetime(row, { start: dt }))}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    p.onSelect(row.id);
                    setDrag({ kind: 'move', row, x0: e.clientX, dt: 0, snapped: null });
                  }}
                >
                  {row.media && <Filmstrip media={row.media} width={w} height={ROW_H - 6} pxPerSec={pxPerSec} offset={d?.kind === 'trim-start' ? d.dt : 0} />}
                  <div
                    class="tl-trim start"
                    title={t.trimStart}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      p.onSelect(row.id);
                      setDrag({ kind: 'trim-start', row, x0: e.clientX, dt: 0, snapped: null });
                    }}
                  />
                  <div
                    class="tl-trim end"
                    title={t.trimEnd}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      p.onSelect(row.id);
                      setDrag({ kind: 'trim', row, x0: e.clientX, dt: 0, snapped: null });
                    }}
                  />
                </div>
                {row.keyframes.flatMap((k) =>
                  k.times.map((kt, i) => {
                    const active = drag?.kind === 'key' && drag.row.id === row.id && drag.prop === k.prop && drag.index === i;
                    return (
                      <span
                        class="tl-key"
                        title={`${k.prop} @ ${kt.toFixed(2)}s`}
                        tabIndex={0}
                        role="button"
                        aria-label={t.keyframe(k.prop, kt.toFixed(2))}
                        style={{ left: `${LABEL_W + t2x(kt + (active ? drag!.dt : 0))}px` }}
                        onKeyDown={(e) => nudge(e, (dt) => p.onKeyMove(row, k.prop, i, kt + dt))}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          p.onSelect(row.id);
                          setDrag({ kind: 'key', row, x0: e.clientX, dt: 0, snapped: null, prop: k.prop, index: i, t0: kt });
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
              <div class="tl-label" title={a.name}>
                <span class="twisty-gap" />
                <span class="kind k-audio" />
                <span class="tl-name">{a.name.split('/').pop()}</span>
              </div>
              <div class="tl-bar k-audio" style={{ left: `${LABEL_W + t2x(a.start)}px`, width: `${Math.max(2, t2x(a.end - a.start))}px` }}>
                {a.src && p.runtime && <Waveform runtime={p.runtime} src={a.src} width={Math.max(2, t2x(a.end - a.start))} height={ROW_H * 1.5 - 6} />}
              </div>
            </div>
          ))}
          {drag?.snapped != null && <div class="tl-snap" style={{ left: `${LABEL_W + t2x(drag.snapped)}px` }} />}
          <div class="tl-playhead" style={{ left: `${LABEL_W + t2x(p.time)}px` }} />
        </div>
      </div>
    </div>
  );
}

function snapFrame(dt: number, fps: number): number {
  return Math.round(dt * fps) / fps;
}

// ---------------------------------------------------------------- thumbnails

const thumbCache = new Map<string, Promise<ImageBitmap | null>>();
let thumbQueue: Promise<unknown> = Promise.resolve();
/** One request at a time: thumbnails share a decoder and should never crowd out the preview. */
function thumb(src: string, time: number, height: number): Promise<ImageBitmap | null> {
  const key = `${src}|${time.toFixed(1)}|${height}`;
  let p = thumbCache.get(key);
  if (!p) {
    p = thumbQueue.then(() => videoThumb(src, time, height)).catch(() => null);
    thumbQueue = p;
    thumbCache.set(key, p);
  }
  return p;
}

/** Frames of a video clip along its bar, or the picture itself for an image. */
function Filmstrip({ media, width, height, pxPerSec, offset }: { media: NonNullable<TimelineRow['media']>; width: number; height: number; pxPerSec: number; offset: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (media.kind !== 'video') return;
    const c = ref.current;
    if (!c) return;
    let stale = false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const h = Math.round(height * dpr);
    // Wait for the zoom or drag to settle before asking for frames.
    const timer = setTimeout(async () => {
      const first = await thumb(media.src, Math.max(0, media.in + offset * media.speed), h);
      if (stale || !first) return;
      const tileW = (first.width / first.height) * height;
      const n = Math.min(24, Math.max(1, Math.ceil(width / tileW)));
      c.width = Math.round(width * dpr);
      c.height = h;
      const ctx = c.getContext('2d')!;
      for (let i = 0; i < n; i++) {
        const bmp = i === 0 ? first : await thumb(media.src, Math.max(0, media.in + (offset + (i * tileW) / pxPerSec) * media.speed), h);
        if (stale) return;
        if (bmp) ctx.drawImage(bmp, Math.round(i * tileW * dpr), 0, Math.ceil(tileW * dpr), h);
      }
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [media.src, media.in, media.speed, Math.round(width), height, pxPerSec, offset]);
  if (media.kind === 'image') return <div class="tl-film" style={{ backgroundImage: `url("/project/${encodeURI(media.src)}")` }} />;
  return <canvas ref={ref} class="tl-film" />;
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
