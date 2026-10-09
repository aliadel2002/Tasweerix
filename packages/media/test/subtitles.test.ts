import { describe, expect, it } from 'vitest';
import { captions, parseSubtitles, toSrt, toVtt } from '../src/subtitles';

const SRT = `1
00:00:01,000 --> 00:00:02,500
Hello <b>world</b>

2
00:00:03,000 --> 00:00:04,000
Second line
two`;

describe('subtitles', () => {
  it('parses and round-trips SRT and VTT', () => {
    const cues = parseSubtitles(SRT);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 1, end: 2.5, text: 'Hello world' });
    expect(cues[1]!.text).toBe('Second line\ntwo');
    expect(parseSubtitles(toSrt(cues))).toEqual(cues);
    expect(parseSubtitles(toVtt(cues))).toEqual(cues);
  });
  it('builds timed caption nodes', () => {
    const g = captions(parseSubtitles(SRT));
    expect(g.children).toHaveLength(2);
    expect(g.children[1]!.start).toBe(3);
    expect(g.children[1]!.effectiveDuration()).toBe(1);
  });
});
