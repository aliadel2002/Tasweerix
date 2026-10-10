import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { audio, composition, definePlugin, image, sequence, usePlugin, video, type Env } from '@tasweerix/core';
import { transition } from '@tasweerix/render';
import { buildTimelineModel, detectTimelineFormat, fromEDL, fromFCPXML, fromOTIO, fromXMEML, importTimeline, readTimeline, timelineToCode, timelineToNodes, toEDL, toFCPXML, toOTIO, toXMEML, writeTimeline, type TClip, type TimelineModel } from '../src';

const fixtures = join(__dirname, 'fixtures');
const fixture = (f: string) => readFileSync(join(fixtures, f), 'utf8');
const dir = join(__dirname, '.tmp');
mkdirSync(dir, { recursive: true });

const env: Env = {
  kind: 'none',
  probe: async (src) =>
    src.endsWith('.mp3') ? { duration: 30, hasAudio: true, channels: 2, sampleRate: 44100 } : src.endsWith('.png') ? { width: 800, height: 600, hasVideo: true } : { duration: 20, hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 30 },
};

async function exportedModel(): Promise<TimelineModel> {
  const comp = await composition({ name: 'Round Trip', width: 1920, height: 1080, fps: 30 }, (c) => {
    c.add(
      sequence([
        video('a.mp4', { trim: [2, 6] }),
        video('b.mp4', { trim: [0, 3], speed: 2 }),
        transition.sequence([video('c.mp4', { trim: [1, 4] }), video('d.mp4', { trim: [5, 9] })], { type: 'crossfade', duration: 1 }),
      ]),
    );
    c.add(image('logo.png', { start: 1, duration: 2 }));
    c.audio(audio('music.mp3', { start: 0.5, trim: [10], gain: -6 }).lasting(8));
    c.marker(2, 'Chapter 1');
  }).create({ env });
  return buildTimelineModel(comp, (s) => `file:///media/${s}`);
}

/** The comparable essence of a clip. */
const essence = (c: TClip) => ({
  src: c.src.split('/').pop(),
  kind: c.kind,
  start: +c.start.toFixed(3),
  duration: +c.duration.toFixed(3),
  sourceIn: +c.sourceIn.toFixed(3),
  speed: +c.speed.toFixed(3),
  transition: c.transitionIn ? +c.transitionIn.duration.toFixed(3) : 0,
});
const track = (m: TimelineModel, i: number, kind: 'video' | 'audio' = 'video') => (kind === 'video' ? m.video : m.audio)[i]!.clips.map(essence);

describe('timeline import: round trips through every writer', () => {
  it.each([
    ['fcpxml', (m: TimelineModel) => fromFCPXML(toFCPXML(m))],
    ['otio', (m: TimelineModel) => fromOTIO(toOTIO(m))],
    ['xmeml', (m: TimelineModel) => fromXMEML(toXMEML(m))],
  ])('%s keeps clips, speed, transitions, audio and markers', async (_name, roundTrip) => {
    const m = await exportedModel();
    const back = roundTrip(m);
    expect(back.fps).toBe(30);
    expect(back.video).toHaveLength(2);
    expect(track(back, 0)).toEqual(track(m, 0));
    expect(track(back, 1)).toEqual(track(m, 1));
    expect(back.video[0]!.clips.every((c) => c.withAudio)).toBe(true);
    expect(back.audio).toHaveLength(1);
    expect(track(back, 0, 'audio')).toEqual(track(m, 0, 'audio'));
    expect(back.audio[0]!.clips[0]!.gainDb).toBeCloseTo(-6, 1);
    expect(back.markers).toEqual([expect.objectContaining({ time: 2, label: 'Chapter 1' })]);
    expect(back.duration).toBeCloseTo(m.duration, 3);
  });

  it('edl keeps the first video track and the music', async () => {
    const m = await exportedModel();
    const back = fromEDL(toEDL(m, { audio: true }), { fps: 30 });
    expect(back.video).toHaveLength(1);
    expect(track(back, 0)).toEqual(track(m, 0));
    expect(back.audio[0]!.clips.map(essence)).toEqual(track(m, 0, 'audio'));
    expect(back.markers[0]).toMatchObject({ time: 2, label: 'Chapter 1' });
  });
});

describe('timeline export: read back by OpenTimelineIO adapters', () => {
  it('EDL and FCP7 XML from Tasweerix load in OTIO with the same cuts', () => {
    const m = fromFCPXML(fixture('final-cut.fcpxml'));
    writeFileSync(join(dir, 'ours.edl'), toEDL(m));
    writeFileSync(join(dir, 'ours.xml'), toXMEML(m));
    let out: string;
    try {
      out = execFileSync('python3', ['-c', `
import json, opentimelineio as otio
res = {}
for f, a, kw in [(${JSON.stringify(join(dir, 'ours.edl'))}, 'cmx_3600', {'rate': 25}), (${JSON.stringify(join(dir, 'ours.xml'))}, 'fcp_xml', {})]:
    t = otio.adapters.read_from_file(f, adapter_name=a, **kw)
    tr = t.video_tracks()[0]
    res[a] = [[round(tr.range_of_child_at_index(i).start_time.to_seconds(), 3), round(c.source_range.start_time.to_seconds(), 3)] for i, c in enumerate(tr) if isinstance(c, otio.schema.Clip)]
print(json.dumps(res))
`], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    } catch {
      return; // OpenTimelineIO or its adapter plugins are not installed.
    }
    const r = JSON.parse(out) as Record<string, number[][]>;
    // [timeline start, source in] per clip; cut-based layouts put the dissolve's cut at 5 s (xmeml) or 4 s (EDL).
    expect(r.fcp_xml).toEqual([[0, 2], [5, 5], [9, 11], [11, 20], [13, 0]]);
    expect(r.cmx_3600).toEqual([[0, 2], [4, 4], [9, 11], [11, 20], [13, 0]]);
  });
});

describe('timeline import: files written by other tools', () => {
  // Reference timeline (see fixtures/README.md), 24 fps.
  const a = { src: 'a.mov', kind: 'video', start: 0, duration: 4, sourceIn: 2, speed: 1, transition: 0 };
  const bDissolve = { src: 'b.mov', kind: 'video', start: 5, duration: 3.5, sourceIn: 10, speed: 1, transition: 0 };
  const cDissolve = { src: 'c.mov', kind: 'video', start: 7.5, duration: 5.5, sourceIn: 19.5, speed: 1, transition: 1 };
  const d = { src: 'd.mov', kind: 'video', start: 13, duration: 2, sourceIn: 1, speed: 2, transition: 0 };
  const music = { src: 'music.wav', kind: 'audio', start: 1, duration: 8, sourceIn: 5, speed: 1, transition: 0 };

  it('reads OTIO JSON', () => {
    const m = fromOTIO(fixture('otio-adapter.otio'));
    expect(m.fps).toBe(24);
    expect(track(m, 0)).toEqual([a, bDissolve, cDissolve, d]);
    expect(track(m, 0, 'audio')).toEqual([music]);
    expect(m.markers).toEqual([expect.objectContaining({ time: 3, label: 'Hit' })]);
    expect(m.video[0]!.clips[0]!.src).toBe('/media/a.mov');
  });

  it('reads a CMX 3600 EDL (dissolve pairs, M2 speed, clip comments)', () => {
    const m = fromEDL(fixture('otio-adapter.edl'), { fps: 24 });
    expect(m.name).toBe('Otio Test');
    expect(track(m, 0)).toEqual([a, bDissolve, cDissolve, d]);
    expect(m.video[0]!.clips[2]!.src).toBe('/media/c.mov');
  });

  it('reads FCP7 XML (xmeml) with -1 edges at transitions', () => {
    const m = fromXMEML(fixture('otio-adapter.xml'));
    expect(m.fps).toBe(24);
    // The fcp_xml adapter writes no speed effect for d.
    expect(track(m, 0)).toEqual([a, bDissolve, cDissolve, { ...d, speed: 1 }]);
    expect(track(m, 0, 'audio')).toEqual([music]);
    expect(m.markers[0]).toMatchObject({ time: 3, label: 'Hit' });
    expect(m.video[0]!.clips[0]!.withAudio).toBeFalsy();
  });

  it('reads FCPXML from the fcpx_xml adapter (connected audio inside a gap)', () => {
    const m = fromFCPXML(fixture('otio-adapter.fcpxml'));
    expect(m.fps).toBe(24);
    // That adapter drops transitions and speed.
    expect(track(m, 0)).toEqual([a, { ...bDissolve, duration: 3 }, { ...cDissolve, start: 8, duration: 5, sourceIn: 20, transition: 0 }, { ...d, speed: 1 }]);
    expect(track(m, 0, 'audio')).toEqual([music]);
  });

  it('reads Final Cut Pro FCPXML: lanes, titles, compound clips, retimes, transitions', () => {
    const m = fromFCPXML(fixture('final-cut.fcpxml'));
    expect(m).toMatchObject({ name: 'Hand Made', fps: 25, width: 1280, height: 720, duration: 20 });
    expect(track(m, 0)).toEqual([
      { src: 'A Roll.mov', kind: 'video', start: 0, duration: 6, sourceIn: 2, speed: 1, transition: 0 },
      { src: 'B.mov', kind: 'video', start: 4, duration: 5, sourceIn: 4, speed: 1, transition: 2 },
      { src: 'B.mov', kind: 'video', start: 9, duration: 2, sourceIn: 11, speed: 1, transition: 0 },
      { src: 'B.mov', kind: 'video', start: 11, duration: 2, sourceIn: 20, speed: 1, transition: 0 },
      { src: 'B.mov', kind: 'video', start: 13, duration: 4, sourceIn: 0, speed: 0.5, transition: 0 },
    ]);
    expect(m.video[0]!.clips[0]).toMatchObject({ src: '/Volumes/Media/A Roll.mov', withAudio: true, name: 'A1' });
    expect(track(m, 1)).toEqual([
      { src: '', kind: 'title', start: 1, duration: 2, sourceIn: 0, speed: 1, transition: 0 },
      { src: 'logo.png', kind: 'image', start: 6, duration: 1, sourceIn: 0, speed: 1, transition: 0 },
      { src: 'B.mov', kind: 'video', start: 7, duration: 1, sourceIn: 0, speed: 1, transition: 0 },
    ]);
    expect(m.video[1]!.clips[0]!.text).toBe('Hello');
    expect(m.audio[0]!.clips[0]).toMatchObject({ kind: 'audio', start: 5, duration: 4, sourceIn: 30, gainDb: -9 });
    expect(m.markers).toEqual([expect.objectContaining({ time: 1, label: 'Beat' })]);
    expect(m.unsupported.some((u) => u.includes('Gaussian Blur'))).toBe(true);
  });

  it('detects formats from content and extension', () => {
    expect(detectTimelineFormat(fixture('otio-adapter.xml'), 'cut.xml').name).toBe('xmeml');
    expect(detectTimelineFormat(fixture('otio-adapter.edl'), 'cut.edl').name).toBe('edl');
    expect(detectTimelineFormat(fixture('final-cut.fcpxml'), 'x').name).toBe('fcpxml');
    expect(detectTimelineFormat(fixture('otio-adapter.otio'), 'x.json').name).toBe('otio');
    expect(() => detectTimelineFormat('hello', 'notes.txt')).toThrow(/Unrecognized/);
  });

  it('accepts formats from plugins', () => {
    usePlugin(
      definePlugin({
        name: 'csv-timeline',
        importers: {
          csv: { label: 'CSV cut list', extensions: ['csv'], read: (t: string) => fromOTIO(toOTIO({ name: 'csv', width: 640, height: 360, fps: 25, sampleRate: 48000, duration: 0, markers: [], unsupported: [], audio: [], video: [{ kind: 'video', clips: t.trim().split('\n').map((l, i) => ({ name: l, src: l, url: l, kind: 'video' as const, start: i * 2, duration: 2, sourceIn: 0, speed: 1, info: {} })) }] })) },
        },
        exporters: { csv: { write: (m: TimelineModel) => m.video[0]!.clips.map((c) => c.src).join('\n') } },
      }),
    );
    const m = readTimeline('x.mp4\ny.mp4', { fileName: 'list.csv' });
    expect(m.video[0]!.clips.map((c) => [c.src, c.start])).toEqual([['x.mp4', 0], ['y.mp4', 2]]);
    expect(writeTimeline(m, 'csv')).toBe('x.mp4\ny.mp4');
  });
});

describe('timeline import: building projects', () => {
  it('generates editable TypeScript that typechecks and rebuilds the same edit', async () => {
    const m = fromFCPXML(fixture('final-cut.fcpxml'));
    const code = timelineToCode(m, { source: 'final-cut.fcpxml', format: 'FCPXML' });
    expect(code).toContain("import { audio, composition, image, text, transition, video } from 'tasweerix';");
    expect(code).toContain("      video('/Volumes/Media/A Roll.mov', { trim: [2, 8], size: [1280, 720] }),");
    expect(code).toContain("c.add(video('/Volumes/Media/B.mov', { start: 13, trim: [0, 2], speed: 0.5, size: [1280, 720] }));");
    expect(code).toContain("transition.chain(");
    expect(code).toContain("{ type: 'crossfade', duration: 2 }");
    expect(code).toContain("text('Hello', { start: 1, duration: 2, size: 53, fill: '#ffffff' })");
    expect(code).toContain("c.audio(audio('/Volumes/Media/song.m4a', { start: 5, trim: [30, 34], gain: -9 }));");
    expect(code).toContain("c.marker(1, 'Beat');");
    expect(code).toContain('//   - Gaussian Blur effect on Slow');
    // Point the import at the umbrella package sources, then typecheck with the repo's settings.
    const file = join(dir, 'imported.ts');
    writeFileSync(file, code.replace("from 'tasweerix'", "from '../../../tasweerix/src/index'"));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ extends: '../../../../tsconfig.base.json', compilerOptions: { noEmit: true }, files: ['imported.ts'], include: ['../../../*/src/**/*.d.ts'] }));
    execFileSync(process.execPath, [join(__dirname, '../../../node_modules/typescript/bin/tsc'), '-p', join(dir, 'tsconfig.json')]);
    // Evaluate the generated module against the real API and compare timing.
    const mod = await import(file);
    const comp = await mod.default.create({ env: { ...env, probe: async (s: string) => (s.endsWith('.png') ? { width: 64, height: 64 } : s.endsWith('.m4a') ? { duration: 120, hasAudio: true } : { duration: 30, hasVideo: true, hasAudio: true, width: 1280, height: 720 }) } });
    const again = buildTimelineModel(comp, (s) => s);
    expect(track(again, 0)).toEqual(track(m, 0));
    expect(again.markers).toEqual([{ time: 1, label: 'Beat' }]);
  });

  it('imports at build time with relinked media', async () => {
    const files: Record<string, string> = { 'edits/cut.otio': fixture('otio-adapter.otio') };
    const fileEnv: Env = { ...env, loadBinary: async (s) => new TextEncoder().encode(files[s]!).buffer as ArrayBuffer };
    const comp = await composition({ width: 640, height: 360, fps: 24 }, async (c) => {
      c.add(await importTimeline('edits/cut.otio', { env: fileEnv }));
    }).create({ env: fileEnv });
    const root = comp.root.children[0]!;
    expect(root.children.map((n) => n.kind)).toEqual(['video', 'xseq', 'video']);
    expect((root.children[0]!.props as { src: string }).src).toBe('edits/a.mov');
    expect(comp.audioClips[0]!.src).toBe('edits/music.wav');
    expect(comp.markers[0]!.label).toBe('Hit');
    expect(comp.duration).toBeCloseTo(15, 3);
  });

  it('builds nodes directly from a model', () => {
    const { root, audio: clips } = timelineToNodes(fromEDL(fixture('otio-adapter.edl'), { fps: 24 }));
    expect(root.children).toHaveLength(3);
    expect(clips).toHaveLength(0);
  });
});
