import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, loadRuntime, timecode, type StudioCommand, type CompInfo, type Inspection, type PreviewApi, type ServerState, type TimelineRow, type AudioRow } from './api';
import { CodeEditor } from './editor';
import { Inspector } from './inspector';
import { Timeline } from './timeline';
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

function App() {
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
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | undefined>();
  const [exportState, setExportState] = useState<string>('');
  const [guides, setGuides] = useState(false);
  const [commands, setCommands] = useState<StudioCommand[]>([]);
  const [command, setCommand] = useState('');
  const [commandInput, setCommandInput] = useState('');
  const [commandState, setCommandState] = useState<{ busy: boolean; text?: string; error?: boolean }>({ busy: false });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const version = useRef(-1);
  const rendering = useRef(false);
  const pendingFrame = useRef<number | null>(null);
  const audioCtx = useRef<AudioContext>();
  const audioBuf = useRef<AudioBuffer | null>(null);
  const audioSrc = useRef<AudioBufferSourceNode | null>(null);
  const play0 = useRef({ wall: 0, frame: 0 });
  const saveTimer = useRef<number>();

  const fps = info?.fps ?? 30;
  const time = frame / fps;

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
      if (msg.type === 'hello' || msg.type === 'reload') {
        if (msg.error) setError(msg.error);
        else void reload(msg.version);
        api.state().then(setServer);
      } else if (msg.type === 'files') api.state().then(setServer);
      else if (msg.type === 'export') {
        if (msg.state === 'progress') setExportState(`Exporting ${msg.done}/${msg.total} · ${msg.fps.toFixed(1)} fps`);
        else if (msg.state === 'done') setExportState(`✔ Exported ${msg.output} (${msg.seconds.toFixed(1)}s)`);
        else if (msg.state === 'error') setExportState(`✖ ${msg.error}`);
        else setExportState('Export started…');
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
    setCommandState({ busy: true, text: 'Working…' });
    try {
      const r = await api.runCommand(command, commandInput, file);
      setCommandState({ busy: false, text: r.ok ? r.log.join(' · ') || 'Done' : r.error, error: !r.ok });
      if (r.ok) setCommandInput('');
    } catch (e) {
      setCommandState({ busy: false, text: String(e), error: true });
    }
  };

  // ---------------------------------------------------------------- code file
  useEffect(() => {
    if (file) api.readFile(file).then(setCode);
  }, [file, server?.version]);

  const onCodeChange = (v: string) => {
    setCode(v);
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => api.writeFile(file, v), 450);
  };

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
  const editNode = async (frames: string[], edit: Record<string, unknown>) => {
    const r = await api.edit(frames, edit);
    if (r.error) setMessage(r.error);
    else {
      setMessage(undefined);
      if (r.file && r.file === file && r.line) setReveal({ line: r.line, nonce: Date.now() });
    }
  };

  const onInspectorEdit = (key: string, value: unknown) => {
    if (!insp) return;
    void editNode(insp.frames, { kind: 'set-prop', key, value, aliases: key === 'at' ? ['position'] : [] });
  };

  const revealSelected = async () => {
    if (!insp) return;
    const loc = await api.locate(insp.frames);
    if (!loc) return setMessage('Could not map this element to source');
    if (loc.file !== file) setFile(loc.file);
    setTimeout(() => setReveal({ line: loc.line, nonce: Date.now() }), 60);
  };

  useEffect(() => {
    if (selected) void revealSelected();
  }, [selected]);

  // ---------------------------------------------------------------- canvas interaction
  const [dragDelta, setDragDelta] = useState<Vec2 | null>(null);
  const toComp = (e: PointerEvent): Vec2 => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * (info?.width ?? 1), ((e.clientY - r.top) / r.height) * (info?.height ?? 1)];
  };
  const onCanvasDown = (e: PointerEvent) => {
    if (!runtime || !info) return;
    const p = toComp(e);
    const id = runtime.hitTest(p[0], p[1], frame);
    setSelected(id);
    if (!id) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const start = p;
    const move = (ev: PointerEvent) => {
      const q = toComp(ev);
      setDragDelta([q[0] - start[0], q[1] - start[1]]);
    };
    const up = async (ev: PointerEvent) => {
      (e.currentTarget as HTMLElement | null)?.removeEventListener('pointermove', move as never);
      const q = toComp(ev);
      const d: Vec2 = [q[0] - start[0], q[1] - start[1]];
      setDragDelta(null);
      if (Math.hypot(d[0], d[1]) < 1) return;
      const data = runtime.inspect(id, frame);
      if (!data) return;
      if (data.animated.includes('position')) return setMessage('position is animated / computed in code — edit its keyframes instead');
      // Convert the drag from composition space into the parent's space.
      const m = runtime.parentMatrix(id, frame) ?? [1, 0, 0, 1, 0, 0];
      const det = m[0]! * m[3]! - m[1]! * m[2]!;
      const dx = (m[3]! * d[0] - m[2]! * d[1]) / det;
      const dy = (-m[1]! * d[0] + m[0]! * d[1]) / det;
      const row = tl.rows.find((r) => r.id === id);
      const base: Vec2 = data.explicit.includes('position') ? (data.props.position as Vec2) : row && row.depth === 0 ? [info.width / 2, info.height / 2] : [0, 0];
      await editNode(data.frames, { kind: 'set-prop', key: 'at', aliases: ['position'], value: [Math.round(base[0] + dx), Math.round(base[1] + dy)] });
    };
    e.currentTarget!.addEventListener('pointermove', move as never);
    e.currentTarget!.addEventListener('pointerup', up as never, { once: true });
  };

  const selBounds = useMemo(() => (selected && runtime ? runtime.bounds(selected, frame) : null), [selected, frame, runtime, info, tl]);

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('.cm-editor, input, select, textarea')) return;
      if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === 'ArrowRight') setFrame((f) => Math.min((info?.frameCount ?? 1) - 1, f + (e.shiftKey ? 10 : 1)));
      else if (e.key === 'ArrowLeft') setFrame((f) => Math.max(0, f - (e.shiftKey ? 10 : 1)));
      else if (e.key === 'Home') setFrame(0);
      else if (e.key === 'End') setFrame((info?.frameCount ?? 1) - 1);
      else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        void (e.shiftKey ? api.redo() : api.undo());
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
    for (const f of Array.from(e.dataTransfer?.files ?? [])) await api.upload(`assets/${f.name}`, f);
  };

  const dims = info ? { w: info.width, h: info.height } : { w: 1920, h: 1080 };
  return (
    <div class="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header>
        <div class="brand">Tasweerix <span>Studio</span></div>
        {comps.length > 1 && (
          <select value={compName ?? ''} onChange={(e) => setCompName((e.target as HTMLSelectElement).value || undefined)}>
            {comps.map((c) => (
              <option value={c === 'default' ? '' : c}>{c}</option>
            ))}
          </select>
        )}
        <div class="transport">
          <button onClick={() => setFrame(0)} title="Start (Home)">⏮</button>
          <button onClick={() => setFrame((f) => Math.max(0, f - 1))} title="Previous frame (←)">◀</button>
          <button class="play" onClick={() => setPlaying((p) => !p)} title="Play/Pause (Space)">{playing ? '❚❚' : '▶'}</button>
          <button onClick={() => setFrame((f) => Math.min((info?.frameCount ?? 1) - 1, f + 1))} title="Next frame (→)">▶</button>
          <button class={loop ? 'on' : ''} onClick={() => setLoop((l) => !l)} title="Loop">⟲</button>
          <span class="tc">{timecode(time, fps)} <span class="muted">/ {timecode(info?.duration ?? 0, fps)} · f{frame}</span></span>
        </div>
        <div class="spacer" />
        <select value={String(scale)} onChange={(e) => setScale(Number((e.target as HTMLSelectElement).value))} title="Preview resolution">
          <option value="0.25">25%</option>
          <option value="0.5">50%</option>
          <option value="0.75">75%</option>
          <option value="1">100%</option>
        </select>
        <button class={guides ? 'on' : ''} onClick={() => setGuides((g) => !g)} title="Safe areas & grid">#</button>
        <button onClick={() => api.undo()} disabled={!server?.canUndo} title="Undo (⌘Z)">↶</button>
        <button onClick={() => api.redo()} disabled={!server?.canRedo} title="Redo (⇧⌘Z)">↷</button>
        <select value={fmt} onChange={(e) => setFmt((e.target as HTMLSelectElement).value)}>
          <option value="mp4">MP4 (H.264)</option>
          <option value="webm">WebM (VP9)</option>
          <option value="mov">MOV (ProRes)</option>
          <option value="gif">GIF</option>
          <option value="png">PNG frame</option>
          <option value="jpg">JPG frame</option>
        </select>
        <button class="primary" onClick={doExport}>Export</button>
      </header>

      <aside class="files">
        <div class="panel-title">Project</div>
        {server?.files.map((f) => {
          const ext = f.path.split('.').pop()!.toLowerCase();
          const snippet = ASSET_SNIPPET[ext];
          const isCode = /\.(ts|tsx|js|mjs|json)$/.test(f.path);
          return (
            <div class={`file ${f.path === file ? 'active' : ''}`} title={f.path}>
              <span onClick={() => isCode && setFile(f.path)} class={isCode ? 'clickable' : ''}>
                {isCode ? '📄' : '🖼'} {f.path}
              </span>
              {isCode && f.path !== server.entry && (
                <button class="link" title="Use as entry" onClick={() => api.setEntry(f.path)}>
                  ▶
                </button>
              )}
              {snippet && (
                <button class="link" title={`Copy ${snippet(f.path)}`} onClick={() => navigator.clipboard?.writeText(snippet(f.path))}>
                  ⧉
                </button>
              )}
            </div>
          );
        })}
        <div class="hint">Drop files here to add them to assets/</div>
      </aside>

      <main class="stage">
        <div class="viewport" style={{ aspectRatio: `${dims.w} / ${dims.h}`, '--ar': String(dims.w / dims.h) } as Record<string, string>}>
          <canvas ref={canvasRef} class={info?.kind === 'still' || !info ? 'checker' : 'checker'} />
          <svg class="overlay" viewBox={`0 0 ${dims.w} ${dims.h}`} onPointerDown={onCanvasDown as never}>
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
            {selBounds && (() => {
              const pts = selBounds.map((p) => [p[0] + (dragDelta?.[0] ?? 0), p[1] + (dragDelta?.[1] ?? 0)] as Vec2);
              const str = pts.map((p) => `${p[0]},${p[1]}`).join(' ');
              return (
                <g>
                  <polygon class="sel-shadow" points={str} />
                  <polygon class="sel-box" points={str} />
                  {pts.map((p) => (
                    <circle class="sel-handle" cx={p[0]} cy={p[1]} r={dims.w / 300} />
                  ))}
                </g>
              );
            })()}
          </svg>
        </div>
        {error && <pre class="error">{error}</pre>}
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
                value={commandInput}
                disabled={commandState.busy}
                placeholder={commands.find((c) => c.name === command)?.prompt ?? ''}
                onInput={(e) => setCommandInput((e.target as HTMLInputElement).value)}
              />
              <button class="primary" type="submit" disabled={commandState.busy}>
                {commandState.busy ? '…' : 'Run'}
              </button>
              {commandState.text && <div class={`command-status ${commandState.error ? 'failed' : ''}`}>{commandState.text}</div>}
            </form>
          )}
          <div class="panel-title">
            {file} <span class="muted">· saves automatically</span>
          </div>
          <CodeEditor value={code} onChange={onCodeChange} reveal={reveal} />
        </div>
        <Inspector data={insp} onEdit={onInspectorEdit} onReveal={revealSelected} message={message} />
      </section>

      <footer>
        {info && (
          <Timeline
            info={info}
            rows={tl.rows}
            audio={tl.audio}
            time={time}
            selected={selected}
            runtime={runtime}
            onSeek={(t) => setFrame(Math.min(info.frameCount - 1, Math.round(t * info.fps)))}
            onSelect={setSelected}
            onRetime={(row, ch) => {
              const data = runtime?.inspect(row.id, frame);
              if (!data) return;
              if (ch.start !== undefined) void editNode(row.frames, { kind: 'set-prop', key: 'start', value: +(data.start + ch.start).toFixed(3) });
              if (ch.duration !== undefined) void editNode(row.frames, { kind: 'set-prop', key: 'duration', value: +Math.max(1 / info.fps, row.end - row.start + ch.duration).toFixed(3) });
            }}
            onKeyMove={(row, prop, index, t) => {
              const k = row.keyframes.find((x) => x.prop === prop);
              if (!k) return;
              void editNode(k.frames.length ? k.frames : row.frames, { kind: 'set-key', key: index, field: 0, value: +Math.max(0, t - row.start).toFixed(3) });
            }}
          />
        )}
        <div class="status">{exportState}</div>
      </footer>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
