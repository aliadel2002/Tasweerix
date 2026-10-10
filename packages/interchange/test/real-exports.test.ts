import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromFCPXML, fromXMEML, readTimeline, timelineToNodes, type TClip, type TimelineModel } from '../src';

// Timelines exported by Final Cut Pro, Premiere Pro and Nuke Studio (see fixtures/real/README.md).
const real = join(__dirname, 'fixtures/real');
const read = (dir: string, f: string) => readFileSync(join(real, dir, f), 'utf8');
const fcp = (f: string) => fromFCPXML(read('final-cut-pro', f));
const premiere = (f: string) => fromXMEML(read('premiere', f));

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** Track clips as [name, start, duration, source in, speed] (seconds, rounded to ms). */
const layout = (clips: TClip[]) => clips.map((c) => [c.name, r3(c.start), r3(c.duration), r3(c.sourceIn), r3(c.speed)]);
const all = (m: TimelineModel) => [...m.video, ...m.audio].flatMap((t) => t.clips);

interface ExpectedMarker {
  label: string;
  timecode: string;
  time: number;
  hidden?: string;
}
const expected = JSON.parse(read('final-cut-pro', 'markers.json')) as { files: Record<string, { complete: boolean; markers: ExpectedMarker[] }> };

describe('Final Cut Pro exports: timing against Final Cut itself', () => {
  // Markers sit inside clips, so their timeline positions check the whole chain: offsets, trims,
  // timecode starts, retimes, rate conforms, storylines, compound clips, auditions and transitions.
  it.each(Object.keys(expected.files))('%s: markers land where Final Cut shows them', (file) => {
    const { complete, markers } = expected.files[file]!;
    const m = fcp(file);
    const frame = 1 / m.fps;
    const left = [...m.markers];
    for (const e of markers.filter((x) => !x.hidden)) {
      const i = left.findIndex((x) => x.label === e.label && Math.abs(x.time - e.time) < frame);
      expect(i, `${e.label} at ${e.timecode} (got ${m.markers.filter((x) => x.label === e.label).map((x) => r3(x.time))})`).toBeGreaterThanOrEqual(0);
      // Final Cut lists positions to 1/80 frame.
      expect(Math.abs(left[i]!.time - e.time)).toBeLessThan(frame / 40);
      left.splice(i, 1);
    }
    // Markers Final Cut hides (trimmed off, inactive audition picks) stay out.
    if (complete) expect(left.map((x) => x.label)).toEqual([]);
  });

  it('plays 25 fps media at 24 in a 24 fps project and 23.98 media at 24', () => {
    const m = fcp('24With25Media.fcpxml');
    expect(m.video[0]!.clips.map((c) => r3(c.speed))).toEqual([0.96, 0.96]);
    const ntsc = fcp('24.fcpxml').video[0]!.clips[0]!;
    expect(ntsc.speed).toBeCloseTo(1.001, 6);
  });

  it('keeps clip positions of a timeline that starts at 00:59:50:00', () => {
    // The sync clip sits at 01:01:18:03 in Final Cut, 88.12 s after the sequence start.
    const m = fcp('SyncClipRoles2.fcpxml');
    expect(Math.min(...all(m).filter((c) => c.kind === 'video').map((c) => c.start))).toBeCloseTo(88.12, 3);
    expect(m.markers).toEqual([expect.objectContaining({ label: 'Marker 1', time: expect.closeTo(88.12, 3) })]);
  });

  it('reads clips that sit outside the visible window of a compound clip', () => {
    const m = fcp('Occlusion.fcpxml');
    expect(layout(m.video[0]!.clips)).toEqual([
      ['Basic Title 1', 0, 30, 0, 1],
      ['Basic Title 2', 40, 10, 0, 1],
      ['Basic Title 3', 60, 30, 0, 1],
      ['Basic Title 4', 100, 10, 10, 1],
    ]);
  });

  it('imports the active audition pick only', () => {
    const m = fcp('AuditionMarkers3.fcpxml');
    expect(m.video[0]!.clips.map((c) => c.name)).toEqual(['TestVideo', 'TestVideo2']);
    expect(m.unsupported).toContain('1 alternative of audition TestVideo2 (only the active pick is imported)');
  });

  it('turns a transition at the head of the timeline into a fade-in', () => {
    const m = fcp('24.fcpxml');
    expect(m.video[0]!.clips[0]!.transform?.opacity).toEqual([
      { t: 0, v: 0 },
      { t: expect.closeTo(11.917, 3), v: 1 },
    ]);
  });

  it('imports a clip exported on its own (no project) as a one-clip timeline', () => {
    const m = fcp('StandaloneAssetClip.fcpxml');
    expect(m).toMatchObject({ name: 'TestVideo', fps: 29.97, width: 640, height: 360 });
    expect(layout(m.video[0]!.clips)).toEqual([['TestVideo', 0, 10.01, 0, 1]]);
    const compound = fcp('StandaloneLibraryEventClip.fcpxml');
    expect(compound.video[0]!.clips).toHaveLength(5);
    expect(compound.markers).toHaveLength(10);
  });

  it('names generators and leaves no-op HDR conforms alone', () => {
    expect(fcp('CompoundClips.fcpxml').unsupported).toEqual(['generator Clouds']);
    expect(fcp('Keywords.fcpxml').unsupported).toEqual([]);
  });

  it('matches OpenTimelineIO on a Final Cut Pro 10.4 project (FCPXML 1.8)', () => {
    // Clips as read by the otio-fcpx-xml-adapter (OpenTimelineIO 0.18) from the same file.
    const m = fcp('fcp-10.4-project.fcpxml');
    const v = all(m).filter((c) => c.kind === 'video').map((c) => [c.name, r3(c.start), r3(c.duration), r3(c.sourceIn)]);
    for (const clip of [
      ['IMG_0715', 0, 10, 0],
      ['IMG_0513', 20, 10, 0],
      // Runs on under the dissolve that follows (OTIO cuts at its middle, 59.5 s).
      ['IMG_0268', 50, 10, 0],
      ['IMG_0857', 64.567, 10, 0],
      ['IMG_0233', 110, 10, 0],
      ['IMG_0687', 120, 10, 12.533],
      ['IMG_0268', 130, 10, 7.733],
    ]) {
      expect(v).toContainEqual(clip);
    }
    // The dissolve between IMG_0268 and IMG_0740 (OTIO: a cut at 59.5 s with 0.5 s of IMG_0740 used).
    const dissolve = all(m).find((c) => c.name === 'IMG_0740')!;
    expect([r3(dissolve.start), r3(dissolve.duration), r3(dissolve.sourceIn), dissolve.transitionIn?.duration]).toEqual([59, 10, 0, 1]);
    const audio = all(m).filter((c) => c.kind === 'audio').map((c) => [c.name, r3(c.start), r3(c.duration)]);
    expect(audio).toContainEqual(['IMG_0233', 115, 5]);
    expect(audio).toContainEqual(['IMG_0687', 40, 10]);
  });
});

describe('Premiere Pro and Nuke Studio exports (FCP7 XML)', () => {
  it('places items by the sequence rate and trims by the clip rate', () => {
    const m = premiere('premiere_example.xml');
    expect(m).toMatchObject({ name: 'sc01_sh010_layerA', fps: 30, width: 1280, height: 720 });
    const v = all(m).filter((c) => c.kind === 'video');
    // A 15 fps clip on a 30 fps sequence: start 536 / 30, in / out 0 – 50 at 15 fps.
    expect(layout(v.filter((c) => c.start > 17 && c.start < 18))).toEqual([['sc01_sh010_anim.mov', 17.867, 3.333, 0, 1]]);
    expect(v.find((c) => c.name === 'sc01_sh010_anim.mov')!.src).toBe('D:/media/sc01_sh010_anim.mov');
  });

  it('flattens nested sequences into the timeline', () => {
    const m = premiere('premiere_example.xml');
    const nested = all(m).filter((c) => c.kind === 'video' && c.start >= 21.2 - 1e-3 && c.start < 31.8);
    expect(layout(nested)).toEqual([
      ['sc01_sh010_anim.mov', 21.2, 3.333, 0, 1],
      ['sc01_sh030_anim.mov', 24.533, 7.333, 0, 1],
    ]);
  });

  it('reads a stereo clip on exploded tracks once, and a dissolve between overlapping clips', () => {
    const m = premiere('premiere_example.xml');
    const music = all(m).filter((c) => c.name === 'track_08.wav');
    expect(layout(music)).toEqual([['track_08.wav', 5.1, 6.6, 0, 1]]);
    const b = all(m).find((c) => c.kind === 'video' && c.name === 'sc01_sh010_anim.mov' && c.transitionIn)!;
    expect([r3(b.start), r3(b.transitionIn!.duration)]).toEqual([38.4, 0.833]);
  });

  it('fades to black at an end-black transition and notes slugs', () => {
    const m = premiere('premiere_example.xml');
    const tail = all(m).find((c) => c.name === 'sc01_sh030_anim.mov' && r3(c.start) === 10.733)!;
    expect(tail.transform?.opacity).toEqual([
      { t: expect.closeTo(17.933, 3), v: 1 },
      { t: expect.closeTo(18.567, 3), v: 0 },
    ]);
    expect(m.unsupported).toEqual(['Slug test_title']);
  });

  it('skips generated media (bars, slugs, mattes) with a note', () => {
    const m = premiere('premiere_generators.xml');
    expect(all(m)).toEqual([]);
    expect(m.unsupported).toEqual(['Slug Universal Counting Leader', 'Slug Black Video', 'generator Blue Matte', 'Slug HD Bars and Tone', 'Slug Transparent Video', 'GraphicAndType Graphic']);
  });

  it('leaves out disabled clips', () => {
    const m = premiere('premiere_enable_property.xml');
    expect(all(m).some((c) => /disabled/.test(c.name))).toBe(false);
    expect(layout(m.video[0]!.clips).map((c) => c.slice(0, 3))).toEqual([
      ['source.mp4', 0, 3.24],
      ['source3.mp4', 7.08, 1.72],
    ]);
  });

  it('reads a Nuke Studio export and skips its offline clip', () => {
    const m = premiere('nuke-studio-export.xml');
    expect(layout(all(m))).toEqual([['A160C005_171213_R0MN', 0.583, 43.958, 0, 1]]);
    expect(m.unsupported).toEqual(['offline clip / (no media file)']);
  });
});

describe('every real export imports into a valid timeline', () => {
  const files = [...readdirSync(join(real, 'final-cut-pro')).filter((f) => f.endsWith('.fcpxml')).map((f) => `final-cut-pro/${f}`), ...readdirSync(join(real, 'premiere')).map((f) => `premiere/${f}`)];
  it.each(files)('%s', (path) => {
    const [dir, file] = path.split('/') as [string, string];
    const m = readTimeline(read(dir, file), { fileName: file });
    const frame = 1 / m.fps;
    for (const c of all(m)) {
      expect(c.duration, c.name).toBeGreaterThan(0);
      expect(c.start, c.name).toBeGreaterThanOrEqual(-frame);
      expect(c.start + c.duration, c.name).toBeLessThanOrEqual(m.duration + frame);
      if (c.kind !== 'title') expect(c.sourceIn, c.name).toBeGreaterThanOrEqual(-frame);
      expect(Number.isFinite(c.speed) && c.speed > 0, c.name).toBe(true);
    }
    for (const mk of m.markers) expect(mk.time).toBeGreaterThanOrEqual(0);
    expect(() => timelineToNodes(m)).not.toThrow();
  });
});
