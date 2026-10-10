import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { audio, rect } from '@tasweerix/core';
import { nodeEnv } from '@tasweerix/media/node';
import { autoCut, beatGrid, beats, cutsToCode, matchLoudness, scenes, silenceCuts, snapToBeats, loudnessFollow, autoDuck } from '../src';

const dir = join(__dirname, '.tmp');
const env = nodeEnv(dir);
const ff = (...a: string[]) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a]);

beforeAll(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // "Speech": 1s tone, 1s silence, 1.5s tone, 0.8s silence, 1s tone.
  ff('-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*220*t)*(lt(t,1)+between(t,2,3.5)+gt(t,4.3))':d=5.3:s=48000", join(dir, 'talk.wav'));
  // 120 BPM click track.
  ff('-f', 'lavfi', '-i', "aevalsrc='sin(2*PI*1000*t)*exp(-mod(t,0.5)*60)':d=12:s=44100", join(dir, 'clicks.wav'));
  // Three distinct shots (test pattern, flat color, fractal).
  ff('-f', 'lavfi', '-i', 'testsrc2=s=160x90:d=1:r=25', '-f', 'lavfi', '-i', 'color=0x2040ff:s=160x90:d=1:r=25', '-f', 'lavfi', '-i', 'mandelbrot=s=160x90:r=25', '-filter_complex', '[2]trim=duration=1,setpts=PTS-STARTPTS[m];[0][1][m]concat=n=3:v=1', '-pix_fmt', 'yuv420p', join(dir, 'shots.mp4'));
  // Quiet tone at about -26 dBFS RMS.
  ff('-f', 'lavfi', '-i', "aevalsrc='0.07*sin(2*PI*997*t)':d=4:s=48000", join(dir, 'quiet.wav'));
});

describe('smart editing', () => {
  it('cuts out silences', async () => {
    const cuts = await silenceCuts('talk.wav', { threshold: -40, minSilence: 0.5, padding: 0.1 }, env);
    expect(cuts).toHaveLength(3);
    expect(cuts[0]!.in).toBe(0);
    expect(cuts[0]!.out).toBeCloseTo(1.1, 1);
    expect(cuts[1]!.in).toBeCloseTo(1.9, 1);
    expect(cuts[2]!.out).toBeCloseTo(5.3, 1);
    expect(cutsToCode('talk.wav', cuts)).toContain("video('talk.wav', { trim: [0, ");
    // cached on disk
    expect(readdirSync(join(dir, '.tasweerix', 'cache')).length).toBeGreaterThan(0);
    const seq = await autoCut('talk.wav', { minSilence: 0.5 }, env);
    expect(seq.children).toHaveLength(3);
  });
  it('detects tempo and builds beat grids', async () => {
    const b = await beats('clicks.wav', env);
    expect(b.bpm).toBeGreaterThan(117);
    expect(b.bpm).toBeLessThan(123);
    const bars = await beatGrid('clicks.wav', { every: 4 }, env);
    expect(bars[1]! - bars[0]!).toBeCloseTo(2, 1);
    const clips = [rect().lasting(1.3), rect().lasting(0.7), rect()];
    snapToBeats(clips, b.beats, { beatsPerItem: [2, 1, 4] });
    expect(clips[0]!.duration).toBeCloseTo(1, 1);
    expect(clips[1]!.duration).toBeCloseTo(0.5, 1);
    expect(clips[2]!.duration).toBeCloseTo(2, 1);
  });
  it('finds scene changes with ffmpeg', async () => {
    const s = await scenes('shots.mp4', { threshold: 0.3 }, env);
    expect(s).toHaveLength(2);
    expect(s[0]).toBeCloseTo(1, 1);
    expect(s[1]).toBeCloseTo(2, 1);
  });
  it('matches loudness and builds leveler automation', async () => {
    const [clip] = await matchLoudness([audio('quiet.wav')], -16, env);
    expect(clip!.gain as number).toBeGreaterThan(5);
    const tr = await loudnessFollow('quiet.wav', { target: -18 }, env);
    expect(tr.keys.length).toBeGreaterThan(3);
    expect(tr.at(2)).toBeGreaterThan(0);
  });
  it('wires up ducking through a voice bus', () => {
    const music = audio('m.mp3');
    const v = audio('v.wav');
    autoDuck(music, [v]);
    expect(v.bus).toBe('voice');
    expect(music.effects[0]!.kind).toBe('duck');
    expect(existsSync(dir)).toBe(true);
  });
});
