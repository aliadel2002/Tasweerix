import { resolveTransitions, type TimelineModel } from './model';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Frame duration as an FCPXML rational ("1/30s", "1001/30000s"). */
function frameDuration(fps: number): { num: number; den: number } {
  const ntsc = [23.976, 29.97, 59.94, 47.952, 119.88];
  const n = ntsc.find((x) => Math.abs(x - fps) < 0.01);
  if (n) return { num: 1001, den: Math.round(n * 1001) };
  return { num: 1, den: Math.round(fps) };
}

/**
 * Exports a timeline to FCPXML 1.10 (Final Cut Pro, DaVinci Resolve; Premiere via converters).
 * Layout: one gap in the primary storyline spanning the program; each video track is a connected
 * storyline (lane 1…n) with clips, gaps and cross-dissolves; audio tracks use negative lanes.
 */
export function toFCPXML(m: TimelineModel, opts: { eventName?: string; projectName?: string } = {}): string {
  const fd = frameDuration(m.fps);
  // Time on the frame grid as a rational string.
  const t = (sec: number) => {
    const frames = Math.round((sec * fd.den) / fd.num);
    return frames === 0 ? '0s' : `${frames * fd.num}/${fd.den}s`;
  };
  const assets = new Map<string, { id: string; clip: (typeof m.video)[number]['clips'][number] }>();
  let rid = 2;
  const assetFor = (c: (typeof m.video)[number]['clips'][number]) => {
    let a = assets.get(c.url);
    if (!a) {
      a = { id: `r${rid++}`, clip: c };
      assets.set(c.url, a);
    }
    return a.id;
  };
  let titles = 0;
  const clipXml = (c: (typeof m.video)[number]['clips'][number], offset: number, duration: number, sourceIn: number, lane?: number) => {
    const laneAttr = lane !== undefined ? ` lane="${lane}"` : '';
    if (c.kind === 'title') {
      const ts = `ts${++titles}`;
      return `<title ref="rTitle"${laneAttr} offset="${t(offset)}" name="${esc(c.name)}" start="0s" duration="${t(duration)}"><text><text-style ref="${ts}">${esc(c.text ?? c.name)}</text-style></text><text-style-def id="${ts}"><text-style font="Helvetica" fontSize="${Math.round(m.height / 13.5)}" fontColor="1 1 1 1" alignment="center"/></text-style-def></title>`;
    }
    const ref = assetFor(c);
    const role = c.kind === 'audio' ? ' audioRole="music"' : '';
    let inner = '';
    if (c.speed !== 1) {
      // timept times are in the clip's local time (which begins at `start`), values in source time.
      inner += `<timeMap><timept time="${t(sourceIn)}" value="${t(sourceIn)}" interp="linear"/><timept time="${t(sourceIn + duration)}" value="${t(sourceIn + duration * c.speed)}" interp="linear"/></timeMap>`;
    }
    if (c.gainDb !== undefined && c.gainDb !== 0) inner += `<adjust-volume amount="${c.gainDb.toFixed(1)}dB"/>`;
    const tag = c.kind === 'image' ? 'video' : 'asset-clip';
    if (tag === 'video') return `<video ref="${ref}"${laneAttr} offset="${t(offset)}" name="${esc(c.name)}" start="0s" duration="${t(duration)}">${inner}</video>`;
    return `<asset-clip ref="${ref}"${laneAttr} offset="${t(offset)}" name="${esc(c.name)}" start="${t(sourceIn)}" duration="${t(duration)}"${role}${c.kind === 'video' && !c.withAudio ? ' audioRole="none"' : ''}>${inner}</asset-clip>`;
  };

  const storylines: string[] = [];
  m.video.forEach((track, ti) => {
    const parts = resolveTransitions(track.clips);
    if (!parts.length) return;
    const first = parts[0]!.start;
    let cursor = first;
    let body = '';
    for (const p of parts) {
      if (p.start - cursor > 1e-6) body += `<gap name="Gap" offset="${t(cursor - first)}" start="0s" duration="${t(p.start - cursor)}"/>`;
      if (p.transition) body += `<transition name="Cross Dissolve" offset="${t(p.transition.at - first)}" duration="${t(p.transition.duration)}"/>`;
      body += clipXml(p.clip, p.start - first, p.duration, p.sourceIn);
      cursor = p.start + p.duration;
    }
    storylines.push(`<spine lane="${ti + 1}" offset="${t(first)}">${body}</spine>`);
  });
  m.audio.forEach((track, ti) => {
    for (const c of track.clips) storylines.push(clipXml(c, c.start, c.duration, c.sourceIn, -(ti + 1)));
  });
  const markers = m.markers.map((mk) => `<marker start="${t(mk.time)}" duration="${t(1 / m.fps)}" value="${esc(mk.label)}"/>`).join('');

  const resources = [`<format id="r1" name="FFVideoFormat${m.height}p${Math.round(m.fps)}" frameDuration="${fd.num}/${fd.den}s" width="${m.width}" height="${m.height}" colorSpace="1-1-1 (Rec. 709)"/>`];
  for (const { id, clip: c } of assets.values()) {
    const dur = c.info.duration ?? c.duration + c.sourceIn;
    const hasVideo = c.kind !== 'audio';
    const hasAudio = c.kind === 'audio' || !!c.info.hasAudio;
    resources.push(
      `<asset id="${id}" name="${esc(c.src.split('/').pop()!)}" start="0s" duration="${c.kind === 'image' ? '0s' : t(dur)}" hasVideo="${hasVideo ? 1 : 0}" hasAudio="${hasAudio ? 1 : 0}"${hasVideo ? ' format="r1" videoSources="1"' : ''}${hasAudio ? ` audioSources="1" audioChannels="${c.info.channels ?? 2}" audioRate="${c.info.sampleRate ?? 48000}"` : ''}><media-rep kind="original-media" src="${esc(c.url)}"/></asset>`,
    );
  }
  if (titles) resources.push(`<effect id="rTitle" name="Basic Title" uid=".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"/>`);
  const name = esc(opts.projectName ?? m.name ?? 'Tasweerix');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    ${resources.join('\n    ')}
  </resources>
  <library>
    <event name="${esc(opts.eventName ?? 'Tasweerix')}">
      <project name="${name}">
        <sequence format="r1" duration="${t(m.duration)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="${m.sampleRate >= 96000 ? '96k' : m.sampleRate >= 48000 ? '48k' : '44.1k'}">
          <spine>
            <gap name="Program" offset="0s" start="0s" duration="${t(m.duration)}">
              ${storylines.join('\n              ')}
              ${markers}
            </gap>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}
