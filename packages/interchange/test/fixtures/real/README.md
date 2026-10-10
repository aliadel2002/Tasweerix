# Real timeline exports

Files written by the editors themselves, unchanged, so the readers are tested against what
Final Cut Pro, Premiere Pro and Nuke Studio actually produce rather than hand-written samples.

## final-cut-pro/

- `*.fcpxml` other than `fcp-10.4-*`: exports from Final Cut Pro 10.5 – 11 (FCPXML 1.9 – 1.13),
  from the [swift-fcpxml](https://github.com/orchetect/swift-fcpxml) test resources
  (`Tests/SwiftFCPXMLTests/TestResource/FCPXML Exports`, commit `00bcacf`), MIT licensed
  (`LICENSE-swift-fcpxml.txt`). They cover every common frame rate (23.98 – 60, 25i, drop frame),
  media at another rate than the project (conformed 23.98 → 24 and 25 → 24), retimes, transitions,
  storylines, compound, sync and multicam clips, auditions, disabled clips, generators, titles,
  captions, roles, keywords and markers.
- `markers.json`: where Final Cut shows each marker of those files (absolute timecode with
  subframes, as listed in Final Cut), copied from the same project's tests.
- `fcp-10.4-project.fcpxml`, `fcp-10.4-clips.fcpxml`: Final Cut Pro 10.4 exports (FCPXML 1.8) from
  [otio-fcpx-xml-adapter](https://github.com/OpenTimelineIO/otio-fcpx-xml-adapter)
  (`tests/sample_data`, commit `c61839e`), Apache-2.0 licensed.

## premiere/

From [otio-fcp-adapter](https://github.com/OpenTimelineIO/otio-fcp-adapter) (`tests/sample_data`,
commit `63824d5`), Apache-2.0 licensed (`../LICENSE-OpenTimelineIO-Apache-2.0.txt`):

- `premiere_example.xml`: Premiere Pro (Windows) with a 15 fps clip in a 30 fps sequence, a nested
  sequence, stereo clips on exploded tracks, dissolves and a slug.
- `premiere_generators.xml`: Premiere Pro's synthetic media (counting leader, bars, black video,
  matte, transparent video, graphic).
- `premiere_enable_property.xml`: Premiere Pro with disabled clips on several tracks.
- `nuke-studio-export.xml` (`hiero_xml_export.xml` there): Nuke Studio / Hiero, with an offline clip.
