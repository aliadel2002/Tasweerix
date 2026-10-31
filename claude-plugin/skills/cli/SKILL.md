---
name: cli
description: The Tasweerix command line and the tasweerix MCP tools - how to run the CLI in a project or the monorepo, every command and flag (render, still, audio, svg, studio, batch, cuts, analyze, stabilize, track, import-timeline, export-timeline, transcribe, ai, inspect, probe, doctor, init), output format and codec choices, asset roots and environment variables. Use when rendering, exporting or running any Tasweerix command.
---

# The Tasweerix CLI

## Running it

Pick the first that applies, from the project directory:

1. **The Tasweerix monorepo** (a `pnpm-workspace.yaml` and `packages/cli/` exist): `pnpm tasweerix <command>`.
   No build step. Examples that use repo-level assets need `--root .`.
2. **A project with the CLI installed** (`node_modules/.bin/tasweerix` exists): `npx tasweerix <command>`.
3. **Otherwise**: ask the user to install it (`npm i -D @tasweerix/cli`). Don't run `npx -y` with a
   package that isn't installed: it downloads and runs whatever is published under that name.

When the tasweerix MCP tools are connected, prefer them for what they cover (they return structured
results, previews and progress): `doctor`, `read_docs`, `inspect_composition`, `render_still`,
`render_video`, `render_audio`, `probe_media`, `analyze_audio`, `suggest_cuts`, `list_audio_plugins`.
Use the CLI through the shell for everything else.

## Commands

| Command | Purpose and key options |
| --- | --- |
| `doctor [--json]` | Checks Node, FFmpeg, ffprobe, Chromium and the optional tools; says how to fix what's missing |
| `init [dir] -t video\|photo\|audio\|motion\|arabic\|3d` | Scaffold a project (index.ts, package.json, tsconfig, assets/) into an empty directory |
| `render <entry> -o out.mp4` | Video. `--codec`, `-j` workers, `--range a-b` (frames), `--scale`, `--crf`, `--preset`, `--props '{…}'`, `--comp`, `--root`, `--transparent`, `--muted`, `--depth 8\|16`, `--gamut srgb\|p3\|rec2020`, `--hdr pq\|hlg`, `--gpu auto\|on\|off`, `--motion-blur-samples` |
| `still <entry> -o out.png -f <frame>` | One frame to png, jpg, webp, avif or tiff; same color options as render |
| `audio <entry> -o mix.mp3 [--stems]` | The mix to wav, mp3, flac, aac/m4a, ogg or opus; prints LUFS and true peak |
| `svg <entry> -o frame.svg -f <frame>` | Vector export of a frame |
| `studio [dir] [-e entry] [-p port]` | Web editor with live preview, timeline and two-way code editing (default http://127.0.0.1:3000) |
| `batch <entry> -i "photos/*.jpg" -o out/batch -f jpg` | One script per input file (`props.src`, `props.name`, `props.index`) |
| `cuts <file> --mode silence\|shots\|beats [--json]` | Prints a suggested edit as code |
| `analyze <file> [--json]` | LUFS, true peak, BPM, beats, silences |
| `stabilize <file> [-o out] [--mode smooth\|lock] [--model perspective] [--rolling-shutter auto] [--max-zoom n] [--analyze]` | Renders a stabilized copy (default `<name>.stabilized.mp4`), or measures shake only |
| `track <file> --at x,y --time t` / `--corners x1,y1,…,x4,y4` | Tracks a point or plane and prints keyframes |
| `import-timeline <file> -o <dir> [--media dir] [--copy-media] [--fps n]` | FCPXML, FCP7 XML, OTIO or EDL to an editable project |
| `export-timeline <entry> -f fcpxml\|otio\|xmeml\|edl -o file [--graphics]` | The edit for Final Cut, Resolve, Premiere or OTIO tools |
| `transcribe <file> [-o subs.srt] [--translate <language>]` | Speech to srt, vtt or json (needs whisper.cpp) |
| `ai "<request>" [-e entry] [--dry-run]` | The built-in assistant edits a project file (needs Anthropic credentials) |
| `inspect <entry>` | The composition tree as JSON |
| `probe <file>` | Media info as JSON |
| `audio-plugins [--json] [--describe <plugin>]` | Installed VST3, CLAP, LV2, LADSPA plugins and hosts |

Projects can add commands through plugins in `tasweerix.config.ts`; `tasweerix --help` lists them.

## Choosing an output

| Goal | Output |
| --- | --- |
| Share or upload | `.mp4` (h264); `--crf 18` for high quality |
| Smaller, modern | `--codec h265` or `av1` |
| Web with alpha | `.webm --transparent` (vp9) |
| Editing master or overlay with alpha | `.mov --codec prores [--transparent] [--depth 16]` |
| Loops for chat or docs | `.gif --scale 0.5`, or animated `.webp` |
| Frames | `--codec png -o out/frames` |
| HDR | `--hdr pq` (h265 by default), `--hdr-peak 1000` |

## Speed

- Draft with `--scale 0.5` and a `--range`, then render the final once.
- `-j` defaults to one worker per core up to 4. On CPU-only machines (no GPU, so SwiftShader) more
  workers help up to the core count, and `--preset veryfast` frees CPU.
- Analyses (beats, silences, stabilization, transcripts, AI answers) are cached in `.tasweerix/cache`.

## Paths

The asset root is the entry's directory unless `--root` is given. Outputs are relative to the
current directory. Keep renders in `out/` (the scaffolded `.gitignore` ignores it).

## Environment variables

`TASWEERIX_CHROMIUM`, `TASWEERIX_FFMPEG`, `TASWEERIX_FFPROBE`, `TASWEERIX_DCRAW_EMU`,
`TASWEERIX_GPU`, `TASWEERIX_PLUGIN_HOST`, `ANTHROPIC_API_KEY`, `TASWEERIX_AI_MODEL`,
`TASWEERIX_WHISPER_BIN`, `TASWEERIX_WHISPER_MODEL`. For the MCP server: `TASWEERIX_CLI` (a CLI to
use instead of the project's) and `TASWEERIX_PROJECT_DIR`.

## When a render fails

- "Chromium" or "ffmpeg" not found: run `doctor` and follow its fix line.
- Asset 404 or "not found": the path is relative to the asset root; check `--root`.
- An error inside the build function: `inspect` the entry to see the stack without rendering.
- Blank or black frames: check `start`/`duration` windows with `inspect`, and `background`.
