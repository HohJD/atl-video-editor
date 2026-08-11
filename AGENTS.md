# ATL Video Editor

Agentic timeline video editor. Express server + vanilla JS frontend, HyperFrames (HTML→MP4) as the export renderer, Electron for the macOS app.

## Architecture

- `server/edl.mjs` — EDL document model + pure op layer. Every operation is `(state, params, ctx) → { state, diff, summary }`, state is immutable. The ops registry auto-generates the Anthropic tool schemas (`toolDefinitions()`). **All edits — mouse or agent — go through these ops.**
- `server/analyze.mjs` — ingest pipeline, runs at upload only: ffprobe, 720p proxy, waveform peaks, scene detection (ffmpeg scdet), silence map, beat grid (energy-flux onsets + BPM), speech transcription (whisper.cpp, word-level). Cached as sidecar JSON in `cache/` keyed by content hash.
- `server/compile.mjs` — EDL → HyperFrames HTML for export. Speed-remapped clips get baked to intermediate assets with ffmpeg (renderer has no playbackRate).
- `server.mjs` — project state (immutable commits, cursor undo/redo), `/api/ops`, agent SSE loop (`/api/agent`, Claude tool-use over the op layer + virtual tools `autoCaptions`/`cutOnBeats`/`getTranscript`), export jobs with progress.
- `public/preview-runtime.js` — browser-side preview compositor in an iframe; builds DOM from the EDL and scrubs against proxies. **Layout math must mirror `server/compile.mjs`.**
- `public/app.js` — media bin, transport, multi-track timeline (drag/trim/split/ripple/clone), chat with tool traces + revert. Polls `/api/status` to live-refresh when external clients (MCP) edit the project.
- `mcp-server.mjs` — stdio MCP server for Claude Code / any MCP client. Proxies to the running app's HTTP API (probes ports 3000 then 34197). Registered user-wide: `claude mcp add --scope user atl-video -- node <repo>/mcp-server.mjs`. Requires the app to be running.

## Commands

- Run dev server: `npm run dev` (http://localhost:3000)
- Tests (op layer golden fixtures): `npm test`
- Syntax check all: `for f in server.mjs server/*.mjs public/app.js public/preview-runtime.js; do node --check $f; done`
- Build macOS DMG: `npx electron-builder --mac --arm64 --publish=never` (output in `release-builds/`)
  - NOTE: unset `ELECTRON_RUN_AS_NODE` before launching Electron from a shell.

## Runtime dependencies (host machine)

- ffmpeg + ffprobe (Homebrew), Google Chrome (for HyperFrames renderer)
- whisper.cpp: `brew install whisper-cpp`, model at `~/.cache/atl-models/ggml-base.en.bin` (transcription is skipped gracefully if missing)

## Conventions

- New ops: add to `OPS` in `server/edl.mjs` with description/params/required/apply, and cover with a test in `tests/edl.test.mjs`. The agent picks them up automatically.
- Ops must stay pure (no I/O); anything needing analysis data is a "virtual tool" in `server.mjs` that resolves data then calls `commit()`.
- Tracks are fixed: V1 (video), O1/O2 (overlays), C1 (captions), A1 (audio).
