# Tasweerix plugin for Claude Code

Describe a video, photo edit, soundtrack, motion graphic or 3D title, and Claude writes the
Tasweerix scene, renders frames to check how they look, fixes what's off, and exports the result.

## Install

```
/plugin install tasweerix --marketplace aliadel2002/Tasweerix
```

On Claude Code before 2.1.275:

```
/plugin marketplace add aliadel2002/Tasweerix
/plugin install tasweerix@tasweerix
```

Rendering needs Node 20+, FFmpeg and Chromium on the machine Claude Code runs on. Run
`/tasweerix:doctor` to check.

## What you get

### Commands

| Command | What it does |
| --- | --- |
| `/tasweerix:new <idea>` | Scaffolds a project from the closest template, writes the scene from your description and checks a few frames |
| `/tasweerix:render [entry] [output] [draft]` | Renders video, a still or audio with sensible defaults and reports where the file landed |
| `/tasweerix:preview [entry] [times]` | Renders frames at key moments and reviews layout, text, color and timing |
| `/tasweerix:doctor` | Checks FFmpeg, Chromium and the optional tools, with install commands for what's missing |
| `/tasweerix:stabilize <video> [smooth\|lock]` | Measures the shake, picks settings and renders a stabilized copy |
| `/tasweerix:cut <media> [silence\|shots\|beats]` | Finds jump cuts, shots or beats and adds the edit to a project as code |
| `/tasweerix:import <timeline>` | Turns an FCPXML, Premiere XML, OTIO or EDL edit into an editable project |
| `/tasweerix:studio [dir]` | Starts the web studio with live preview and two-way editing |

### Skills

Claude loads these when the task calls for them: `scenes` (the core API), `video` (editing,
filters, transitions, smart editing, stabilization, timeline import), `photo`, `audio`,
`motion-type` (kinetic and Arabic type, motion graphics, illustration), `3d` and `cli`. Their
complete examples are typechecked against the current API in the repository's tests.

### MCP server

The plugin starts [`@tasweerix/mcp`](../packages/mcp), which gives Claude these tools:

| Tool | Use |
| --- | --- |
| `render_still` | Renders a frame and returns it as an image, so Claude can see its work |
| `render_video`, `render_audio` | Exports, with progress |
| `inspect_composition` | Size, fps, duration and the node tree of a composition |
| `probe_media`, `analyze_audio` | Media info; loudness, tempo, beats and silences |
| `suggest_cuts` | Silence, shot or beat cut lists as code |
| `list_audio_plugins` | Installed VST3, CLAP, LV2 and LADSPA plugins and their parameters |
| `read_docs` | Any page of the Tasweerix docs |
| `doctor` | The setup check |

The server runs, in order of preference: the copy in this repository when Claude Code is opened at
its root (after `pnpm install`), or the project's installed `@tasweerix/mcp` (`npm i -D @tasweerix/mcp`).
It never downloads a server on its own. It uses the project's own `@tasweerix/cli` when there is one, so renders match the
version the project pins. Set `TASWEERIX_MCP` to a server script or `TASWEERIX_CLI` to a CLI to
override either.

## Developing the plugin

```sh
claude plugin validate claude-plugin --strict      # manifest, skills and commands
claude --plugin-dir claude-plugin                  # try local changes in a session
pnpm vitest run packages/mcp                       # MCP server tests and the skill example typecheck
```
