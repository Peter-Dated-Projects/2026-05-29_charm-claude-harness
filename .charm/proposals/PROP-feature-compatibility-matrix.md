# PROP-feature-compatibility-matrix

**Status:** draft
**Produced by:** T-017

---

## Summary

This document maps every current charm feature against six Rust UI frameworks to
determine which features are native (trivially available), partial (achievable but
requires non-trivial crate work or design compromises), or blocked (no clear path).

The most important framing constraint: charm's console is today a **terminal UI** that
lives inside a tmux pane. All six frameworks produce *windowed GUI apps*, not terminal
apps. Choosing any of them means migrating the console from a pane inside tmux to a
separate OS window. Dioxus is the only framework in this list with a TUI renderer
(dioxus-tui), but it wraps ratatui and is less mature than using ratatui directly.

The daemon, MCP server, and all backend logic are Rust stdlib/tokio code and are
**framework-agnostic** — they do not depend on the UI choice at all.

---

## Rating key

| Symbol | Meaning |
|---|---|
| native | Built-in or trivially available via a standard crate; no design compromise |
| partial | Achievable but requires non-trivial custom work, an immature crate, or a design workaround |
| blocked | No clear path; fundamental incompatibility with the framework's model |

---

## Feature matrix

### Console / UI

| Feature | Tauri | Dioxus | GPUI | Slint | Iced | egui |
|---|---|---|---|---|---|---|
| Three-tab terminal UI (stays in tmux pane) | blocked | partial | blocked | blocked | blocked | blocked |
| Three-tab windowed UI (migrated to OS window) | native | native | native | native | native | native |
| Markdown viewer | native | native | partial | partial | partial | partial |
| Keyboard navigation (vim bindings, tab switch) | native | native | native | partial | native | partial |
| Mouse wheel scrolling | native | native | native | native | native | native |
| Agent status grid (live-updating, 1500ms poll) | native | native | native | native | native | native |
| Force-directed KB graph (separate OS window) | native | partial | native | partial | partial | partial |
| Approval gate (y/n keyboard confirm) | native | native | native | native | native | native |
| Kill agent two-press guard | native | native | native | native | native | native |

**Notes:**

- **"Terminal UI (stays in tmux)"** is the current model: charm-console is a tmux pane.
  None of the windowed frameworks can render into an existing terminal pane — this is
  fundamentally blocked for Tauri, GPUI, Slint, Iced, and egui. Dioxus is rated
  partial because dioxus-tui can render to a terminal, but it is significantly less
  mature than ratatui and has known rendering gaps on complex layouts.

- **Markdown viewer**: Tauri has the full web ecosystem (marked, remark, etc.) — native.
  Dioxus desktop can use the same webview stack. GPUI has rich text support but no
  off-the-shelf markdown widget; requires custom parsing-to-render pipeline. Slint and
  Iced have limited text primitives. egui has `egui_commonmark` which covers basic
  markdown but struggles with nested structures and code blocks.

- **Keyboard navigation**: Tauri and Dioxus surface DOM keyboard events, giving full
  control. GPUI has excellent keyboard dispatch (Zed is a keyboard-driven editor).
  Slint's key-handling API is functional but doesn't have a first-class binding
  dispatch system. Iced subscriptions cover key events well. egui has basic key
  detection but no structured key-binding layer.

- **Force-directed graph**: Tauri (native) can use D3.js, cytoscape, or vis-network in
  the WebView — fully supported. Dioxus desktop can do the same; Dioxus TUI cannot.
  GPUI exposes a `gpui::canvas` 2D drawing API suitable for a custom physics sim.
  Slint has a Canvas element but its API is more limited. Iced has a Canvas widget
  with full 2D drawing. egui has `egui_graphs` but it is immature; custom Canvas is
  possible but requires more work.

---

### Daemon / backend

These features are all in charmd (the daemon), which is a standalone Rust process
with no UI dependency. The UI framework choice does **not affect** any of these.

| Feature | Tauri | Dioxus | GPUI | Slint | Iced | egui |
|---|---|---|---|---|---|---|
| Unix domain socket JSON-RPC server | native | native | native | native | native | native |
| SQLite-backed ticket store | native | native | native | native | native | native |
| Frontmatter round-trip | native | native | native | native | native | native |
| tmux session management | native | native | native | native | native | native |
| Agent process spawning | native | native | native | native | native | native |
| COORDINATION.md file writer | native | native | native | native | native | native |
| Orchestrator ping coalescing (1200ms debounce) | native | native | native | native | native | native |
| Dependency + touches conflict resolver | native | native | native | native | native | native |

All backend features are `native` across all frameworks because charmd is a separate
binary and does not link against any UI library. Framework choice is irrelevant here.

---

### MCP server

The MCP server (charm-mcp) is a stdio JSON-RPC bridge, also a separate binary.
Framework choice does not affect it.

| Feature | Tauri | Dioxus | GPUI | Slint | Iced | egui |
|---|---|---|---|---|---|---|
| stdio JSON-RPC protocol (Claude Code bridge) | native | native | native | native | native | native |
| 20+ tool definitions forwarded to daemon | native | native | native | native | native | native |
| Per-agent ID injection | native | native | native | native | native | native |

---

### Distribution / ops

| Feature | Tauri | Dioxus | GPUI | Slint | Iced | egui |
|---|---|---|---|---|---|---|
| Single `charm` CLI entry point | partial | partial | partial | partial | partial | native |
| `charm init/start/stop/attach` subcommands | partial | partial | partial | partial | partial | native |
| Per-session UUID and socket path layout | native | native | native | native | native | native |
| OTA update | native | partial | partial | partial | partial | partial |

**Notes:**

- **Single CLI entry point**: All five windowed frameworks are designed for GUI-first
  app launch, not CLI dispatch. Tauri, Dioxus desktop, GPUI, Slint, and Iced apps
  open a window on launch; you can inspect `std::env::args` before doing so, but the
  idiom runs against the grain of these frameworks. For `charm init` and `charm stop`
  (no UI needed), you'd either bundle a headless CLI binary alongside the GUI app, or
  gate window creation on whether a UI subcommand was requested. Both approaches work
  but add build complexity. egui/eframe apps are just binaries and handle CLI args
  naturally before calling `eframe::run_native`.

- **OTA update**: Tauri has a mature first-party updater plugin (tauri-plugin-updater)
  that handles code signing, delta updates, and rollback. No other framework in this
  list ships an updater. Dioxus, GPUI, Slint, Iced, and egui would all require a
  custom implementation — likely a background task that polls a release endpoint,
  downloads a new binary, and restarts. The `self-update` crate covers the mechanics
  but integration is manual.

---

## Specific gaps addressed

### Gap 1: tmux management from a GUI app

**Not a problem for any framework.**

tmux is controlled via subprocess calls (`tmux split-window -t session:pane`). Every
Rust GUI framework runs Rust code in the same OS process with no browser sandbox.
`std::process::Command` works identically regardless of which UI framework is active.
The tmux wrapper in charm-core is pure Rust subprocess logic — it compiles and
behaves the same whether the app is a Tauri window, an Iced frame, or anything else.

### Gap 2: Unix socket RPC from the UI process

**Framework-dependent.** There are two categories:

**WebView-backed frameworks (Tauri, Dioxus desktop):** The UI layer runs inside a
WebView (WKWebView / WebView2 / WebKitGTK). Browser security prevents WebView
JavaScript from opening Unix sockets directly. The Rust host process can open sockets
without restriction. The UI communicates with the daemon via Tauri's IPC mechanism
(Tauri commands / invoke), not via a direct socket connection. This means charm's
console would call `invoke("rpc_call", ...)` rather than `socket.write(...)`. The
daemon socket is still there; only the UI→daemon path routes through Tauri IPC.
Additional indirection, but no fundamental blocker.

**Pure-Rust UI frameworks (GPUI, Slint, Iced, egui):** There is no browser sandbox.
The UI and backend are in the same process or communicate via normal Rust channels.
The UI can open a Unix socket directly using tokio/std, or the socket client can live
on a background thread and communicate with the UI via a channel. This is the cleanest
architecture — the same RPC client code used in charm-console today could be reused
with minimal changes.

**Summary:** Unix socket RPC is native in GPUI/Slint/Iced/egui. It requires a
UI-layer bridge in Tauri/Dioxus-desktop but is not blocked.

---

## Per-framework verdict

### Tauri

**Best for:** Full GUI migration with the richest web-ecosystem UI toolkit.

Strengths: full web rendering (D3 graphs, any markdown lib, any widget), built-in OTA
updater, widest cross-platform support, most mature desktop Rust framework, huge
ecosystem.

Weaknesses: UI → daemon RPC needs a Tauri IPC bridge (not a direct socket call); CLI
entry point is awkward for `charm init/stop`; WebView introduces a runtime dependency
(WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux); binary size is larger.

**Blockers:** None. The terminal-UI-in-tmux model is abandoned; charm becomes a
windowed app.

---

### Dioxus

**Best for:** Keeping React-like component ergonomics in Rust, with a TUI fallback.

Strengths: React/Hooks mental model maps directly from Ink; dioxus-tui can keep the
terminal paradigm; desktop renderer uses the same component tree. Signal-based
reactivity makes live-updating status grids easy.

Weaknesses: dioxus-tui is less mature than ratatui and has known layout quirks;
desktop renderer is wry-based (same WebView constraints as Tauri); `dioxus 0.6`
breaking-change cadence has been high. No built-in OTA updater.

**Blockers:** None for windowed mode. TUI mode is partial due to maturity gaps.

---

### GPUI

**Best for:** High-quality, GPU-accelerated native-feel app on macOS (Zed-level polish).

Strengths: production-proven in Zed (complex multi-pane editor); pure Rust UI means
direct Unix socket access; excellent keyboard dispatch; fast rendering (Metal/Vulkan);
has a terminal emulator widget (`gpui::terminal`) built for Zed that could embed
charm's tmux interaction.

Weaknesses: **macOS-first** — Linux support is functional but macOS is the primary
target; Windows support is a work in progress. The public API is not versioned
independently of Zed; breaking changes land without deprecation warnings. No built-in
OTA updater. Documentation is thin outside Zed's own source. Only one known production
user (Zed itself).

**Blockers:** No terminal-in-tmux model. Windows support is not production-ready.

---

### Slint

**Best for:** Embedded-style or constrained-platform targets; not a strong fit for charm.

Strengths: very fast startup, small binary, declarative .slint DSL is readable.

Weaknesses: .slint DSL is a separate language to learn; markdown rendering requires
custom work; force-directed graph requires significant Canvas coding; no built-in
OTA; license is GPL v3 (paid commercial license required for closed-source
distribution). Ecosystem for charm's specific needs (markdown, graphs, terminals) is
sparse.

**Blockers:** None in principle, but weak ecosystem fit makes this the most effort of
any option for charm's feature set.

---

### Iced

**Best for:** Clean, functional Rust UI without a DSL or web layer.

Strengths: pure Rust, no WebView dependency; Elm architecture is predictable for
complex state; Canvas widget handles the force-directed graph well; good cross-platform
story; active development.

Weaknesses: Elm architecture means everything routes through a central Message enum —
verbose for UIs with many independent components. Breaking-change cadence between
minor versions has been high (0.10 → 0.12 had significant API shifts). Markdown
widget is partial. No built-in OTA updater.

**Blockers:** None, but Elm-style message routing adds boilerplate at charm's feature
count.

---

### egui

**Best for:** Developer tooling with fast iteration and live-updating data grids.

Strengths: immediate mode is trivially suited to live-updating agent status;
`egui_commonmark` covers basic markdown; eframe binary is naturally CLI-dispatched;
lowest barrier to get something working; pure Rust (direct Unix socket access). Most
forgiving framework for rapid development.

Weaknesses: Immediate mode redraws every frame (60fps GPU cost even when idle —
mitigatable with `ctx.request_repaint_after`); text rendering is functional but not
as polished as WebView or Metal-native; not designed for "product" grade UIs;
`egui_graphs` for the force-directed graph is immature and would need custom
implementation. No built-in OTA updater.

**Blockers:** None. Best for internal tooling use cases; lowest concern about polish.

---

## Recommendation summary

| Framework | Terminal UI (stays in tmux) | GUI migration fit | Ecosystem for charm's needs | OTA | CLI entry point | Overall |
|---|---|---|---|---|---|---|
| Tauri | blocked | excellent | excellent (web) | native | partial | Best GUI option |
| Dioxus | partial (tui) | good | good | partial | partial | Best TUI-preserving option |
| GPUI | blocked | excellent (macOS) | moderate | partial | partial | Best macOS-native option |
| Slint | blocked | good | weak | partial | partial | Not recommended |
| Iced | blocked | good | moderate | partial | partial | Solid alternative to egui |
| egui | blocked | moderate | moderate | partial | native | Best for rapid tooling |

**If preserving the terminal-in-tmux model:** use ratatui directly (not in this list
but referenced in PROP-rust-rewrite). Dioxus-tui is the only listed framework that
wraps this model but adds reactivity overhead.

**If migrating to a windowed app:** Tauri for the richest UI ecosystem and built-in
OTA; GPUI for native feel and keyboard-centric polish on macOS; egui for the fastest
path to a working developer tool.

---

## What is not a blocker for any framework

- tmux subprocess management (any framework, no restrictions)
- SQLite ticket store (rusqlite is universal)
- Frontmatter round-trip (serde_yaml is universal)
- MCP stdio server (separate binary, no UI dependency)
- Unix socket daemon server (charmd is framework-agnostic)
- Agent process spawning (std::process::Command, universal)
- Per-session UUID and socket path layout (std::path, universal)
