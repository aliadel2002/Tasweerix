# Timeline import fixtures

- `otio-adapter.*` were written by OpenTimelineIO 0.18 and its adapter plugins (`otio-cmx3600-adapter`,
  `otio-fcp-adapter`, `otio-fcpx-xml-adapter`) from one 24 fps timeline, so the readers are checked
  against independent writers:
  V1 = a.mov [0–4 s, source 2 s], gap, b.mov [5–8 s, source 10 s], 1 s cross dissolve centred on the cut,
  c.mov [8–13 s, source 20 s], d.mov [13–15 s, source 1 s, 2× speed]; A1 = music.wav [1–9 s, source 5 s];
  marker "Hit" at 3 s. (The FCP adapters drop the dissolve or the speed; the tests account for that.)
- `final-cut.fcpxml` is hand written in the shape Final Cut Pro 10.6 exports: a 01:00:00:00 start,
  a connected title, a transition, a secondary storyline, a connected audio clip with volume, a
  compound clip (`ref-clip`) and a 50 % retime.
- `transforms.fcpxml` and `transforms.xml` are hand written in the shapes Final Cut Pro and Premiere
  Pro export for transforms (position, scale, rotation, anchor, keyframes), opacity, crop, variable
  speed ramps and reverse playback.
- `effects.fcpxml` and `effects.xml` add effects and color corrections (with keyframes), an effect
  without a Tasweerix counterpart, and multicam clips (FCPXML `mc-clip` with separate video and
  audio angles, FCP7 `multiclip`).
