import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Env, SceneNode, Track } from '@tasweerix/core';
import { fromFCPXML, fromOTIO, fromXMEML, mapEffect, timelineToCode, timelineToNodes } from '../src';

const fixture = (f: string) => readFileSync(join(__dirname, 'fixtures', f), 'utf8');
const dir = join(__dirname, '.tmp');
mkdirSync(dir, { recursive: true });
const env: Env = { kind: 'none', probe: async (s) => (s.endsWith('.wav') ? { duration: 60, hasAudio: true } : { duration: 60, hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 25 }) };

describe('timeline import: effects, color corrections and multicam', () => {
  it('reads FCPXML effects and color corrections, keyframes included', () => {
    const m = fromFCPXML(fixture('effects.fcpxml'));
    const [graded, , soft] = m.video[0]!.clips;
    expect(graded!.effects).toEqual([
      {
        kind: 'grade',
        params: {
          exposure: 0.2,
          saturation: -0.5,
          temperature: [
            { t: 0, v: 0 },
            { t: 4, v: 0.3 },
          ],
        },
      },
      { kind: 'grayscale', params: {} },
    ]);
    // The effect name can come from the resource when the filter has none.
    expect(soft!.effects).toEqual([{ kind: 'blur', params: { radius: 12 } }]);
    expect(m.unsupported).toEqual(['Color Adjustments effect on Graded (approximated with fx.grade, check the look)', 'Prism effect on Graded', '1 inactive angle of multicam Interview MC (only the active angles are imported)']);
  });

  it('flattens an FCPXML multicam clip to its active video and audio angles', () => {
    const m = fromFCPXML(fixture('effects.fcpxml'));
    expect(m.video[0]!.clips[1]).toMatchObject({ src: '/Media/Close.mov', kind: 'video', start: 4, duration: 4, sourceIn: 3, withAudio: false });
    expect(m.audio[0]!.clips).toEqual([expect.objectContaining({ src: '/Media/Lav.wav', kind: 'audio', start: 4, duration: 4, sourceIn: 5 })]);
  });

  it('reads FCP7 XML filters and the active multiclip angle', () => {
    const m = fromXMEML(fixture('effects.xml'));
    const [a, interview] = m.video[0]!.clips;
    expect(a!.effects).toEqual([
      {
        kind: 'blur',
        params: {
          radius: [
            { t: 0, v: 0 },
            { t: 2, v: 20 },
          ],
        },
      },
      { kind: 'grade', params: { brightness: 0.1, contrast: -0.2 } },
    ]);
    expect(interview).toMatchObject({ src: '/media/close.mov', start: 4, duration: 4, sourceIn: 1 });
    expect(m.unsupported).toEqual(['Earthquake effect on a.mov', '1 inactive angle of multicam Interview (only the active angle is imported)']);
  });

  it('reads OTIO effects from their metadata', () => {
    const otio = {
      OTIO_SCHEMA: 'Timeline.1',
      name: 'fx',
      global_start_time: { OTIO_SCHEMA: 'RationalTime.1', rate: 24, value: 0 },
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            kind: 'Video',
            children: [
              {
                OTIO_SCHEMA: 'Clip.2',
                name: 'a',
                source_range: { OTIO_SCHEMA: 'TimeRange.1', start_time: { OTIO_SCHEMA: 'RationalTime.1', rate: 24, value: 0 }, duration: { OTIO_SCHEMA: 'RationalTime.1', rate: 24, value: 48 } },
                media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url: 'file:///m/a.mov' },
                effects: [{ OTIO_SCHEMA: 'Effect.1', effect_name: 'Gaussian Blur', metadata: { Resolve: { Radius: 6 } } }],
              },
            ],
          },
        ],
      },
    };
    expect(fromOTIO(JSON.stringify(otio)).video[0]!.clips[0]!.effects).toEqual([{ kind: 'blur', params: { radius: 6 } }]);
  });

  it('maps common effect names', () => {
    const none = () => undefined;
    expect(mapEffect('Sepia', none)?.effect.kind).toBe('sepia');
    expect(mapEffect('Ultra Key', none)?.effect.kind).toBe('chromaKey');
    expect(mapEffect('Proc Amp', (...n) => (n.includes('chroma') ? 150 : undefined))?.effect).toEqual({ kind: 'grade', params: { saturation: 0.5 } });
    expect(mapEffect('Lens Flare', none)).toBeNull();
  });

  it('writes filters into code that typechecks and builds them', async () => {
    const m = fromFCPXML(fixture('effects.fcpxml'));
    const code = timelineToCode(m);
    expect(code).toContain("import { audio, composition, fx, keys, video } from 'tasweerix';");
    expect(code).toContain("filters: [fx.grade({ exposure: 0.2, saturation: -0.5, temperature: keys([[0, 0], [4, 0.3]]) }), fx.grayscale()]");
    expect(code).toContain("c.audio(audio('/Media/Lav.wav', { start: 4, trim: [5, 9] }));");
    const file = join(dir, 'effects.ts');
    writeFileSync(file, code.replace("from 'tasweerix'", "from '../../../tasweerix/src/index'"));
    writeFileSync(join(dir, 'tsconfig.effects.json'), JSON.stringify({ extends: '../../../../tsconfig.base.json', compilerOptions: { noEmit: true }, files: ['effects.ts'], include: ['../../../*/src/**/*.d.ts'] }));
    execFileSync(process.execPath, [join(__dirname, '../../../node_modules/typescript/bin/tsc'), '-p', join(dir, 'tsconfig.effects.json')]);
    const comp = await (await import(file)).default.create({ env });
    const graded = comp.root.children[0] as SceneNode;
    expect(graded.filters.map((f) => f.kind)).toEqual(['grade', 'grayscale']);
    expect((graded.filters[0]!.params.temperature as Track<number>).at(2)).toBeCloseTo(0.15, 6);
    // Nodes built directly carry the same filters.
    const { root } = timelineToNodes(m);
    expect(root.children[2]!.filters).toEqual([{ kind: 'blur', params: { radius: 12 } }]);
  });
});
