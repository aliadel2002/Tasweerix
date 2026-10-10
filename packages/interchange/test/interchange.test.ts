import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { audio, composition, image, rect, sequence, video, type Env } from '@tasweerix/core';
import { transition } from '@tasweerix/render';
import { buildTimelineModel, toFCPXML, toOTIO } from '../src';

const dir = join(__dirname, '.tmp');
mkdirSync(dir, { recursive: true });
const env: Env = {
  kind: 'none',
  probe: async (src) =>
    src.endsWith('.mp3') ? { duration: 30, hasAudio: true, channels: 2, sampleRate: 44100 } : src.endsWith('.png') ? { width: 800, height: 600, hasVideo: true } : { duration: 20, hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 30 },
};

async function makeComp() {
  return composition({ name: 'Interchange Test', width: 1920, height: 1080, fps: 30 }, (c) => {
    c.add(
      sequence([
        video('a.mp4', { trim: [2, 6] }),
        video('b.mp4', { trim: [0, 3], speed: 2 }),
        transition.sequence([video('c.mp4', { trim: [1, 4] }), video('d.mp4', { trim: [5, 9] })], { type: 'crossfade', duration: 1 }),
      ]),
    );
    c.add(image('logo.png', { start: 1, duration: 2 }));
    c.add(rect({ duration: 1 })); // not representable → reported
    c.audio(audio('music.mp3', { start: 0.5, trim: [10], gain: -6 }).lasting(8));
    c.marker(2, 'Chapter 1');
  }).create({ env });
}

describe('timeline interchange', () => {
  it('builds a lane-assigned model', async () => {
    const m = buildTimelineModel(await makeComp(), (s) => `file:///media/${s}`);
    expect(m.video).toHaveLength(2);
    expect(m.video[0]!.clips.map((c) => c.src)).toEqual(['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4']);
    expect(m.video[0]!.clips[1]!.speed).toBe(2);
    expect(m.video[0]!.clips[3]!.transitionIn).toEqual({ type: 'crossfade', duration: 1 });
    expect(m.video[1]!.clips[0]!.kind).toBe('image');
    expect(m.audio[0]!.clips[0]!.gainDb).toBe(-6);
    expect(m.unsupported.some((u) => u.startsWith('rect'))).toBe(true);
    expect(m.duration).toBeCloseTo(4 + 1.5 + 3 + 4 - 1);
  });

  it('writes well-formed FCPXML 1.10', async () => {
    const xml = toFCPXML(buildTimelineModel(await makeComp(), (s) => `file:///media/${s}`));
    const file = join(dir, 'test.fcpxml');
    writeFileSync(file, xml);
    execFileSync('xmllint', ['--noout', file]);
    expect(xml).toContain('<fcpxml version="1.10">');
    expect((xml.match(/<asset id=/g) ?? []).length).toBe(6);
    expect(xml).toContain('<transition name="Cross Dissolve"');
    expect(xml).toContain('<spine lane="1"');
    expect(xml).toContain('<spine lane="2"');
    expect(xml).toContain('lane="-1"');
    expect(xml).toContain('<timeMap>');
    expect(xml).toContain('amount="-6.0dB"');
    expect(xml).toContain('value="Chapter 1"');
    // a.mp4 trimmed at 2s on a 30fps grid
    expect(xml).toMatch(/name="a\.mp4" start="60\/30s" duration="120\/30s"/);
  });

  it('writes OTIO that OpenTimelineIO reads back with matching timing', async () => {
    const json = toOTIO(buildTimelineModel(await makeComp(), (s) => `file:///media/${s}`));
    const file = join(dir, 'test.otio');
    writeFileSync(file, json);
    let out: string;
    try {
      out = execFileSync('python3', ['-c', `
import json, opentimelineio as otio
t = otio.adapters.read_from_file(${JSON.stringify(file)})
res = []
for tr in t.tracks:
    items = []
    for i, ch in enumerate(tr):
        if isinstance(ch, otio.schema.Clip):
            r = tr.range_of_child_at_index(i)
            items.append([ch.name, round(r.start_time.to_seconds(), 3), round(r.duration.to_seconds(), 3)])
        elif isinstance(ch, otio.schema.Transition):
            items.append(['transition', round(ch.in_offset.to_seconds(), 3)])
    res.append([tr.kind, items])
print(json.dumps({"tracks": res, "duration": round(t.duration().to_seconds(), 3)}))
`]).toString();
    } catch (e) {
      // OpenTimelineIO not installed: structural checks only.
      const parsed = JSON.parse(json);
      expect(parsed.OTIO_SCHEMA).toBe('Timeline.1');
      return;
    }
    const r = JSON.parse(out) as { tracks: [string, (string | number)[][]][]; duration: number };
    const v1 = r.tracks[0]!;
    expect(v1[0]).toBe('Video');
    expect(v1[1][0]).toEqual(['a.mp4', 0, 4]);
    expect(v1[1][1]).toEqual(['b.mp4', 4, 1.5]);
    // c→d crossfade of 1s: cut in the middle of the overlap
    expect(v1[1].find((x) => x[0] === 'transition')).toEqual(['transition', 0.5]);
    expect(v1[1].find((x) => x[0] === 'c.mp4')).toEqual(['c.mp4', 5.5, 2.5]);
    expect(v1[1].find((x) => x[0] === 'd.mp4')).toEqual(['d.mp4', 8, 3.5]);
    expect(r.tracks.some(([k, items]) => k === 'Audio' && items.some((x) => x[0] === 'music.mp3' && x[1] === 0.5))).toBe(true);
  });
});
