# PROP-vscode-layout-feasibility

**Status:** research  
**Ticket:** T-016  
**Date:** 2026-06-16

---

## Problem

If charm grows a native desktop GUI instead of (or alongside) its current Ink TUI, can a
VSCode-style layout be achieved in Rust? This document evaluates the top Rust GUI
frameworks against the eight UI patterns charm needs, draws from production prior art
(Zed, Lapce), and produces a verdict matrix with a recommendation.

---

## The Eight Patterns Charm Needs

| # | Pattern | Notes |
|---|---|---|
| 1 | Activity bar | Left icon strip — Agents / Tickets / KB / Proposals / Settings |
| 2 | Side panel | Collapsible tree — ticket list, KB file tree, agent list |
| 3 | Editor / main area | Tabbed markdown viewer, ticket detail, proposal editor, agent log streaming |
| 4 | Bottom panel | Approval queue, status log |
| 5 | Status bar | Session info, agent count, model, live cost ticker |
| 6 | Command palette | Fuzzy search across tickets / KB / agents |
| 7 | Diff view | For proposals and KB changes |
| 8 | Inline terminal | Streaming agent output — real ANSI terminal emulation, possibly embedded tmux |

---

## Frameworks Evaluated

Five frameworks cover the practical option space for Rust native GUI in 2025-2026.

### 1. GPUI (Zed's framework)

**What it is.** GPU-accelerated retained-mode UI framework developed by the Zed team.
Drives the Zed editor — the closest existing analogue to charm's target layout.
Metal/DirectX/OpenGL backends via `gpui`. UI model is component-based with typed views
and a fine-grained signal graph.

**VSCode-style layout verdict.** Zed already implements every VSCode pattern charm needs:
activity bar (the left icon strip), side panel (project tree, outline), tabbed editor
panes, bottom panel (terminal, diagnostics), status bar, command palette, and diff
(inline blame + hunk markers). The proof is in production.

**Pattern-by-pattern:**

| Pattern | Support | Notes |
|---|---|---|
| Activity bar | Yes | Zed's `WorkspaceElement` renders it natively |
| Side panel | Yes | `PanelHandle` + `DockPosition` (left / bottom / right) |
| Tabbed editor | Yes | `Pane` widget, multi-pane split with `PaneGroup` |
| Bottom panel | Yes | Same `DockPosition::Bottom` as side panel |
| Status bar | Yes | `StatusBar` component, item registration API |
| Command palette | Yes | `CommandPaletteModal`, fuzzy match on action registry |
| Diff view | Yes | `DiffHunk` overlay on editor widgets |
| Inline terminal | Yes | Zed has an embedded terminal that uses `alacritty_terminal` under the hood |

**Gaps for charm use.**

- GPUI is not designed for external use. There is no published crate; you vendor it by
  depending on `zed/crates/gpui` via a git dependency. The API breaks across Zed releases
  with no semver guarantees.
- Documentation is near-zero outside Zed's own source. Learning path is reading Zed source.
- Component model requires a `gpui::App` context threaded through everything; integrating
  charm's async Tokio daemon without architectural surgery is non-trivial.
- Build-time cost is high: compiling GPUI pulls in the full Metal/graphics stack.

**Resizable split panes.** Yes — `PaneGroup` with draggable dividers.

**Markdown rendering.** Not built in. Zed uses a custom `markdown` crate from their
workspace; it is vendorable but undocumented.

**Terminal emulation.** Via `alacritty_terminal` (the same `vte`-based parser Alacritty
uses). This is the cleanest path to real ANSI terminal rendering in a Rust GUI. Zed's
embedded terminal shows the integration pattern.

**Effort to use GPUI for charm.** High. You are essentially forking Zed's architecture.
The upside is that every VSCode pattern is already solved. The downside is that you own
a vendored copy of a rapidly-moving framework with no support surface.

**Verdict: Partial (with major effort caveat).** Technically capable of everything charm
needs, but the practical cost of using GPUI outside Zed is very high. Recommended only
if charm intends to become a long-term Zed-adjacent project with dedicated UI engineering.

---

### 2. Floem (Lapce's framework)

**What it is.** Reactive, fine-grained signal-based GUI framework. Successor to the
`druid` lineage. Drives the Lapce editor, which also targets VSCode-level layout
complexity. Published on crates.io (`floem` 0.1.x) with more deliberate third-party
support than GPUI.

**VSCode-style layout verdict.** Lapce implements an activity bar, collapsible side
panels, a split editor area with tabs, and a status bar. The prior art is thinner than
Zed's but it demonstrates the core layout is achievable.

**Pattern-by-pattern:**

| Pattern | Support | Notes |
|---|---|---|
| Activity bar | Yes | Lapce has it; implementable via a `stack` of clickable icon views |
| Side panel | Yes | `container` with `resizable` drag handle; collapse is manual state management |
| Tabbed editor | Partial | No built-in tab widget in floem 0.1; Lapce rolls its own |
| Bottom panel | Yes | Same approach as side panel |
| Status bar | Yes | Trivial: a styled `h_stack` pinned to bottom |
| Command palette | Partial | No built-in fuzzy palette; hand-roll a modal with a `text_input` + filtered list |
| Diff view | No | No built-in; would need a custom `diff` widget |
| Inline terminal | No | No terminal emulation; would need to integrate `vte` + custom canvas widget |

**Resizable split panes.** Supported via Floem's `split` view with drag handles. Lapce
uses this for its editor splits.

**Markdown rendering.** No built-in. Integration with `comrak` (CommonMark parser) +
custom `floem` widget for rendering styled text blocks is the path. Syntax highlighting
via `syntect`. Non-trivial but well-defined work.

**Terminal emulation.** Not built in. Lapce has a terminal panel that uses `alacritty_terminal`
with a custom Floem canvas widget as the renderer. The integration exists; it can be
studied and adapted.

**Effort to use Floem for charm.** Medium-high. The framework is designed for third-party
use and has published crates. Activity bar, side panel, status bar are straightforward.
The hard parts — tabs, command palette, diff view, terminal — all require custom widgets,
but Lapce source provides reference implementations for most of them.

**Verdict: Partial.** All patterns are achievable, but several require custom widget work.
Better third-party story than GPUI. Lapce source is a usable reference. The framework is
still young (0.1.x); expect API changes.

---

### 3. iced

**What it is.** Elm-architecture inspired Rust GUI framework. The most popular
"pure Rust" GUI crate by downloads. Windowing via `winit`, rendering via `wgpu`
(custom shader pipeline) or `tiny-skia` (software). Version 0.12 / 0.13.

**VSCode-style layout verdict.** iced has `pane_grid` — a first-class multi-pane split
layout with draggable dividers. It does NOT have a dock/panel concept, activity bar, or
tab widget out of the box. Everything above `pane_grid` must be hand-rolled.

**Pattern-by-pattern:**

| Pattern | Support | Notes |
|---|---|---|
| Activity bar | No | Build from `Column` of `Button`s with icon rendering |
| Side panel | Partial | `pane_grid` gives resizable panes; collapse logic is manual |
| Tabbed editor | No | No built-in tab widget; hand-roll or use community `iced_aw` crate |
| Bottom panel | Partial | `pane_grid` row; or a fixed-height `Container` at the bottom |
| Status bar | Yes | `Container` with fixed height at the bottom of the root layout |
| Command palette | No | Hand-roll a modal overlay with `text_input` + filtered `Scrollable` list |
| Diff view | No | Fully custom; render line-by-line with colored rows |
| Inline terminal | No | Integrate `vte` + custom canvas; no existing community example |

**Resizable split panes.** Yes — `pane_grid` is iced's strongest feature for this use case.

**Markdown rendering.** No built-in. `iced_markdown` exists as a community crate but is
experimental. Alternatively: use `comrak` to parse to AST, then render each node as iced
widgets. More work than a TUI markdown renderer because iced widgets carry layout state.

**Terminal emulation.** No community iced terminal widget exists as of mid-2025. The path
is: `vte` crate for ANSI parsing, custom `Canvas` widget for rendering, manual cell
buffer management. This is the most significant gap: a real terminal widget is roughly
1,000-2,000 lines of code to get right.

**Effort to use iced for charm.** High. The pane-grid foundation is solid, but everything
above it — tabs, activity bar, command palette, diff view, terminal — must be built from
scratch. iced's Elm architecture also means every UI action propagates as a message through
the entire app, which is clean but verbose for a complex multi-panel layout.

**Verdict: No (without significant custom work).** iced is capable but requires the most
from-scratch widget work of any framework evaluated. The Elm architecture is a good fit
for charm's event-driven semantics, but the missing high-level widgets make this a
high-effort path.

---

### 4. egui + egui\_dock

**What it is.** Immediate-mode GUI inspired by Dear ImGui. `egui` is the core crate;
`egui_dock` is a community crate (well-maintained, 1,000+ GitHub stars) that adds a
VS Code-style dockable tab system. Used widely for developer tools and game engine editors
(Bevy's inspector uses egui).

**VSCode-style layout verdict.** This is the fastest path to VSCode-style layout in
native Rust. `egui_dock` provides exactly the panel/tab/dock model charm needs, including
floating windows, tab dragging, and hierarchical splits. The immediate-mode model means
custom widgets are trivial to add.

**Pattern-by-pattern:**

| Pattern | Support | Notes |
|---|---|---|
| Activity bar | Partial | No first-class concept; implement as a narrow `SidePanel` with icon buttons. Simple. |
| Side panel | Yes | `egui::SidePanel` — collapsible, resizable, built in |
| Tabbed editor | Yes | `egui_dock::DockArea` + `TabViewer` trait; drag-and-drop tabs included |
| Bottom panel | Yes | `egui::TopBottomPanel` — built in |
| Status bar | Yes | `egui::TopBottomPanel` pinned to bottom |
| Command palette | Partial | No built-in; implement as an `egui::Window` modal with `TextEdit` + filtered list. Easy given immediate mode. |
| Diff view | Partial | No built-in; render as a `ScrollArea` with line-colored rows. Short to implement. |
| Inline terminal | Partial | `egui-term` (community crate) exists but is young; alternatively integrate vte + custom `egui::Painter` cell grid |

**Resizable split panes.** Yes — `egui_dock` handles this automatically. Splits are
draggable and tabs can be moved between panes.

**Markdown rendering.** `egui-commonmark` crate provides CommonMark rendering in egui
panels. Syntax highlighting via `syntect`. This is production-quality and easy to integrate.

**Terminal emulation.** `egui-term` is a community crate providing a terminal emulator
widget backed by `alacritty_terminal`. It is young (2024) but functional enough for
basic use. Alternatively: vte + custom painter, roughly 800-1,200 lines.

**Effort to use egui for charm.** Low-to-medium. The `egui_dock` + `egui::panels`
combination gives you ~70% of VSCode-style layout in a weekend. The remaining gaps
(activity bar icon strip, command palette, diff view, terminal) are each small standalone
widgets. Immediate mode means you can prototype fast.

**Gotcha:** immediate mode redraws every frame. For charm's use case (streaming agent logs),
this is actually fine — there's always something updating. For a fully idle UI, you need
`egui`'s "only repaint on event" mode, which it supports.

**Gotcha:** immediate mode scales less well as layouts get complex. A 5-panel charm UI
with deeply nested state will require more care than the same layout in a retained-mode
framework. The pattern is to mirror all charm state in a plain Rust struct and borrow
from it during the frame; this is idiomatic egui but different from React's component model.

**Verdict: Yes.** The closest thing to a complete, practical VSCode-style layout in Rust
today. `egui_dock` solves the hardest structural problem. Recommended for a charm GUI
prototype.

---

### 5. Tauri v2 (webview-based, Rust backend)

**What it is.** Not a "Rust UI framework" in the traditional sense. Tauri uses the
platform's native webview (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux)
for the frontend and a Rust process for the backend. The frontend is an ordinary web app
(any framework: React, Svelte, Vue).

**VSCode-style layout verdict.** Trivially achievable — you are writing a web app. CSS
flexbox/grid, a tab component library, a tree component, command palette libraries — all
the VSCode patterns exist as mature web ecosystem packages. Monaco Editor (VSCode's
editor) is literally available as an npm package. xterm.js provides a real terminal
emulator for the browser.

**Pattern-by-pattern:**

| Pattern | Support | Notes |
|---|---|---|
| Activity bar | Yes | CSS + any icon library; 30 minutes of work |
| Side panel | Yes | Any tree component; collapsible with CSS transitions |
| Tabbed editor | Yes | Dozens of tab library options; or use the existing Ink console React code as a starting point |
| Bottom panel | Yes | CSS flexbox |
| Status bar | Yes | CSS flexbox |
| Command palette | Yes | `cmdk` (React), Svelte equivalents; production-quality fuzzy search |
| Diff view | Yes | `react-diff-viewer`, `monaco-diff-editor` |
| Inline terminal | Yes | `xterm.js` — full VT100/ANSI terminal emulation in the browser |

**Rust backend / daemon integration.** The existing charm daemon (TypeScript/Bun) can be
bundled as a Tauri sidecar. The Tauri frontend communicates via Tauri's IPC (`invoke`,
`listen`) or directly over the existing JSON-RPC Unix socket via Tauri's `tauri-plugin-shell`
or a localhost HTTP server. No architectural changes to charmd are required.

The existing React code in `src/console/app.tsx` is Ink-specific (`Box`, `Text`, `useInput`)
but the state logic is reusable. Porting the three Ink tabs to browser React would take
1-2 days, primarily replacing Ink components with HTML equivalents.

**Gaps for charm use.**

- Webview adds a runtime dependency (WKWebView is always present on macOS; Windows requires
  WebView2, which ships with Win11 but needs a separate install on Win10).
- A webview app is not a "pure Rust" binary. The UI logic is JavaScript; the Rust layer
  is the backend shell.
- Bundle size is larger than a native GUI. Not a practical concern for a developer tool.
- Streaming agent log updates into the webview requires either Tauri events (push from
  Rust to JS) or polling the daemon's RPC socket from the JS side. Both patterns are
  documented and straightforward.

**Effort to use Tauri for charm.** Low. This is the fastest path to a polished,
feature-complete VSCode-style UI. The web ecosystem has solved every pattern charm needs.
The PROP-rust-rewrite feasibility note pegged the Tauri path at roughly the same effort
as Electron; for VSCode-style layout specifically, Tauri has the lowest gap-to-close of
any option here.

**Verdict: Yes (with caveat).** If "VSCode-style layout" is the goal and you're willing
to use web tech for the UI layer, Tauri is the fastest and most complete path. The Rust
backend keeps systems-level code in Rust. The trade-off is that the UI is JS/TS, not
Rust — which may or may not matter depending on whether the goal is a Rust showcase or
a good product.

---

## Prior Art Summary

### Zed (GPUI)

Zed is a production VSCode-competitor shipping to users at scale. Architecture lessons:

- The `Workspace` type owns all panels via a `Dock` abstraction with `left`, `right`, and
  `bottom` positions. Each `DockPosition` holds a `PanelHandle` vec; showing/hiding a panel
  is just a state flag.
- `Pane` is the tab container. Multiple `Pane`s are organized into a `PaneGroup` tree of
  horizontal/vertical splits. This is exactly the editor area charm needs.
- The status bar is a separate `StatusBarItem` registration system — items register
  themselves and render independently. Charm's "agent count" and "cost ticker" fit this
  model perfectly.
- The command palette is built on an action registry: every action has a type-erased `Box<dyn Action>`,
  and the palette fuzzes over action names. For charm this generalizes to tickets/KB entries/agents.
- Terminal: Zed uses `alacritty_terminal` as a library, not the Alacritty binary. The
  `TerminalView` GPUI component owns a `Terminal` (alacritty model) and a `TerminalElement`
  (custom GPUI element that renders cell grids using GPU-accelerated glyph atlas). This is
  ~2,000 lines for the terminal view alone — real work.

### Lapce (Floem)

Lapce's layout is structurally simpler than Zed's but demonstrates the key patterns in
Floem's reactive model:

- Activity bar: a `stack` of icon buttons bound to `PanelKind` enum; toggling a panel
  updates a `RwSignal<HashMap<PanelKind, bool>>`.
- Side panel: a `container` with a `resizable_split` vs the main editor area. Collapse
  is handled by giving the split a zero width when the panel is hidden.
- Tabs: Lapce implements its own tab bar as a horizontal scrollable list of `TabHeader`
  items. Each tab knows its `EditorTabChild` (file, diff, settings).
- Terminal: uses `alacritty_terminal` with a custom Floem canvas element. The Floem
  element draws into a `peniko::Blob` pixel buffer and the terminal input/output goes
  through a background thread.

The Lapce source (particularly `lapce-app/src/panel/` and `lapce-app/src/terminal/`) is
the most directly applicable reference for building a similar layout in Floem.

---

## Gap Analysis: What Charm Would Need to Build From Scratch

Regardless of framework, several components require custom work:

| Component | Effort (any framework) | Notes |
|---|---|---|
| Markdown renderer with syntax highlighting | 2-4 days | `comrak` (AST) + `syntect` (highlighting) + custom render pass per framework |
| Command palette fuzzy search | 1-2 days | `nucleo` crate (the fuzzy matcher Helix uses) does the matching; the UI shell is trivial |
| Diff view | 2-3 days | `similar` crate for diff computation; visualization is framework-specific rendering |
| Inline terminal widget | 4-7 days | `alacritty_terminal` handles the model; the widget (cell grid, cursor, scrollback) is substantial per-framework rendering work |
| Activity bar icons | 0.5 days | SVG or bitmap icons; all frameworks have some form of image rendering |

The terminal widget is the single largest variable. Any framework can theoretically host
one, but the implementation effort is the same underlying work: parse ANSI with vte, maintain
a cell grid, render glyphs. egui-term provides a head start; Zed's `TerminalView` and
Lapce's terminal are reference implementations.

---

## Verdict Matrix

| Framework | Activity bar | Side panel | Tabbed editor | Bottom panel | Status bar | Command palette | Diff view | Inline terminal | Overall | Effort |
|---|---|---|---|---|---|---|---|---|---|---|
| GPUI | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes (via alacritty_terminal) | Full | Very high — not designed for external use |
| Floem | Yes | Yes | Partial | Yes | Yes | Partial | No | Partial (Lapce reference) | Partial | Medium-high — framework designed for external use, young |
| iced | No | Partial | No | Partial | Yes | No | No | No | Low | High — too much missing |
| egui + egui_dock | Partial | Yes | Yes | Yes | Yes | Partial | Partial | Partial (egui-term) | Good | Low-medium — fastest prototype path |
| Tauri (web frontend) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes (xterm.js) | Full | Low — UI is web; Rust is just the backend |

---

## Recommendation

**For a charm GUI prototype: egui + egui_dock.**

It is the only framework that delivers VSCode-style layout structure (docking, tabs,
side panels, bottom panel, status bar) from existing crates without vendoring a
production editor's entire framework. A working layout scaffold can be built in a week.
The gaps (command palette, terminal, diff view) are all small, well-scoped widgets.

The main risk is egui's immediate-mode model at scale. For charm's use case — an
operator tool with one active session, not a text editor with 10,000 files — immediate
mode is not a performance concern.

**For a production-quality charm desktop app: GPUI or Tauri.**

If charm is targeting the quality bar of Zed (native-feel, GPU-accelerated, no webview),
GPUI is the only framework that has proven it can deliver that. The investment is large
and the API is unstable, but all the hard layout and terminal problems are already solved
in Zed's source.

If the goal is a polished product shipped to users, Tauri + web frontend is the fastest
path to completeness. Every VSCode pattern has a mature web solution. The existing charm
React code is a starting point. xterm.js handles the terminal. This is not a compromise;
it is how many successful developer tools ship.

**Avoid iced** for this use case. Its strengths (Elm architecture, wgpu rendering) are
not relevant to the layout problem, and it has the most missing widgets.

**Floem is a watch item.** If Lapce matures and Floem's API stabilizes, it will be the
cleanest pure-Rust path. It is not there yet for a first prototype.

---

## Open Questions for the Orchestrator

1. Is the goal a TUI enhancement (Ratatui, already covered in PROP-rust-rewrite) or a
   native desktop GUI window? This doc assumes the latter.
2. Is "pure Rust UI" a requirement, or is Tauri's webview model acceptable?
3. Is the inline terminal a hard requirement for the first milestone, or can charm's
   initial GUI rely on the existing tmux panes for agent output?
4. T-013 (framework landscape) and T-018 (GPUI deep-dive) are running in parallel —
   their findings may update the egui and GPUI assessments above once complete.
