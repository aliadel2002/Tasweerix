import { parseXml, type XmlNode } from '@tasweerix/core';
import type { TClip, TimelineModel } from './model';
import { applyTransition, baseName, emptyModel, find, findAll, finishModel, isAudioPath, isImagePath, kid, kids, kidText, transitionKind, urlToPath, type PlacedClip, type TransitionMark } from './util';

const rateOf = (n: XmlNode | undefined): number | undefined => {
  const r = n ? kid(n, 'rate') : undefined;
  const tb = Number(kidText(r, 'timebase'));
  if (!tb) return undefined;
  return /true/i.test(kidText(r, 'ntsc') ?? '') ? (tb * 1000) / 1001 : tb;
};
const num = (n: XmlNode | undefined, tag: string, d = 0) => {
  const v = kidText(n, tag);
  return v === undefined || v === '' ? d : Number(v);
};

/** Reads Final Cut Pro 7 XML (xmeml), the format Premiere Pro and many tools exchange. */
export function fromXMEML(text: string): TimelineModel {
  const doc = parseXml(text);
  if (doc.tag !== 'xmeml') throw new Error('xmeml: missing <xmeml> root');
  // The first sequence that has media (projects may contain bins and several sequences).
  const seq = findAll(doc, 'sequence').find((s) => kid(s, 'media')) ?? find(doc, 'sequence');
  if (!seq) throw new Error('xmeml: no <sequence> found');
  const fps = rateOf(seq) ?? 30;
  const m = emptyModel({ name: kidText(seq, 'name') || 'Imported timeline', fps: +fps.toFixed(3) });
  const media = kid(seq, 'media');
  const sc = find(kid(media, 'video'), 'samplecharacteristics');
  if (sc) {
    m.width = num(sc, 'width', 1920);
    m.height = num(sc, 'height', 1080);
  }
  const files = new Map<string, XmlNode>();
  for (const f of findAll(doc, 'file')) if (f.attrs.id && f.children.length) files.set(f.attrs.id, f);
  const placed: PlacedClip[] = [];
  const transitions: TransitionMark[] = [];
  const notes = new Set<string>();

  const walkTrack = (track: XmlNode, lane: number, audio: boolean) => {
    if (/false/i.test(kidText(track, 'enabled') ?? 'TRUE')) return;
    let cursor = 0;
    for (const item of kids(track)) {
      if (item.tag === 'transitionitem') {
        const r = rateOf(item) ?? fps;
        transitions.push({ lane, start: num(item, 'start') / r, end: num(item, 'end') / r, type: transitionKind(kidText(find(item, 'effect'), 'name') ?? kidText(find(item, 'effect'), 'effectid')) });
        continue;
      }
      if (item.tag !== 'clipitem' && item.tag !== 'generatoritem') continue;
      if (/false/i.test(kidText(item, 'enabled') ?? 'TRUE')) continue;
      const r = rateOf(item) ?? fps;
      let speed = 1;
      let gainDb: number | undefined;
      let titleText: string | undefined;
      for (const eff of findAll(item, 'effect')) {
        const id = (kidText(eff, 'effectid') ?? '').toLowerCase();
        const params = kids(eff, 'parameter');
        const param = (pid: string) => params.find((p) => (kidText(p, 'parameterid') ?? '').toLowerCase() === pid);
        if (id === 'timeremap') {
          const sp = param('speed');
          if (sp) speed = Number(kidText(sp, 'value') ?? 100) / 100;
          if (/true/i.test(kidText(param('reverse'), 'value') ?? '')) speed = -speed;
        } else if (id === 'audiolevels') {
          const lv = Number(kidText(param('level'), 'value'));
          if (lv > 0) gainDb = +(20 * Math.log10(lv)).toFixed(2);
        } else if (item.tag === 'generatoritem' && param('str')) titleText = kidText(param('str'), 'value');
        else if (id && item.tag === 'clipitem') notes.add(`${kidText(eff, 'name') ?? id} effect on ${kidText(item, 'name')}`);
      }
      const inF = num(item, 'in');
      const outF = num(item, 'out');
      const srcLen = (outF - inF) / r;
      const tlLen = Math.abs(speed) > 1e-9 ? srcLen / Math.abs(speed) : srcLen;
      let start = num(item, 'start', -1);
      let end = num(item, 'end', -1);
      start = start >= 0 ? start / r : end >= 0 ? end / r - tlLen : cursor;
      end = end >= 0 ? end / r : start + tlLen;
      cursor = end;
      const name = kidText(item, 'name') ?? 'clip';
      if (item.tag === 'generatoritem') {
        if (titleText !== undefined) placed.push({ lane, name, src: '', url: '', kind: 'title', start, duration: end - start, sourceIn: 0, speed: 1, info: {}, text: titleText });
        else notes.add(`generator ${name}`);
        continue;
      }
      const fileRef = kid(item, 'file');
      const file = fileRef ? (files.get(fileRef.attrs.id ?? '') ?? fileRef) : undefined;
      const url = kidText(file, 'pathurl') ?? kidText(file, 'name') ?? name;
      const path = urlToPath(url);
      const fileMedia = kid(file, 'media');
      const hasVideo = fileMedia ? !!kid(fileMedia, 'video') : !audio;
      const hasAudio = fileMedia ? !!kid(fileMedia, 'audio') : audio;
      const fileDur = num(file, 'duration', 0) / (rateOf(file) ?? r);
      const kind: PlacedClip['kind'] = audio ? 'audio' : isImagePath(path) ? 'image' : 'video';
      placed.push({
        lane,
        name,
        src: path,
        url,
        kind,
        start,
        duration: end - start,
        sourceIn: inF / r,
        speed: Math.abs(speed),
        info: { duration: fileDur || undefined, hasVideo, hasAudio: hasAudio || isAudioPath(path) },
        gainDb,
      });
      if (speed < 0) notes.add(`reverse playback on ${name} (imported forward)`);
    }
  };

  kids(kid(media, 'video'), 'track').forEach((t, i) => walkTrack(t, i, false));
  kids(kid(media, 'audio'), 'track').forEach((t, i) => walkTrack(t, -1 - i, true));
  for (const t of transitions) applyTransition(placed, t);
  for (const c of placed) if (c.lane < 0) c.lane = -1 - c.lane;
  for (const mk of kids(seq, 'marker')) m.markers.push({ time: num(mk, 'in') / fps, label: kidText(mk, 'name') || kidText(mk, 'comment') || 'Marker' });
  m.duration = num(seq, 'duration') / fps;
  m.unsupported = [...notes];
  return finishModel(m, placed);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Writes Final Cut Pro 7 XML (xmeml v4) for Premiere Pro and other xmeml readers. */
export function toXMEML(m: TimelineModel): string {
  const tb = Math.round(m.fps);
  const ntsc = Math.abs(m.fps - tb) > 0.001 ? 'TRUE' : 'FALSE';
  const rate = `<rate><timebase>${tb}</timebase><ntsc>${ntsc}</ntsc></rate>`;
  const fr = (s: number) => Math.round(s * m.fps);
  const files = new Map<string, string>();
  let ids = 1;
  const fileXml = (c: TClip) => {
    const id = files.get(c.url);
    if (id) return `<file id="${id}"/>`;
    const nid = `file-${files.size + 1}`;
    files.set(c.url, nid);
    const hasVideo = c.kind !== 'audio';
    const hasAudio = c.kind === 'audio' || !!c.info.hasAudio;
    const dur = c.info.duration !== undefined ? `<duration>${fr(c.info.duration)}</duration>` : '';
    return `<file id="${nid}"><name>${esc(baseName(c.src))}</name><pathurl>${esc(c.url)}</pathurl>${rate}${dur}<media>${hasVideo ? '<video/>' : ''}${hasAudio ? '<audio/>' : ''}</media></file>`;
  };
  const speedFx = (c: TClip) =>
    c.speed !== 1 ? `<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><parameterid>speed</parameterid><name>speed</name><value>${+(c.speed * 100).toFixed(3)}</value></parameter><parameter><parameterid>variablespeed</parameterid><name>variablespeed</name><value>0</value></parameter></effect></filter>` : '';
  const levelFx = (c: TClip) =>
    c.gainDb ? `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name><value>${+Math.pow(10, c.gainDb / 20).toFixed(5)}</value></parameter></effect></filter>` : '';
  // Clips touching a transition keep their media under it (in/out include the overlap) and write
  // the touching edge as -1: the transition item defines it.
  const trackXml = (clips: TClip[], audio: boolean) => {
    let body = '';
    clips.forEach((c, i) => {
      const next = clips[i + 1];
      const joined = (x: TClip | undefined, prev: TClip | undefined) => !!x?.transitionIn && !!prev && Math.abs(prev.start + prev.duration - x.transitionIn.duration - x.start) < 1e-3;
      const hasIn = joined(c, clips[i - 1]);
      const hasOut = joined(next, c);
      if (hasIn) {
        body += `<transitionitem>${rate}<start>${fr(c.start)}</start><end>${fr(c.start + c.transitionIn!.duration)}</end><alignment>center</alignment>${audio ? '<effect><name>Cross Fade (+3dB)</name><effectid>KGAudioTransCrossFade3dB</effectid><effecttype>transition</effecttype><mediatype>audio</mediatype></effect>' : '<effect><name>Cross Dissolve</name><effectid>Cross Dissolve</effectid><effectcategory>Dissolve</effectcategory><effecttype>transition</effecttype><mediatype>video</mediatype></effect>'}</transitionitem>`;
      }
      if (c.kind === 'title') {
        body += `<generatoritem id="gen-${ids++}"><name>${esc(c.name)}</name><enabled>TRUE</enabled>${rate}<start>${fr(c.start)}</start><end>${fr(c.start + c.duration)}</end><in>0</in><out>${fr(c.duration)}</out><effect><name>Text</name><effectid>Text</effectid><effectcategory>Text</effectcategory><effecttype>generator</effecttype><mediatype>video</mediatype><parameter><parameterid>str</parameterid><name>Text</name><value>${esc(c.text ?? '')}</value></parameter></effect></generatoritem>`;
        return;
      }
      const srcIn = fr(c.sourceIn);
      const srcOut = srcIn + fr(c.duration * c.speed);
      body += `<clipitem id="clipitem-${ids++}"><name>${esc(c.name)}</name><enabled>TRUE</enabled>${rate}<start>${hasIn ? -1 : fr(c.start)}</start><end>${hasOut ? -1 : fr(c.start + c.duration)}</end><in>${srcIn}</in><out>${srcOut}</out>${fileXml(c)}${speedFx(c)}${audio ? levelFx(c) : ''}</clipitem>`;
    });
    return `<track>${body}<enabled>TRUE</enabled><locked>FALSE</locked></track>`;
  };
  // The sound of video clips goes on its own audio track per video track.
  const embedded = m.video.map((t) => t.clips.filter((c) => c.withAudio && c.kind === 'video').map((c) => ({ ...c, kind: 'audio' as const }))).filter((t) => t.length);
  const audioTracks = [...embedded, ...m.audio.map((t) => t.clips)];
  const markers = m.markers.map((mk) => `<marker><name>${esc(mk.label)}</name><comment></comment><in>${fr(mk.time)}</in><out>-1</out></marker>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>${esc(m.name)}</name>
    <duration>${fr(m.duration)}</duration>
    ${rate}
    <timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>
    <media>
      <video>
        <format><samplecharacteristics>${rate}<width>${m.width}</width><height>${m.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>
        ${m.video.map((t) => trackXml(t.clips, false)).join('\n        ')}
      </video>
      <audio>
        ${audioTracks.map((t) => trackXml(t, true)).join('\n        ')}
      </audio>
    </media>
    ${markers}
  </sequence>
</xmeml>
`;
}
