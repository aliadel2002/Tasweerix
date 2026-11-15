# Studio and two-way editing

```sh
tasweerix studio path/to/project      # --entry other.ts  --port 3000
```

Open the link the command prints. It carries a random access token that changes every time the studio
starts; the studio swaps it for a cookie, so bookmarks of `http://127.0.0.1:3000/` work until the next
restart. Without the token, the studio refuses every request. So do requests from other websites and
from host names other than `localhost` / `127.0.0.1` (which blocks DNS rebinding). File reads, writes,
uploads and exports stay inside the project folder, and symlinks that lead out of it are refused.

`--host 0.0.0.0` (or a LAN address) makes the studio reachable from other machines. Anyone who has the
link can then edit the project and run code in it, so share it only with people you trust.

The studio is a local web app with these parts:

- **Preview.** The same renderer as exports draws the preview, at 25–100% resolution. It has play/pause,
  frame stepping, looping, and safe-area and thirds guides. Audio playback is synced and uses the exact
  export mix. A selected element shows corner handles that scale it about its anchor and a handle above
  it that rotates it (hold Shift for 15° steps).
- **Code editor.** CodeMirror 6 with TypeScript highlighting. Edits save automatically and hot-reload
  the preview at the current frame. Errors show in place.
- **Timeline.** A track per element (nested groups collapse). Rows are named after the element, its
  media file or its text. Video clips show frames of their source; audio clips show waveforms. Drag a
  clip to move it or either edge to trim it. Edges snap to the playhead, markers and other clips (hold
  Alt, or turn the magnet off, to place freely). Keyframe diamonds drag too. A focused clip or keyframe
  moves a frame at a time with the arrow keys, ten with Shift.
- **Inspector.** Evaluated properties at the playhead, grouped into Timing, Transform, Appearance,
  Content and Filters. Drag a number's label to scrub it. Animated or computed properties are marked
  with ◆ and are read-only.
- **Project panel.** It lists files and assets. Click to open a file, use ▶ to make a file the entry,
  ⧉ copies an insert snippet, and you can drop files to upload them into `assets/`.
- **Export.** Export to MP4, WebM, ProRes, GIF, or the current frame as PNG or JPG, with live progress.
- **Command bar.** Plugin commands that declare a studio action appear above the code editor. The
  built-in one is the **Assistant**: describe a change ("make the title gold and slower") and it edits
  the open file. Its edits join the undo history. See [AI features](ai.md).

## Two-way editing

GUI changes are written back into **your source code**, with formatting and comments preserved:

| Action | Source change |
| --- | --- |
| Drag an element on the canvas | `at: [x, y]` (or `position`) on its factory call; added if missing |
| Drag a corner handle or the rotate handle | `scale` or `rotation` |
| Edit a value in the inspector | That option's literal, for example `radius: 48` or `fill: '#ff0055'` |
| Move a clip, or trim its right edge | `start` / `duration` options |
| Trim a clip's left edge | `start` and `duration` together; a video's `trim` in-point moves too, so the picture under the playhead stays the same |
| Drag a keyframe | The time of that entry in `keys([...])` / `node.keys(...)` |
| Undo / redo buttons, or ⌘Z / ⇧⌘Z anywhere, the code editor included | One history of file changes: typing and visual edits undo in the order they happened |

How it works: in the studio, every node and keyframe track records the call stack where it was created.
The server maps those frames through the bundle's source map to your file, line and column. It then uses
`@tasweerix/codemod` (Babel parser and recast) to rewrite only the affected expression.

Values that are not literals (variables, functions, computed expressions) are never overwritten. The
inspector and the status message point you to the code instead.

The studio saves text you have typed before it rewrites the source for a visual edit, so the two never
overwrite each other. If another program changes the open file while you have unsaved typing, the
version on disk wins.

Elements inside `sequence(...)` get their start times from the layout, so editing their `start` has no
visible effect. Change the order or the durations instead.

## Language and layout

The globe button switches the interface between English and Arabic; the choice is remembered, and an
Arabic browser starts in Arabic. In Arabic the panels mirror right to left. The preview, the timeline,
playback controls and code stay left to right, and property names stay as they are written in code.

Drag the dividers between panels to resize them (or focus one and use the arrow keys). In a narrow
window the file list hides first, then the code panel, so the preview stays visible.
