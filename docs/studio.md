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
  export mix.
- **Code editor.** CodeMirror 6 with TypeScript highlighting. Edits save automatically and hot-reload
  the preview at the current frame. Errors show in place.
- **Timeline.** It shows a track per element (nested), clip bars, keyframe diamonds, audio waveforms,
  markers and a scrubbable ruler with zoom.
- **Inspector.** It shows evaluated properties at the playhead. Animated or computed properties are
  marked with ◆.
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
| Edit a value in the inspector | That option's literal, for example `radius: 48` or `fill: '#ff0055'` |
| Move or trim a clip on the timeline | `start` / `duration` options |
| Drag a keyframe | The time of that entry in `keys([...])` / `node.keys(...)` |
| ↶ / ↷ or ⌘Z / ⇧⌘Z | File-level undo and redo of those edits |

How it works: in the studio, every node and keyframe track records the call stack where it was created.
The server maps those frames through the bundle's source map to your file, line and column. It then uses
`@tasweerix/codemod` (Babel parser and recast) to rewrite only the affected expression.

Values that are not literals (variables, functions, computed expressions) are never overwritten. The
inspector and the status message point you to the code instead.

Elements inside `sequence(...)` get their start times from the layout, so editing their `start` has no
visible effect. Change the order or the durations instead.
