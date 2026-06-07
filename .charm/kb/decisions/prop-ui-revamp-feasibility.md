---
id: prop-ui-revamp-feasibility
root: decisions
type: decision
status: current
summary: "Feasibility and effort assessment for PROP-charm-harness-ui-revamp: Track A (Bubble Tea Go TUI) and Track B (Electron/Tauri local app), with recommendation to pursue Track A first."
created: 2026-06-07
updated: 2026-06-07
---

# Feasibility: PROP-charm-harness-ui-revamp

Source proposal: `.charm/proposals/PROP-charm-harness-ui-revamp.md`

---

## Current Console: What Exists Today

`src/console/app.tsx` is ~460 lines of TypeScript/React rendered with the `ink` library (React TUI). It has three tabs:

- **Artifacts** (~135 LOC): file browser (PROJECT.md, COORDINATION.md, tickets/) + markdown viewer. chokidar watches the file tree for live updates. Keyboard scrolling (vim bindings), mouse wheel, resizable split panel.
- **Approvals** (~45 LOC): lists pending approval gates, keyboard y/n to approve/reject via RPC.
- **Agents** (~130 LOC): lists live agents with state, dismiss/kill actions via RPC. Two-press kill guard.
- **App shell** (~55 LOC): tab bar, auto-flip to Approvals when gates arrive, terminal-resize tracking.

Supporting files: `src/console/markdown.tsx` (custom markdown renderer producing styled rows), `src/console/mouse.ts` (raw ANSI escape parsing for mouse wheel).

The console polls the daemon via `rpcCall` every 1500ms. No push/subscribe mechanism today.

**RPC layer (`src/daemon/rpc.ts`):**
Newline-delimited JSON-RPC over a Unix domain socket. Uses `Bun.listen`/`Bun.connect` — Bun-specific APIs. Protocol is fully generic: `{ id, method, params }` requests, `{ id, ok, result, error }` responses. Methods the console calls: `status`, `approve_gate`, `dismiss_agent`, `kill_agent`. The socket path is per-session, passed via `--uuid` CLI arg.

---

## Track A: Migrate Console to Bubble Tea (Go TUI)

### What the rewrite entails

The three tabs become Bubble Tea models. Go equivalents exist for everything the current console does:

| Current (ink/TS) | Go/Bubble Tea equivalent |
|---|---|
| Box/Text layout | Lip Gloss `lipgloss.Place`, `lipgloss.JoinVertical/Horizontal` |
| Markdown rendering | Glamour (`glamour.Render`) |
| Mouse wheel | Bubble Tea `tea.MouseMsg` + `viewport.Model` |
| File watching | `fsnotify` |
| Keyboard input | `tea.KeyMsg` in Update loop |
| Tab navigation | top-level model with child sub-models |

### Language-boundary story

The daemon stays TypeScript/Bun. The Go console communicates via the same Unix domain socket using `net.Dial("unix", socketPath)` + `encoding/json`. No new IPC design needed -- the existing JSON-RPC protocol is language-agnostic. The Go client sends `{"id":"...","method":"status","params":null}\n` and reads back `{"id":"...","ok":true,"result":{...}}\n`. This is ~30 lines of Go plumbing.

The socket path must be discoverable. Today the console receives it via `--uuid` flag (daemon passes it at spawn). A Go binary gets the same flag; the path convention is in `src/paths.ts` and must be replicated or read from an env var.

### IPC surface already present

`src/daemon/rpc.ts` exposes: `status`, `approve_gate`, `dismiss_agent`, `kill_agent`. These are sufficient for a full console port. No additions needed for Track A.

### Effort estimate

| Task | Estimate |
|---|---|
| Go project scaffold + Bubble Tea wiring | 0.5 day |
| Unix socket RPC client in Go | 0.5 day |
| Artifacts tab (file list + Glamour viewer + fsnotify) | 1.5 days |
| Approvals tab | 0.5 day |
| Agents tab | 1 day |
| Terminal resize handling, mouse wheel, vim bindings | 1 day |
| Build system integration (Makefile / Bun script to build Go binary alongside TS) | 0.5 day |
| Testing + polish | 1 day |
| **Total** | **~6-7 days** |

### Risks and constraints

- Go becomes a new build dependency. The current project is pure TypeScript/Bun.
- The `charm-graph` viewer (force-directed graph, `src/console/graph.ts`) runs as a separate OS window via AppleScript. A Bubble Tea console does not solve in-process graph rendering -- the graph window stays external.
- Polling (1500ms) vs push: a Go rewrite inherits the same polling model unless `status_stream` (SSE or a subscription RPC method) is added to the daemon. Not required for parity.
- `src/console/markdown.tsx` is a custom renderer that handles the specific markdown produced by charm (tickets, KB notes, COORDINATION.md). Glamour is a full CommonMark renderer -- higher quality but different character rendering. Minor visual differences expected.

---

## Track B: Local Electron or Tauri App

### Bun-specific API audit

The daemon uses APIs that are Bun-specific and do not exist in Node.js:

| Bun API | Used for | Node equivalent |
|---|---|---|
| `Bun.listen({ unix })` | RPC server (Unix socket) | `net.createServer()` + `server.listen(socketPath)` |
| `Bun.connect({ unix })` | RPC client | `net.createConnection(socketPath)` |
| `Bun.spawn` / `$` | Agent process spawning (likely in `spawn.ts`) | `child_process.spawn` |
| `Bun.build` | Possibly used in build pipeline | `esbuild` |

The Unix socket server/client migration is mechanical (same protocol, different API surface). Agent spawning in `src/daemon/spawn.ts` would need a similar audit. Overall the daemon is **largely Node-compatible** -- the Bun-specific surface is narrow and replaceable, not architecturally entangled.

### Packaging the daemon into Electron

Two options:

**Option A -- Daemon as child process:** Electron main process spawns `charmd` as a subprocess. Electron and daemon communicate via the Unix socket (same as today). This requires `charmd` (compiled Bun binary) to be bundled into the Electron app's resources directory. Clean separation; daemon code unchanged.

**Option B -- Daemon in main process:** Port daemon to Node-compatible TypeScript, run it in Electron's main process directly. Eliminates the Bun dependency at the cost of auditing and porting all Bun-specific APIs. More work upfront but results in a single-process binary.

Option A is the faster path to a prototype. Option B is cleaner long-term.

### React frontend: new surface area vs existing code

The Ink console is already React. The state model (`useStatus`, `useFileTree`, `useFileContent`) is pure React with no Ink-specific dependencies except for `useInput`/`useMouseWheel`/`Box`/`Text`. Porting means:

1. Replace `Box`/`Text` with `<div>`/`<span>` + CSS.
2. Replace `useInput` with `addEventListener("keydown")`.
3. Replace `useMouseWheel` (ANSI escape parsing) with standard `onWheel`.
4. Add a markdown renderer (react-markdown or similar) in place of the custom `renderMarkdown`.
5. Add the force-directed graph inline (it's already a separate graph.ts file using a browser-compatible library -- this is actually a simplification).

The RPC layer needs to be replaced with HTTP + WebSocket. The daemon would need:

- An HTTP server endpoint (`/status`, `/approve_gate`, etc.) or a single WebSocket endpoint with push.
- A `localhost:PORT` server alongside (or instead of) the Unix socket.

This is **~2-3 days of daemon work** for a basic HTTP API layer.

### Phase breakdown

| Phase | Scope | Estimate |
|---|---|---|
| Phase 0: Daemon HTTP API | Add HTTP/WS server, expose existing RPC methods | 2-3 days |
| Phase 1: Electron shell | Electron main + renderer setup, bundle charmd binary | 2-3 days |
| Phase 2: React frontend port | Three tabs, keyboard nav, file watching via HTTP polling or WS | 5-7 days |
| Phase 3: Graph integration | Embed force-directed graph inline (currently a separate window) | 3-5 days |
| Phase 4: Polish + distribution | Auto-update, packaging (electron-builder or similar), macOS code signing | 5-7 days |
| **Total (Electron, Option A)** | | **~17-25 days** |

Tauri adds a Rust build dependency and requires wrapping the Bun daemon as a sidecar. Adds ~1 week for the Rust/Tauri scaffolding on top of the above, but cuts the final bundle size significantly. Recommend Electron for a prototype, Tauri later if distribution becomes a priority.

---

## Comparative Recommendation

**Near-term: Track A (Bubble Tea) or stay on Ink with additions.**

Track A delivers a materially better TUI -- proper viewport scrolling, Glamour markdown rendering, cleaner layout control -- for ~6-7 days of work. The Go/TypeScript language boundary is genuinely clean: the JSON-RPC socket is the only interface, and Go consumes it without any changes to the daemon.

However, before committing to Track A, consider an intermediate option: **stay on Ink and fill the current gaps.** The existing console is already functional. The missing pieces that cause friction are:

- No KB browser (the Artifacts tab only shows PROJECT.md, COORDINATION.md, and tickets -- not the KB or proposals)
- No settings UI
- The markdown viewer renders most content well but struggles with wide tables

These gaps can be closed in 2-3 days of TypeScript/Ink work with zero new build dependencies. If the goal is personal use and the workflow is stable, this is the least-regret path.

**Track A is the right choice if:** the console UX is a real daily-use friction point AND the project is willing to carry Go as a build dependency.

**Track B is the right choice if:** charm is intended to become a distributable product used by teammates who are not comfortable in a terminal. Track B should not start until the core workflow semantics (tickets, agents, KB, proposals) are stable -- building a polished UI on shifting foundations wastes the effort.

**Recommended sequence:**
1. Close the immediate Ink gaps (KB browser, proposals tab) -- 2-3 days, TypeScript only.
2. If the TUI ceiling is still blocking, do Track A -- 6-7 days.
3. Only start Track B when charm is being shared with non-terminal users or run in multi-project contexts.
