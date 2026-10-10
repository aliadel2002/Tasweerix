import type { TClip, TimelineModel } from './model';
import { applyTransition, baseName, emptyModel, finishModel, isAudioPath, isImagePath, urlToPath, type PlacedClip, type TransitionMark } from './util';

/** Timecode → seconds (drop-frame aware for 29.97 / 59.94). */
export function tcToSeconds(tc: string, fps: number): number {
  const m = /^(\d+)[:;.](\d+)[:;.](\d+)([:;.])(\d+)$/.exec(tc.trim());
  if (!m) return 0;
  const [h, mi, s, sep, f] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4], Number(m[5])];
  const nominal = Math.round(fps);
  const drop = sep === ';' && Math.abs(fps - nominal) > 0.001;
  let frames = ((h * 60 + mi) * 60 + s) * nominal + f;
  if (drop) {
    const dropPer = Math.round(nominal / 15); // 2 for 29.97, 4 for 59.94
    const totalMinutes = h * 60 + mi;
    frames -= dropPer * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames / fps;
}

/** Seconds → non-drop timecode on the nominal frame grid. */
export function secondsToTc(sec: number, fps: number): string {
  const nominal = Math.round(fps);
  let frames = Math.max(0, Math.round(sec * fps));
  const f = frames % nominal;
  frames = (frames - f) / nominal;
  const s = frames % 60;
  frames = (frames - s) / 60;
  const mi = frames % 60;
  const h = (frames - mi) / 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(mi)}:${p(s)}:${p(f)}`;
}

const EVENT_RE = /^(\d{1,6})\s+(\S+)\s+(\S+)\s+(C|D|W\d{3}|K[BO]?)\s+(?:(\d+)\s+)?(\d\d[:;.]\d\d[:;.]\d\d[:;.]\d\d)\s+(\d\d[:;.]\d\d[:;.]\d\d[:;.]\d\d)\s+(\d\d[:;.]\d\d[:;.]\d\d[:;.]\d\d)\s+(\d\d[:;.]\d\d[:;.]\d\d[:;.]\d\d)/;
const M2_RE = /^M2\s+(\S+)\s+(-?\d+(?:\.\d+)?)\s+(\d\d[:;.]\d\d[:;.]\d\d[:;.]\d\d)/;

/**
 * Reads a CMX 3600 EDL. EDLs carry no frame rate, so pass `fps` (default 30; 29.97 is detected from
 * drop-frame timecode). Record times are made zero-based (the usual 01:00:00:00 start is removed).
 */
export function fromEDL(text: string, opts: { fps?: number } = {}): TimelineModel {
  const lines = text.split(/\r?\n/);
  const dropFrame = /FCM:\s*DROP FRAME/i.test(text) || /\d\d;\d\d\s*$/m.test(text);
  const fps = opts.fps ?? (dropFrame ? 29.97 : 30);
  const m = emptyModel({ fps });
  const title = /^TITLE:\s*(.*)$/im.exec(text);
  if (title?.[1]) m.name = title[1].trim();
  type Ev = { num: string; reel: string; channel: string; trans: string; dur: number; srcIn: number; srcOut: number; recIn: number; recOut: number; name?: string; file?: string; speed?: number };
  const events: Ev[] = [];
  const notes = new Set<string>();
  const markers: { tc: string; label: string; color?: string }[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const ev = EVENT_RE.exec(line);
    if (ev) {
      events.push({ num: ev[1]!, reel: ev[2]!, channel: ev[3]!.toUpperCase(), trans: ev[4]!.toUpperCase(), dur: ev[5] ? Number(ev[5]) / fps : 0, srcIn: tcToSeconds(ev[6]!, fps), srcOut: tcToSeconds(ev[7]!, fps), recIn: tcToSeconds(ev[8]!, fps), recOut: tcToSeconds(ev[9]!, fps) });
      continue;
    }
    const last = events[events.length - 1];
    const m2 = M2_RE.exec(line);
    if (m2) {
      // The speed line applies to the latest event using that reel.
      const target = [...events].reverse().find((e) => e.reel === m2[1]) ?? last;
      if (target) target.speed = Number(m2[2]) / fps;
      continue;
    }
    const comment = /^\*\s*([^:]+):\s*(.*)$/.exec(line);
    if (comment && last) {
      const key = comment[1]!.trim().toUpperCase();
      const val = comment[2]!.trim();
      // In a transition event "FROM" describes the outgoing source and "TO" the incoming one.
      const pair = events.filter((e) => e.num === last.num);
      const target = key.startsWith('TO ') ? last : key.startsWith('FROM ') ? pair[0]! : last;
      if (/^(FROM |TO )?CLIP NAME$/.test(key)) target.name = val;
      else if (/^(SOURCE FILE|(FROM |TO )(FILE|CLIP))$/.test(key)) target.file = val;
      else if (key === 'LOC') {
        const loc = /^(\S+)\s+(\S+)?\s*(.*)$/.exec(val);
        if (loc) markers.push({ tc: loc[1]!, color: loc[2]?.toLowerCase(), label: loc[3]?.replace(/\|[CD]:[^|]*/g, '').replace(/^\|M:/, '').replace(/\|M:/, '').trim() || 'Marker' });
      }
      continue;
    }
    if (/^(TITLE|FCM):/i.test(line)) continue;
    if (/^\d+\s/.test(line)) notes.add(`unparsed line: ${line.slice(0, 60)}`);
  }
  const recs = events.map((e) => e.recIn);
  const first = recs.length ? Math.min(...recs) : 0;
  const zero = Math.floor(first / 3600 + 1e-9) * 3600;

  const placed: PlacedClip[] = [];
  const transitions: TransitionMark[] = [];
  for (const e of events) {
    const duration = e.recOut - e.recIn;
    if (duration <= 1e-6) continue; // the zero-length "from" side of a dissolve
    if (e.reel === 'BL' || e.reel === 'BLK' || e.reel === 'BLACK') continue; // black filler
    const file = e.file ?? e.name ?? e.reel;
    const path = urlToPath(file);
    const video = /V|B/.test(e.channel);
    const audio = /A/.test(e.channel);
    const speed = e.speed ?? (e.srcOut - e.srcIn > 0 && Math.abs((e.srcOut - e.srcIn) / duration - 1) > 0.01 ? (e.srcOut - e.srcIn) / duration : 1);
    const base = { name: e.name ?? baseName(path), src: path, url: file, start: e.recIn - zero, duration, sourceIn: e.srcIn, speed, info: {} };
    if (video) placed.push({ ...base, lane: 0, kind: isImagePath(path) ? 'image' : 'video', withAudio: audio });
    else if (audio || isAudioPath(path)) placed.push({ ...base, lane: 0, kind: 'audio' });
    if (e.trans !== 'C') {
      if (e.trans.startsWith('K')) notes.add(`key event ${e.num}`);
      else transitions.push({ lane: video ? 0 : -1, start: e.recIn - zero, end: e.recIn - zero + e.dur, type: e.trans === 'D' ? 'crossfade' : 'wipe' });
    }
  }
  for (const c of placed) if (c.kind === 'audio') c.lane = -1;
  for (const t of transitions) applyTransition(placed, t);
  for (const c of placed) if (c.kind === 'audio') c.lane = 0;
  for (const mk of markers) m.markers.push({ time: Math.max(0, tcToSeconds(mk.tc, fps) - zero), label: mk.label, color: mk.color });
  m.unsupported = [...notes];
  return finishModel(m, placed);
}

/**
 * Writes a CMX 3600 EDL of one video track (default: the first). EDLs are single-track by nature,
 * so other tracks are left out; `audio: true` appends the first audio track's events (not every
 * reader accepts audio events that overlap video ones). Titles have no EDL form and are skipped.
 */
export function toEDL(m: TimelineModel, opts: { track?: number; title?: string; startTimecode?: number; audio?: boolean } = {}): string {
  const fps = m.fps;
  const offset = opts.startTimecode ?? 3600;
  const tc = (s: number) => secondsToTc(s, fps);
  const out = [`TITLE: ${opts.title ?? m.name}`, 'FCM: NON-DROP FRAME', ''];
  let n = 1;
  const num = () => String(n++).padStart(3, '0');
  const meta = (c: TClip) => [`* FROM CLIP NAME: ${baseName(c.src)}`, `* SOURCE FILE: ${c.src}`];
  const track = m.video[opts.track ?? 0]?.clips ?? [];
  track.forEach((c, i) => {
    if (c.kind === 'title') return;
    const ch = c.withAudio ? 'AA/V' : 'V';
    const prev = track[i - 1];
    const next = track[i + 1];
    // In an EDL the outgoing clip ends where the dissolve into the next one starts.
    const duration = next?.transitionIn ? next.start - c.start : c.duration;
    const recIn = offset + c.start;
    const recOut = recIn + duration;
    const srcOut = c.sourceIn + duration * c.speed;
    if (c.transitionIn && prev) {
      // Outgoing side (zero length) then the incoming clip with the dissolve duration.
      const id = num();
      const prevSrc = prev.sourceIn + (c.start - prev.start) * prev.speed;
      out.push(`${id}  AX       ${ch.padEnd(5)} C        ${tc(prevSrc)} ${tc(prevSrc)} ${tc(recIn)} ${tc(recIn)}`);
      out.push(`${id}  AX       ${ch.padEnd(5)} D    ${String(Math.round(c.transitionIn.duration * fps)).padStart(3, '0')} ${tc(c.sourceIn)} ${tc(srcOut)} ${tc(recIn)} ${tc(recOut)}`);
      if (c.speed !== 1) out.push(`M2   AX       ${(c.speed * fps).toFixed(1).padStart(5, '0')}                ${tc(c.sourceIn)}`);
      out.push(...meta(c), '');
      return;
    }
    out.push(`${num()}  AX       ${ch.padEnd(5)} C        ${tc(c.sourceIn)} ${tc(srcOut)} ${tc(recIn)} ${tc(recOut)}`);
    if (c.speed !== 1) out.push(`M2   AX       ${(c.speed * fps).toFixed(1).padStart(5, '0')}                ${tc(c.sourceIn)}`);
    out.push(...meta(c), '');
  });
  for (const c of opts.audio ? (m.audio[0]?.clips ?? []) : []) {
    const recIn = offset + c.start;
    out.push(`${num()}  AX       AA    C        ${tc(c.sourceIn)} ${tc(c.sourceIn + c.duration * c.speed)} ${tc(recIn)} ${tc(recIn + c.duration)}`);
    out.push(...meta(c), '');
  }
  for (const mk of m.markers) out.push(`* LOC: ${tc(offset + mk.time)} ${(mk.color ?? 'red').toUpperCase().padEnd(7)} ${mk.label}`);
  return out.join('\n') + '\n';
}
