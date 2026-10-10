import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Env, SceneNode, Track } from '@tasweerix/core';
import { fromFCPXML, fromXMEML, timeMapAt, timelineToCode, timelineToNodes } from '../src';

const fixture = (f: string) => readFileSync(join(__dirname, 'fixtures', f), 'utf8');
const dir = join(__dirname, '.tmp');
mkdirSync(dir, { recursive: true });

const env: Env = { kind: 'none', probe: async () => ({ duration: 60, hasVideo: true, hasAudio: true, width: 1920, height: 1080, fps: 25 }) };
const prop = (n: SceneNode, k: string) => (n.props as Record<string, unknown>)[k];
const at = (v: unknown, t: number) => (v as Track<unknown>).at(t);

describe('timeline import: transforms and speed ramps', () => {
  it('reads FCPXML transforms, opacity, crop and keyframes', () => {
    const m = fromFCPXML(fixture('transforms.fcpxml'));
    const [pip, push, ramp] = m.video[0]!.clips;
    // FCPXML distances are percent of the frame height, y up, rotation counterclockwise.
    expect(pip!.transform).toEqual({ position: [216, -108], scale: [0.5, 0.5], rotation: -90, opacity: 0.8, crop: { left: 0.050625, right: 0, top: 0.05, bottom: 0 } });
    expect(push!.transform).toEqual({
      position: [
        { t: 4, v: [0, 0], ease: undefined },
        { t: 6, v: [-108, 0], ease: 'inOutSine' },
      ],
      scale: [1.5, 1.5],
    });
    expect(ramp).toMatchObject({ start: 8, duration: 4, sourceIn: 20, speed: 0.75 });
    expect(ramp!.timeMap).toEqual([
      { t: 8, v: 20 },
      { t: 10, v: 22 },
      { t: 12, v: 23 },
    ]);
    expect(m.unsupported).toContain('sound of variable-speed clip Ramp (imported silent)');
    expect(m.unsupported.join('\n')).not.toMatch(/adjust-transform|adjust-crop|adjust-blend|variable speed/);
  });

  it('reads Premiere (FCP7 XML) motion, opacity, crop, variable speed and reverse', () => {
    const m = fromXMEML(fixture('transforms.xml'));
    const [a, b, c] = m.video[0]!.clips;
    expect(a!.transform).toEqual({
      scale: [
        { t: 0, v: [1, 1] },
        { t: 2, v: [0.5, 0.5] },
      ],
      rotation: 30,
      position: [480, -270],
      opacity: 0.5,
      crop: { left: 0.1, right: 0, top: 0, bottom: 0 },
    });
    expect(b).toMatchObject({ start: 4, duration: 4, sourceIn: 0, speed: 0.75 });
    expect(b!.timeMap).toEqual([
      { t: 4, v: 0 },
      { t: 6, v: 2 },
      { t: 8, v: 3 },
    ]);
    expect(c!.timeMap).toEqual([
      { t: 8, v: 2 },
      { t: 10, v: 0 },
    ]);
    expect(m.unsupported).toEqual([]);
  });

  it('writes keyframes and remaps into code that typechecks and plays the same', async () => {
    const m = fromFCPXML(fixture('transforms.fcpxml'));
    const code = timelineToCode(m);
    expect(code).toContain("import { composition, keys, video } from 'tasweerix';");
    expect(code).toContain(
      "c.add(video('/Media/A.mov', { start: 0, trim: [10, 14], size: [1822.8, 1026], crop: { x: 97.2, y: 54, width: 1822.8, height: 1026 }, position: [1176, 432], anchor: [-48.6, -27], scale: 0.5, rotation: -90, opacity: 0.8 }));",
    );
    expect(code).toContain('position: keys([[0, [960, 540]], [2, [852, 540], \'inOutSine\']]), scale: 1.5');
    expect(code).toContain("c.add(video('/Media/A.mov', { start: 8, trim: [20, 23], duration: 4, muted: true, size: [1920, 1080] }).remap(keys([[0, 0], [2, 2], [4, 3]])));");
    const file = join(dir, 'transforms.ts');
    writeFileSync(file, code.replace("from 'tasweerix'", "from '../../../tasweerix/src/index'"));
    writeFileSync(join(dir, 'tsconfig.transforms.json'), JSON.stringify({ extends: '../../../../tsconfig.base.json', compilerOptions: { noEmit: true }, files: ['transforms.ts'], include: ['../../../*/src/**/*.d.ts'] }));
    execFileSync(process.execPath, [join(__dirname, '../../../node_modules/typescript/bin/tsc'), '-p', join(dir, 'tsconfig.transforms.json')]);
    const comp = await (await import(file)).default.create({ env });
    const [pip, push, ramp] = comp.root.children as SceneNode[];
    expect(prop(pip!, 'size')).toEqual([1822.8, 1026]);
    expect(at(prop(push!, 'position'), 1)).toEqual([906, 540]);
    expect(ramp!.timeRemap && at(ramp!.timeRemap, 3)).toBeCloseTo(2.5, 6);
  });

  it('builds nodes with positions relative to the imported group', () => {
    const m = fromFCPXML(fixture('transforms.fcpxml'));
    const { root } = timelineToNodes(m);
    const [pip, push, ramp] = root.children;
    expect(prop(pip!, 'position')).toEqual([216, -108]);
    expect(at(prop(push!, 'position'), 2)).toEqual([-108, 0]);
    expect(at(ramp!.timeRemap, 4)).toBe(3);
  });

  it('extends time maps along their end segments', () => {
    const map = [
      { t: 0, v: 10 },
      { t: 2, v: 12 },
      { t: 4, v: 13 },
    ];
    expect(timeMapAt(map, -1)).toBe(9);
    expect(timeMapAt(map, 3)).toBe(12.5);
    expect(timeMapAt(map, 6)).toBe(14);
  });
});
