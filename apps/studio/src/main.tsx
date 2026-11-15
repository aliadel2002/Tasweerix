import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, loadRuntime, timecode, type StudioCommand, type CompInfo, type Inspection, type PreviewApi, type ServerState, type TimelineRow, type AudioRow } from './api';
import { CodeEditor } from './editor';
import { Inspector } from './inspector';
import { Timeline, type Retime } from './timeline';
import { Icon, Logo, fileIcon } from './icons';
import { I18n, LOCALES, initialLocale, saveLocale, type Locale } from './i18n';
import './styles.css';

type Vec2 = [number, number];
/** A file name as a single-quoted string literal: quotes, backslashes and line breaks in names must not end up as code. */
const lit = (s: string) => `'${s.replace(/[\\'\n\r\u2028\u2029]/g, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\\' || c === "'" ? `\\${c}` : `\\u${c.charCodeAt(0).toString(16)}`))}'`;
const ASSET_SNIPPET: Record<string, (p: string) => string> = {
  png: (p) => `image(${lit(p)})`,
  jpg: (p) => `image(${lit(p)})`,
  jpeg: (p) => `image(${lit(p)})`,
  webp: (p) => `image(${lit(p)})`,
  gif: (p) => `image(${lit(p)})`,
  svg: (p) => `svgFile(${lit(p)})`,
  mp4: (p) => `video(${lit(p)})`,
  mov: (p) => `video(${lit(p)})`,
  webm: (p) => `video(${lit(p)})`,
  mp3: (p) => `c.audio(${lit(p)})`,
  wav: (p) => `c.audio(${lit(p)})`,
  m4a: (p) => `c.audio(${lit(p)})`,
  ttf: (p) => `text('Hello', { font: ${lit(p)} })`,
  otf: (p) => `text('Hello', { font: ${lit(p)} })`,
  cube: (p) => `fx.lut(${lit(p)})`,
  srt: (p) => `captions(parseSubtitles(await (await fetch(${lit(`/project/${encodeURI(p)}`)})).text()))`,
};

/** Panel sizes the user can drag, remembered between visits. */
const SIZES_KEY = 'tasweerix.studio.panels';
const DEFAULT_SIZES = { files: 220, side: 420, foot: 260 };
function loadSizes(): typeof DEFAULT_SIZES {
  try {
    return { ...DEFAULT_SIZES, ...(JSON.parse(localStorage.getItem(SIZES_KEY) ?? '{}') as Partial<typeof DEFAULT_SIZES>) };
  } catch {
    return DEFAULT_SIZES;
  }
}

type Gesture = { kind: 'move' | 'scale' | 'rotate'; id: string; start: Vec2; cur: Vec2; origin: Vec2; shift: boolean };

const angle = (o: Vec2, p: Vec2) => (Math.atan2(p[1] - o[1], p[0] - o[0]) * 180) / Math.PI;
/** Scale factor and rotation (degrees) a scale or rotate drag stands for. */
function gestureAmount(g: Gesture): { factor: number; degrees: number } {
  const d0 = Math.hypot(g.start[0] - g.origin[0], g.start[1] - g.origin[1]);
  const d1 = Math.hypot(g.cur[0] - g.origin[0], g.cur[1] - g.origin[1]);
  let degrees = angle(g.origin, g.cur) - angle(g.origin, g.start);
  if (g.shift) degrees = Math.round(degrees / 15) * 15;
  return { factor: d0 > 1e-3 ? Math.max(0.01, d1 / d0) : 1, degrees };
}
/** Where the selection outline sits while a drag is in progress. */
function applyGesture(pts: Vec2[], g: Gesture | null): Vec2[] {
  if (!g) return pts;
  if (g.kind === 'move') return pts.map((p) => [p[0] + g.cur[0] - g.start[0], p[1] + g.cur[1] - g.start[1]]);
  const { factor, degrees } = gestureAmount(g);
  const f = g.kind === 'scale' ? factor : 1;
  const r = g.kind === 'rotate' ? (degrees * Math.PI) / 180 : 0;
  const [c, s] = [Math.cos(r), Math.sin(r)];
  return pts.map((p) => {
    const x = (p[0] - g.origin[0]) * f;
    const y = (p[1] - g.origin[1]) * f;
    return [g.origin[0] + x * c - y * s, g.origin[1] + x * s + y * c];
  });
}

function App() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const t = LOCALES[locale].strings;
  const rtl = LOCALES[locale].dir === 'rtl';
  const [server, setServer] = useState<ServerState | null>(null);
  const [runtime, setRuntime] = useState<PreviewApi | null>(null);
  const [info, setInfo] = useState<CompInfo | null>(null);
  const [comps, setComps] = useState<string[]>([]);
  const [compName, setCompName] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [scale, setScale] = useState(0.5);
  const [tl, setTl] = useState<{ rows: TimelineRow[]; audio: AudioRow[] }>({ rows: [], audio: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [insp, setInsp] = useState<Inspection | null>(null);
  const [message, setMessage] = useState<string | undefined>();
  const [file, setFile] = useState<string>('');
  const [code, setCode] = useState('');
  const [codeRev, setCodeRev] = useState(0);
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | undefined>();
  const [exportState, setExportState] = useState<string>('');
  const [guides, setGuides] = useState(false);
  const [commands, setCommands] = useState<StudioCommand[]>([]);
  const [command, setCommand] = useState('');
  const [commandInput, setCommandInput] = useState('');
  const [commandState, setCommandState] = useState<{ busy: boolean; text?: string; error?: boolean }>({ busy: false });
  const [sizes, setSizes] = useState(loadSizes);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const version = useRef(-1);
  const rendering = useRef(false);
  const pendingFrame = useRef<number | null>(null);
  const audioCtx = useRef<AudioContext>();
  const audioBuf = useRef<AudioBuffer | null>(null);
  const audioSrc = useRef<AudioBufferSourceNode | null>(null);
  const play0 = useRef({ wall: 0, frame: 0 });
  const saveTimer = useRef<number>();
  const tRef = useRef(t);
  tRef.current = t;

  const fps = info?.fps ?? 30;
  const time = frame / fps;

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = LOCALES[locale].dir;
    saveLocale(locale);
  }, [locale]);

  // ---------------------------------------------------------------- loading
  const reload = useCallback(async (v: number) => {
    if (v === version.current) return;
    version.current = v;
    try {
      const rt = await loadRuntime(v);
      const defs = rt.definitions();
      setComps(defs);
      const name = compName && defs.includes(compName) ? compName : undefined;
      const i = await rt.load({ comp: name, canvas: canvasRef.current!, scale });
      setRuntime(rt);
      setInfo(i);
      setError(null);
      setTl(rt.timeline());
      setFrame((f) => Math.min(f, i.frameCount - 1));
      const a = await rt.audio().catch(() => null);
      audioBuf.current = null;
      if (a) {
        audioCtx.current ??= new AudioContext({ sampleRate: a.sampleRate });
        const b = audioCtx.current.createBuffer(a.channels.length, a.channels[0]!.length, a.sampleRate);
        a.channels.forEach((c, k) => b.copyToChannel(c, k));
        audioBuf.current = b;
      }
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [compName, scale]);

  useEffect(() => {
    api.state().then((s) => {
      setServer(s);
      setFile(s.entry);
    });
    const es = new EventSource('/api/events');
    es.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const s = tRef.current;
      if (msg.type === 'hello' || msg.type === 'reload') {
        if (msg.error) setError(msg.error);
        else void reload(msg.version);
        api.state().then(setServer);
      } else if (msg.type === 'files') api.state().then(setServer);
      else if (msg.type === 'export') {
        if (msg.state === 'progress') setExportState(s.exporting(msg.done, msg.total, msg.fps.toFixed(1)));
        else if (msg.state === 'done') setExportState(s.exported(msg.output, msg.seconds.toFixed(1)));
        else if (msg.state === 'error') setExportState(s.exportFailed(msg.error));
        else setExportState(s.exportStarted);
      }
    };
    return () => es.close();
  }, [reload]);

  // Re-load the composition when the user picks another export.
  useEffect(() => {
    if (version.current >= 0) {
      const v = version.current;
      version.current = -1;
      void reload(v);
    }
  }, [compName]);

  // ---------------------------------------------------------------- plugin commands (AI assistant …)
  useEffect(() => {
    api.commands().then((list) => {
      setCommands(list);
      if (list[0]) setCommand(list[0].name);
    }).catch(() => setCommands([]));
  }, []);
  const runCommand = async () => {
    if (!command || commandState.busy) return;
    setCommandState({ busy: true, text: t.working });
    try {
      await flushSave();
      const r = await api.runCommand(command, commandInput, file);
      setCommandState({ busy: false, text: r.ok ? r.log.join(' · ') || t.done : r.error, error: !r.ok });
      if (r.ok) setCommandInput('');
    } catch (e) {
      setCommandState({ busy: false, text: String(e), error: true });
    }
  };

  // ---------------------------------------------------------------- code file
  // The editor and the disk are kept in step by three facts:
  //   draft  — text typed in the editor that is not on disk yet (null when there is none);
  //   known  — recent contents the studio itself read from or wrote to this file;
  //   loaded — which file those belong to.
  // A read that returns a `known` content is an echo and changes nothing. Any other content came from
  // outside the editor (a canvas edit, undo, another program) and replaces the editor's text. Every
  // action that rewrites the source first saves the draft, so it is never applied to stale text.
  const draft = useRef<string | null>(null);
  const known = useRef<string[]>([]);
  const loaded = useRef('');
  const fileRef = useRef(file);
  fileRef.current = file;

  const showExternal = (text: string) => {
    clearTimeout(saveTimer.current);
    draft.current = null;
    known.current = [text];
    setCode(text);
    setCodeRev((r) => r + 1);
  };
  const flushSave = async () => {
    clearTimeout(saveTimer.current);
    if (draft.current === null) return;
    const text = draft.current;
    draft.current = null;
    known.current = [...known.current.slice(-3), text];
    await api.writeFile(loaded.current, text);
  };
  useEffect(() => {
    if (!file) return;
    let stale = false;
    void api.readFile(file).then((text) => {
      if (stale) return;
      if (loaded.current === file && known.current.includes(text)) return;
      loaded.current = file;
      showExternal(text);
    });
    return () => {
      stale = true;
    };
  }, [file, server?.version]);

  const onCodeChange = (v: string) => {
    draft.current = v;
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flushSave(), 450);
  };
  const openFile = async (path: string) => {
    await flushSave();
    setFile(path);
  };

  // One history for typing and for canvas, timeline and inspector edits.
  const stepHistory = async (dir: 'undo' | 'redo') => {
    await flushSave();
    const r = await api[dir]();
    if (!r.ok) return;
    setServer((s) => (s ? { ...s, canUndo: r.canUndo ?? s.canUndo, canRedo: r.canRedo ?? s.canRedo } : s));
    if (r.path && r.path !== fileRef.current) setFile(r.path);
    else if (r.content !== undefined) showExternal(r.content);
  };
  const undo = () => void stepHistory('undo');
  const redo = () => void stepHistory('redo');

  // ---------------------------------------------------------------- rendering
  const draw = useCallback(
    async (f: number) => {
      if (!runtime) return;
      if (rendering.current) {
        pendingFrame.current = f;
        return;
      }
      rendering.current = true;
      try {
        await runtime.render(f);
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
      rendering.current = false;
      if (pendingFrame.current !== null && pendingFrame.current !== f) {
        const n = pendingFrame.current;
        pendingFrame.current = null;
        void draw(n);
      } else pendingFrame.current = null;
    },
    [runtime],
  );
  useEffect(() => void draw(frame), [frame, runtime, info]);
  useEffect(() => {
    runtime?.setScale(scale);
    void draw(frame);
  }, [scale]);

  // ---------------------------------------------------------------- inspector
  useEffect(() => {
    setInsp(selected && runtime ? runtime.inspect(selected, frame) : null);
  }, [selected, frame, runtime, info]);

  // ---------------------------------------------------------------- playback
  useEffect(() => {
    if (!playing || !info) return;
    play0.current = { wall: performance.now(), frame };
    if (audioBuf.current && audioCtx.current) {
      void audioCtx.current.resume();
      const s = audioCtx.current.createBufferSource();
      s.buffer = audioBuf.current;
      s.connect(audioCtx.current.destination);
      s.start(0, frame / info.fps);
      audioSrc.current = s;
    }
    let raf = 0;
    const tick = () => {
      const f = play0.current.frame + Math.floor(((performance.now() - play0.current.wall) / 1000) * info.fps);
      if (f >= info.frameCount) {
        if (loop) {
          audioSrc.current?.stop();
          setFrame(0);
          setPlaying(false);
          setTimeout(() => setPlaying(true), 0);
          return;
        }
        setFrame(info.frameCount - 1);
        setPlaying(false);
        return;
      }
      setFrame(f);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      try {
        audioSrc.current?.stop();
      } catch {
        /* already stopped */
      }
      audioSrc.current = null;
    };
  }, [playing]);

  // ---------------------------------------------------------------- edits (two-way)
  const editNode = async (frames: string[], edit: Record<string, unknown> | Record<string, unknown>[]) => {
    await flushSave();
    const r = await api.edit(frames, edit);
    if (r.error) setMessage(r.error);
    else {
      setMessage(undefined);
      if (r.file && r.file === file && r.line) setReveal({ line: r.line, nonce: Date.now() });
    }
  };
  const setProp = (key: string, value: unknown, aliases: string[] = []) => ({ kind: 'set-prop', key, value, aliases });

  const onInspectorEdit = (key: string, value: unknown) => {
    if (!insp) return;
    void editNode(insp.frames, setProp(key, value, key === 'at' ? ['position'] : []));
  };

  const revealSelected = async () => {
    if (!insp) return;
    const loc = await api.locate(insp.frames);
    if (!loc) return setMessage(t.unmapped);
    if (loc.file !== file) await openFile(loc.file);
    setTimeout(() => setReveal({ line: loc.line, nonce: Date.now() }), 60);
  };

  // Runs once the inspector holds the newly selected element.
  useEffect(() => {
    if (insp) void revealSelected();
  }, [insp?.id]);

  const onRetime = (row: TimelineRow, ch: Retime) => {
    const data = runtime?.inspect(row.id, frame);
    if (!data || !info) return;
    const len = row.end - row.start;
    const r3 = (v: number) => +v.toFixed(3);
    if (ch.start !== undefined) void editNode(row.frames, setProp('start', r3(data.start + ch.start)));
    if (ch.duration !== undefined) void editNode(row.frames, setProp('duration', r3(Math.max(1 / info.fps, len + ch.duration))));
    if (ch.trimStart !== undefined) {
      // Moving the left edge: the clip starts later and ends where it did. A video also starts later in
      // its source, so the picture under the playhead stays the same.
      const dt = ch.trimStart;
      const edits = [setProp('start', r3(data.start + dt))];
      const m = row.media;
      if (m?.kind === 'video' && m.speed > 0) {
        const tin = r3(Math.max(0, m.in + dt * m.speed));
        edits.push(setProp('trim', m.out !== undefined ? [tin, m.out] : [tin]));
        if (data.fixedDuration) edits.push(setProp('duration', r3(Math.max(1 / info.fps, len - dt))));
      } else if (data.duration !== null) edits.push(setProp('duration', r3(Math.max(1 / info.fps, len - dt))));
      void editNode(row.frames, edits);
    }
  };

  // ---------------------------------------------------------------- canvas interaction
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const toComp = (e: PointerEvent): Vec2 => {
    const r = overlayRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * (info?.width ?? 1), ((e.clientY - r.top) / r.height) * (info?.height ?? 1)];
  };

  const commitGesture = async (g: Gesture) => {
    if (!runtime || !info) return;
    const data = runtime.inspect(g.id, frame);
    if (!data) return;
    const blocked = (prop: string) => (data.animated.includes(prop) ? (setMessage(t.computed(prop)), true) : false);
    if (g.kind === 'move') {
      const d: Vec2 = [g.cur[0] - g.start[0], g.cur[1] - g.start[1]];
      if (Math.hypot(d[0], d[1]) < 1 || blocked('position')) return;
      // Convert the drag from composition space into the parent's space.
      const m = runtime.parentMatrix(g.id, frame) ?? [1, 0, 0, 1, 0, 0];
      const det = m[0]! * m[3]! - m[1]! * m[2]!;
      const dx = (m[3]! * d[0] - m[2]! * d[1]) / det;
      const dy = (-m[1]! * d[0] + m[0]! * d[1]) / det;
      const row = tl.rows.find((r) => r.id === g.id);
      const base: Vec2 = data.explicit.includes('position') ? (data.props.position as Vec2) : row && row.depth === 0 ? [info.width / 2, info.height / 2] : [0, 0];
      return editNode(data.frames, setProp('at', [Math.round(base[0] + dx), Math.round(base[1] + dy)], ['position']));
    }
    const { factor, degrees } = gestureAmount(g);
    if (g.kind === 'scale') {
      if (Math.abs(factor - 1) < 0.005 || blocked('scale')) return;
      const r3 = (v: number) => +(v * factor).toFixed(3);
      const old = data.props.scale as number | Vec2 | undefined;
      return editNode(data.frames, setProp('scale', Array.isArray(old) ? (old[0] === old[1] ? r3(old[0]) : [r3(old[0]), r3(old[1])]) : r3(old ?? 1)));
    }
    if (Math.abs(degrees) < 0.25 || blocked('rotation')) return;
    return editNode(data.frames, setProp('rotation', +(((data.props.rotation as number | undefined) ?? 0) + degrees).toFixed(1)));
  };

  const beginGesture = (e: PointerEvent, kind: Gesture['kind'], id: string) => {
    if (!runtime) return;
    e.preventDefault();
    const start = toComp(e);
    let g: Gesture = { kind, id, start, cur: start, origin: runtime.origin(id, frame) ?? start, shift: e.shiftKey };
    setGesture(g);
    const move = (ev: PointerEvent) => {
      g = { ...g, cur: toComp(ev), shift: ev.shiftKey };
      setGesture(g);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      setGesture(null);
      void commitGesture(g);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  const onCanvasDown = (e: PointerEvent) => {
    if (!runtime || !info) return;
    const p = toComp(e);
    const id = runtime.hitTest(p[0], p[1], frame);
    setSelected(id);
    if (id) beginGesture(e, 'move', id);
  };

  const selBounds = useMemo(() => (selected && runtime ? runtime.bounds(selected, frame) : null), [selected, frame, runtime, info, tl]);

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('.cm-editor, input, select, textarea')) return;
      const onControl = !!(e.target as HTMLElement).closest('button, [role=button], [role=separator]');
      if (e.key === ' ' && !onControl) {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === 'ArrowRight' && !onControl) setFrame((f) => Math.min((info?.frameCount ?? 1) - 1, f + (e.shiftKey ? 10 : 1)));
      else if (e.key === 'ArrowLeft' && !onControl) setFrame((f) => Math.max(0, f - (e.shiftKey ? 10 : 1)));
      else if (e.key === 'Home') setFrame(0);
      else if (e.key === 'End') setFrame((info?.frameCount ?? 1) - 1);
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [info]);

  // ---------------------------------------------------------------- export
  const [fmt, setFmt] = useState('mp4');
  const doExport = () => {
    const base = (info?.name && info.name !== 'Untitled' ? info.name : (server?.entry ?? 'video').replace(/\.\w+$/, '')).replace(/[^\w-]+/g, '-');
    if (fmt === 'png' || fmt === 'jpg') void api.export({ output: `out/${base}-f${frame}.${fmt}`, still: true, frame, comp: compName });
    else void api.export({ output: `out/${base}.${fmt}`, codec: fmt === 'mov' ? 'prores' : undefined, comp: compName });
  };

  // ---------------------------------------------------------------- drop to upload assets
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    try {
      for (const f of Array.from(e.dataTransfer?.files ?? [])) await api.upload(`assets/${f.name}`, f);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    }
  };

  // ---------------------------------------------------------------- panel sizes
  const resize = (key: keyof typeof DEFAULT_SIZES, min: number, max: number) => {
    const set = (v: number) =>
      setSizes((s) => {
        const next = { ...s, [key]: Math.round(Math.max(min, Math.min(max, v))) };
        try {
          localStorage.setItem(SIZES_KEY, JSON.stringify(next));
        } catch {
          /* storage unavailable */
        }
        return next;
      });
    // Dragging toward the panel's own edge of the window shrinks it.
    const sign = key === 'foot' ? -1 : (key === 'files') !== rtl ? 1 : -1;
    return {
      role: 'separator',
      tabIndex: 0,
      'aria-label': t.resizePanel,
      'aria-orientation': key === 'foot' ? 'horizontal' : 'vertical',
      'aria-valuenow': sizes[key],
      'aria-valuemin': min,
      'aria-valuemax': max,
      class: `resizer r-${key}`,
      onPointerDown: (e: PointerEvent) => {
        e.preventDefault();
        const from = sizes[key];
        const [x0, y0] = [e.clientX, e.clientY];
        const move = (ev: PointerEvent) => set(from + sign * (key === 'foot' ? ev.clientY - y0 : ev.clientX - x0));
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
      },
      onKeyDown: (e: KeyboardEvent) => {
        const grow = key === 'foot' ? { ArrowUp: 1, ArrowDown: -1 }[e.key] : { ArrowRight: sign, ArrowLeft: -sign }[e.key];
        if (!grow) return;
        e.preventDefault();
        set(sizes[key] + grow * 16);
      },
    } as const;
  };

  // Handle sizes depend on the stage's size on screen, so a window resize redraws them.
  const [, setResized] = useState(0);
  useEffect(() => {
    const on = () => setResized((n) => n + 1);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  const dims = info ? { w: info.width, h: info.height } : { w: 1920, h: 1080 };
  // Composition units per screen pixel, so handles keep one size on screen.
  const unit = dims.w / (overlayRef.current?.getBoundingClientRect().width || 800);
  const ext = fmt.toUpperCase();
  return (
    <I18n.Provider value={t}>
      <div class="app" style={{ '--files-w': `${sizes.files}px`, '--side-w': `${sizes.side}px`, '--foot-h': `${sizes.foot}px` } as Record<string, string>} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <header>
          <div class="brand">
            <Logo />
            <span class="brand-name">Tasweerix</span>
            <span class="brand-ar" lang="ar" dir="rtl">تصوير</span>
          </div>
          {comps.length > 1 && (
            <select value={compName ?? ''} aria-label={t.composition} onChange={(e) => setCompName((e.target as HTMLSelectElement).value || undefined)}>
              {comps.map((c) => (
                <option value={c === 'default' ? '' : c}>{c}</option>
              ))}
            </select>
          )}
          {/* Playback controls and timecode read left to right in every language, like the timeline. */}
          <div class="transport" dir="ltr">
            <button onClick={() => setFrame(0)} title={`${t.toStart} (Home)`} aria-label={t.toStart}><Icon name="toStart" /></button>
            <button onClick={() => setFrame((f) => Math.max(0, f - 1))} title={`${t.prevFrame} (←)`} aria-label={t.prevFrame}><Icon name="prevFrame" /></button>
            <button class="play" onClick={() => setPlaying((p) => !p)} title={`${playing ? t.pause : t.play} (Space)`} aria-label={playing ? t.pause : t.play}><Icon name={playing ? 'pause' : 'play'} size={18} /></button>
            <button onClick={() => setFrame((f) => Math.min((info?.frameCount ?? 1) - 1, f + 1))} title={`${t.nextFrame} (→)`} aria-label={t.nextFrame}><Icon name="nextFrame" /></button>
            <button class={loop ? 'on' : ''} onClick={() => setLoop((l) => !l)} title={t.loop} aria-label={t.loop} aria-pressed={loop}><Icon name="loop" /></button>
            <span class="tc">{timecode(time, fps)} <span class="muted">/ {timecode(info?.duration ?? 0, fps)} · f{frame}</span></span>
          </div>
          <div class="spacer" />
          <select value={String(scale)} onChange={(e) => setScale(Number((e.target as HTMLSelectElement).value))} title={t.previewScale} aria-label={t.previewScale}>
            <option value="0.25">25%</option>
            <option value="0.5">50%</option>
            <option value="0.75">75%</option>
            <option value="1">100%</option>
          </select>
          <button class={guides ? 'on' : ''} onClick={() => setGuides((g) => !g)} title={t.guides} aria-label={t.guides} aria-pressed={guides}><Icon name="guides" /></button>
          <button onClick={undo} disabled={!server?.canUndo} title={`${t.undo} (⌘Z)`} aria-label={t.undo}><Icon name="undo" /></button>
          <button onClick={redo} disabled={!server?.canRedo} title={`${t.redo} (⇧⌘Z)`} aria-label={t.redo}><Icon name="redo" /></button>
          <button class="lang" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')} title={t.language} aria-label={`${t.language}: ${LOCALES[locale === 'ar' ? 'en' : 'ar'].name}`}>
            <Icon name="globe" />
            <span lang={locale === 'ar' ? 'en' : 'ar'}>{LOCALES[locale === 'ar' ? 'en' : 'ar'].name}</span>
          </button>
          <select value={fmt} aria-label={t.exportFormat} onChange={(e) => setFmt((e.target as HTMLSelectElement).value)}>
            <option value="mp4">MP4 (H.264)</option>
            <option value="webm">WebM (VP9)</option>
            <option value="mov">MOV (ProRes)</option>
            <option value="gif">GIF</option>
            <option value="png">{t.frameOf('PNG')}</option>
            <option value="jpg">{t.frameOf('JPG')}</option>
          </select>
          <button class="primary" onClick={doExport} title={`${t.export} ${ext}`}>{t.export}</button>
        </header>

        <aside class="files">
          <div class="panel-title">{t.project}</div>
          {server?.files.map((f) => {
            const fext = f.path.split('.').pop()!.toLowerCase();
            const snippet = ASSET_SNIPPET[fext];
            const isCode = /\.(ts|tsx|js|mjs|json)$/.test(f.path);
            const name = (
              <>
                <Icon name={fileIcon(fext)} />
                <span class="file-name" dir="ltr">{f.path}</span>
              </>
            );
            return (
              <div class={`file ${f.path === file ? 'active' : ''}`} title={f.path}>
                {isCode ? (
                  <button class="file-open" onClick={() => void openFile(f.path)} aria-label={t.openFile(f.path)} aria-current={f.path === file}>
                    {name}
                  </button>
                ) : (
                  <span class="file-open">{name}</span>
                )}
                {isCode && f.path !== server.entry && (
                  <button class="link" title={t.useAsEntry} aria-label={`${t.useAsEntry}: ${f.path}`} onClick={() => api.setEntry(f.path)}>
                    <Icon name="entry" />
                  </button>
                )}
                {snippet && (
                  <button class="link" title={t.copySnippet(snippet(f.path))} aria-label={t.copySnippet(snippet(f.path))} onClick={() => navigator.clipboard?.writeText(snippet(f.path))}>
                    <Icon name="copy" />
                  </button>
                )}
              </div>
            );
          })}
          <div class="hint">{t.dropHint}</div>
        </aside>
        <div {...resize('files', 140, 480)} />

        <main class="stage" dir="ltr">
          <div class="viewport" style={{ aspectRatio: `${dims.w} / ${dims.h}`, '--ar': String(dims.w / dims.h) } as Record<string, string>}>
            <canvas ref={canvasRef} class="checker" />
            <svg ref={overlayRef} class="overlay" viewBox={`0 0 ${dims.w} ${dims.h}`} role="application" aria-label={t.canvas} onPointerDown={onCanvasDown as never}>
              {guides && (
                <g class="guides">
                  <rect x={dims.w * 0.05} y={dims.h * 0.05} width={dims.w * 0.9} height={dims.h * 0.9} />
                  <rect x={dims.w * 0.1} y={dims.h * 0.1} width={dims.w * 0.8} height={dims.h * 0.8} />
                  <line x1={dims.w / 3} y1={0} x2={dims.w / 3} y2={dims.h} />
                  <line x1={(2 * dims.w) / 3} y1={0} x2={(2 * dims.w) / 3} y2={dims.h} />
                  <line x1={0} y1={dims.h / 3} x2={dims.w} y2={dims.h / 3} />
                  <line x1={0} y1={(2 * dims.h) / 3} x2={dims.w} y2={(2 * dims.h) / 3} />
                </g>
              )}
              {selBounds && selected && (() => {
                const pts = applyGesture(selBounds as Vec2[], gesture && gesture.id === selected ? gesture : null);
                const str = pts.map((p) => `${p[0]},${p[1]}`).join(' ');
                // The rotate handle stands off the middle of the top edge, away from the center.
                const mid: Vec2 = [(pts[0]![0] + pts[1]![0]) / 2, (pts[0]![1] + pts[1]![1]) / 2];
                const cen: Vec2 = [(pts[0]![0] + pts[2]![0]) / 2, (pts[0]![1] + pts[2]![1]) / 2];
                const out = Math.hypot(mid[0] - cen[0], mid[1] - cen[1]) || 1;
                const knob: Vec2 = [mid[0] + ((mid[0] - cen[0]) / out) * 26 * unit, mid[1] + ((mid[1] - cen[1]) / out) * 26 * unit];
                const h = 5 * unit;
                const grab = (kind: Gesture['kind']) => (e: PointerEvent) => {
                  e.stopPropagation();
                  beginGesture(e, kind, selected);
                };
                return (
                  <g>
                    <polygon class="sel-shadow" points={str} />
                    <polygon class="sel-box" points={str} />
                    <line class="sel-stem" x1={mid[0]} y1={mid[1]} x2={knob[0]} y2={knob[1]} />
                    <circle class="sel-handle rotate" cx={knob[0]} cy={knob[1]} r={h * 1.1} onPointerDown={grab('rotate') as never}>
                      <title>{t.rotateHandle}</title>
                    </circle>
                    {pts.map((p, i) => (
                      <rect class={`sel-handle scale ${i % 2 ? 'nesw' : 'nwse'}`} x={p[0] - h} y={p[1] - h} width={h * 2} height={h * 2} onPointerDown={grab('scale') as never}>
                        <title>{t.scaleHandle}</title>
                      </rect>
                    ))}
                  </g>
                );
              })()}
            </svg>
          </div>
          {error && <pre class="error" role="alert">{error}</pre>}
        </main>

        <section class="side">
          <div class="editor-wrap">
            {commands.length > 0 && (
              <form
                class="command-bar"
                onSubmit={(e) => {
                  e.preventDefault();
                  void runCommand();
                }}
              >
                {commands.length > 1 ? (
                  <select value={command} onChange={(e) => setCommand((e.target as HTMLSelectElement).value)}>
                    {commands.map((c) => (
                      <option value={c.name}>{c.label}</option>
                    ))}
                  </select>
                ) : (
                  <span class="command-label" title={commands[0]!.description}>{commands[0]!.label}</span>
                )}
                <input
                  dir="auto"
                  value={commandInput}
                  disabled={commandState.busy}
                  aria-label={commands.find((c) => c.name === command)?.label ?? ''}
                  placeholder={commands.find((c) => c.name === command)?.prompt ?? ''}
                  onInput={(e) => setCommandInput((e.target as HTMLInputElement).value)}
                />
                <button class="primary" type="submit" disabled={commandState.busy}>
                  {commandState.busy ? '…' : t.run}
                </button>
                {commandState.text && <div class={`command-status ${commandState.error ? 'failed' : ''}`} role="status">{commandState.text}</div>}
              </form>
            )}
            <div class="panel-title">
              <span dir="ltr">{file}</span> <span class="muted">· {t.autosave}</span>
            </div>
            <CodeEditor value={code} rev={codeRev} onChange={onCodeChange} onUndo={undo} onRedo={redo} label={t.codeEditor} reveal={reveal} />
          </div>
          <Inspector data={insp} onEdit={onInspectorEdit} onReveal={revealSelected} message={message} />
        </section>
        <div {...resize('side', 280, 900)} />

        <footer>
          <div {...resize('foot', 120, 700)} />
          {info && (
            <Timeline
              info={info}
              rows={tl.rows}
              audio={tl.audio}
              time={time}
              selected={selected}
              runtime={runtime}
              onSeek={(s) => setFrame(Math.min(info.frameCount - 1, Math.round(s * info.fps)))}
              onSelect={setSelected}
              onRetime={onRetime}
              onKeyMove={(row, prop, index, at) => {
                const k = row.keyframes.find((x) => x.prop === prop);
                if (!k) return;
                void editNode(k.frames.length ? k.frames : row.frames, { kind: 'set-key', key: index, field: 0, value: +Math.max(0, at - row.start).toFixed(3) });
              }}
            />
          )}
          <div class="status" role="status">{exportState}</div>
        </footer>
      </div>
    </I18n.Provider>
  );
}

render(<App />, document.getElementById('app')!);
