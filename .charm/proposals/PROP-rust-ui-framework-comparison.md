# PROP-rust-ui-framework-comparison

**Status:** draft
**Produced by:** T-013 worker
**Related:** PROP-charm-harness-ui-revamp, PROP-rust-rewrite, KB decision `prop-ui-revamp-feasibility`

---

## Purpose

Survey every serious Rust UI framework and score them across the dimensions charm
needs, so that a future decision on "which framework for charm's native desktop app"
has grounded input rather than vibes.

charm context for this evaluation:
- The daemon is TypeScript/Bun and stays that way regardless of UI choice.
- The current console is Ink (React TUI). A native app replaces the TUI pane.
- Primary developer is TypeScript-fluent, not a Rust expert.
- Target platform is macOS first; Linux/Windows are nice-to-have.
- UI requirements: markdown viewer, file tree, diff view, force-directed graph,
  possibly a terminal emulator pane (for streaming agent output), approval prompts.
- Distribution: personal/team tool today, potentially wider later.

Prior work summary (from `prop-ui-revamp-feasibility` KB note):
- Track A was Bubble Tea (Go TUI) — ~6-7 days, clean TS/Go boundary.
- Track B was Electron/Tauri local app — ~17-25 days.
- Recommendation was: close Ink gaps first, then Track A, Track B only when sharing
  with non-terminal users.
- This research informs what Track B looks like if we go Rust-native instead of
  Electron.

---

## Frameworks Covered

1. Tauri — web renderer + Rust backend
2. Dioxus — React-like, cross-platform
3. Slint — declarative, GPU-accelerated
4. Iced — Elm-like, wgpu
5. egui — immediate mode, wgpu/glow
6. GPUI — Zed's framework
7. Floem — reactive, wgpu
8. xilem — Google experimental
9. Wails — Go (contrast, not Rust)

---

## Per-Framework Profiles

### 1. Tauri (v2.x)

**Rendering backend:** System WebView — WKWebView on macOS, WebView2 on Windows,
webkit2gtk on Linux. The frontend is HTML/CSS/JS; the Rust side handles native calls
(file system, OS APIs, IPC). No bundled browser engine; relies on the OS.

**Performance:**
- Startup: ~400-800ms on macOS (WebView initialization dominates).
- Idle memory: ~50-90MB (WebView process included).
- CPU at 60fps animation: minimal in Rust side; depends on frontend complexity.
- Bundle size: ~5-10MB (no bundled Chromium).

**Maturity and stability:**
- v2.0 released October 2024. Production-proven. 85k+ GitHub stars.
- Large ecosystem of plugins (tauri-plugin-updater, tauri-plugin-fs, etc.).
- Stable API; v1->v2 was the big breaking change; v2.x is stable.
- Security model is a first-class concern (allowlist/capability system).

**Package ecosystem for charm needs:**
- Markdown: react-markdown, remark, MDX — all first-class.
- Code highlighting: Shiki, Prism, CodeMirror — any web solution works.
- Tree view: any React tree component library.
- Diff view: react-diff-viewer, monaco-diff — no problem.
- Terminal emulation: xterm.js is the gold standard; it is used in VS Code and
  works perfectly in Tauri's WebView.
- Force-directed graph: D3.js force, vis.js, cytoscape.js — all work.
- Drag-and-drop: react-dnd, dnd-kit — standard web solutions.

**Ease of development:**
- Frontend: standard TypeScript/React/Vite workflow with hot module reload.
  A TypeScript-fluent developer writes the entire UI in familiar tooling.
- Backend: Rust with tauri::command macros to expose Rust functions to JS.
  The Rust side can stay thin (just wrapping the charm daemon socket calls).
- Compile times: incremental Rust builds are fast for a thin backend; Vite rebuilds
  are near-instant.
- Hot reload: full HMR for frontend; Rust side requires rebuild+restart.

**macOS distribution:**
- Code signing and notarization: built-in via `tauri-cli`. Probably the best
  distribution story of any framework on this list.
- Auto-update: `tauri-plugin-updater` handles update checking, download, install.
- Universal binaries (arm64 + x86_64): supported.
- .dmg and .app bundle: both supported out of the box.

**Known issues:**
- webkit2gtk on Linux is notoriously inconsistent; some distros ship outdated versions.
- WebView renders differently across platforms (rare CSS divergence).
- xterm.js in WebView adds iframe-in-app overhead for terminal panes.

---

### 2. Dioxus (v0.5/0.6)

**Rendering backend:** Desktop target uses WebView (via Wry, the same WebView
abstraction Tauri uses). Native target (liveview) uses WGPU-based rendering. TUI
target uses Ratatui. Web target uses the browser DOM.

**Performance (desktop WebView target):**
- Startup: ~400-700ms (similar to Tauri, same underlying Wry).
- Idle memory: ~50-80MB.
- Native target would be faster but is less mature.

**Maturity and stability:**
- v0.5 released 2024, v0.6 in progress as of mid-2025. Pre-1.0, breaking changes
  between versions. 22k+ GitHub stars.
- Active development; the team is responsive but the API is not settled.
- Desktop support is stable enough for personal tools; production deployments are
  riskier.

**Package ecosystem:**
- Desktop (WebView) target inherits the same web ecosystem as Tauri.
- Native target: Dioxus has a growing component library but it is thinner than
  Tauri's web-based option.
- For charm, the WebView target is the practical choice, making this similar to
  Tauri in ecosystem terms.

**Ease of development:**
- React-like component model with signals (similar to SolidJS). A TypeScript/React
  developer would feel at home.
- The Rust syntax for JSX-like templates (the `rsx!` macro) is close to JSX but
  requires learning Dioxus-specific patterns.
- Hot reload: yes, for components.
- Compile times: moderate Rust compile overhead.

**macOS distribution:**
- Works but less polished than Tauri. No built-in updater plugin; you would build
  your own.
- Code signing is doable but requires more manual setup than Tauri.

**Verdict:** Dioxus is a credible option if you want a React-like model in Rust with
desktop/web/TUI target flexibility. For charm's use case, Tauri is more mature and
has a better distribution story with essentially the same frontend development
experience.

---

### 3. Slint (v1.x)

**Rendering backend:** GPU-accelerated via Metal (macOS), Vulkan (Windows/Linux),
and a software fallback for embedded. Uses its own 2D scene graph renderer, not
WebView. The UI is defined in `.slint` files (a declarative DSL).

**Performance:**
- Startup: <100ms typical. Very fast, no WebView init.
- Idle memory: <20MB. One of the most memory-efficient options.
- CPU at 60fps animation: low, GPU-driven.
- Bundle size: ~5-15MB (includes the Slint runtime; no OS dependency).

**Maturity and stability:**
- v1.0 released 2023, actively maintained by SixtyFPS GmbH. 18k+ GitHub stars.
- Production use in embedded/automotive/industrial UIs.
- API is stable for the 1.x series.
- Less community adoption in the desktop application space compared to Tauri/egui.

**Package ecosystem:**
- This is Slint's major weakness for charm.
- No markdown renderer — you would build your own text rendering.
- Code highlighting: no off-the-shelf Slint widget; would need syntect output
  rendered as styled text spans.
- Tree view, diff view, terminal emulation: all DIY. The Slint widget library is
  thin; most applications ship their own widgets.
- Force-directed graph: custom painting via Slint's canvas API.

**Ease of development:**
- The `.slint` DSL is its own language; non-trivial learning curve.
- Slint Studio provides live preview of `.slint` files.
- Hot reload: live preview tool exists but is separate from the main app.
- Compile times: fast (Slint files compile quickly; Rust side is normal Rust).

**License:**
- Dual-licensed: GPL v3 or commercial (paid) for closed-source products.
- For an open-source charm, GPL is fine. For a future commercial distribution, the
  commercial license cost matters.

**macOS distribution:**
- Works. No built-in updater.
- Less documentation on code signing + notarization than Tauri.

**Verdict:** Slint is excellent for embedded and resource-constrained targets. For
charm, the thin widget ecosystem means you would spend significant time building
UI primitives instead of charm features. The license situation is also a constraint
if charm ever goes commercial.

---

### 4. Iced (v0.12/0.13)

**Rendering backend:** wgpu (GPU-accelerated via Metal/Vulkan/DirectX). Pure Rust
renderer using the Elm-like Model-View-Update architecture.

**Performance:**
- Startup: ~150-300ms (wgpu init is non-trivial).
- Idle memory: ~30-55MB (wgpu overhead included).
- Rendering quality: good. Text rendering via cosmic-text (same text stack as
  Cosmic DE).

**Maturity and stability:**
- Pre-1.0 as of mid-2025. 25k+ GitHub stars. Used by System76's Cosmic DE.
- API has had breaking changes across minor versions. Not yet stable.
- The Cosmic DE use case proves it can power a full desktop environment, but Cosmic
  ships patched forks of iced rather than stock.
- Active core team, but slow velocity on the main repo.

**Package ecosystem:**
- Thinner than Tauri or egui. Some community widget crates exist but quality varies.
- Markdown: `iced_aw` has basic markdown; not production-grade.
- Code highlighting: integrations with syntect exist as community crates.
- Tree view, diff view: DIY or very basic community crates.
- Terminal emulation: no ready-made iced terminal widget.
- Force-directed graph: custom canvas drawing.

**Ease of development:**
- Elm architecture is clean and testable but verbose for complex UIs.
- No hot reload for Rust code. The compile-run-observe cycle slows iteration.
- Compile times: moderate. The wgpu/iced compile step is noticeable on cold builds.
- Async integration: iced has its own subscription/command model that can feel
  alien coming from React or Elm.

**macOS distribution:**
- Works but no built-in tooling. Manual code signing setup required.

**Verdict:** Iced is architecturally appealing but not pragmatically ready for a
feature-rich app like charm. The widget ecosystem gaps would mean significant
investment in UI primitives, and the pre-1.0 API churn adds risk.

---

### 5. egui (v0.28+)

**Rendering backend:** Immediate mode. Backends available: eframe (wgpu or glow),
or web canvas. On macOS, eframe uses wgpu (Metal) by default.

**Performance:**
- Startup: <100ms. Among the fastest of any option on this list.
- Idle memory: ~20-35MB.
- CPU: immediate mode redraws every frame; idle CPU is near zero with `ctx.request_repaint_after`.
- Bundle size: ~8-15MB.

**Maturity and stability:**
- Near-stable API (v0.28+ is largely backward-compatible within a minor version).
  29k+ GitHub stars.
- Very widely used in Rust developer tools, visualizations, and game dev tooling
  (Rerun, Bevy inspector, many others).
- Not pre-packaged for consumer app distribution; strong in the developer-tool niche.

**Package ecosystem:**
- syntect integration: well-supported; egui_extras ships a CodeEditor widget.
- Markdown: egui_commonmark is a mature markdown renderer for egui.
- Tree view: egui has built-in collapsing headers and tree structures; egui_extras
  adds more.
- Diff view: no dedicated widget; achievable with colored text spans.
- Terminal emulation: no ready-made widget, though the rendering primitives are
  there to build one.
- Force-directed graph: egui_graphs and fdg_sim exist for graph visualization.
- Drag-and-drop: built-in drag-and-drop support in egui_extras.

**Ease of development:**
- Immediate mode is the fastest way to build a working UI in Rust. No state
  management overhead; just write what you see.
- Compile times: fast. egui has a clean dependency tree.
- Hot reload: standard Rust rebuild cycle; no framework-level hot reload.
- Layout: less expressive than CSS/flex for complex layouts. Tables, panels, and
  split panes are supported but require more manual calculation.

**macOS distribution:**
- eframe ships as a standard Rust binary. macOS code signing is a manual step.
- No built-in updater. You would add a crate like `self_update` separately.
- Universal binary: just set the right Cargo targets.

**Verdict:** egui is the fastest path to a working developer tool in Rust. For charm's
use case it gets you 80% of the way with low effort. The 20% is layout expressiveness
— the complex split-panel + tab UI that charm needs is achievable in egui but requires
more manual work than a flex-based CSS layout. egui is best suited for a prototype or
a minimal-viable native build.

---

### 6. GPUI (v0.1+, Zed's framework)

**Rendering backend:** Metal (macOS), Blade (cross-platform GPU abstraction over
Vulkan/Metal/DX12). Retained-mode reactive UI with a signal-based state model.
Custom text rendering (Zed's own text layout engine). GPU-composited at every frame.

**Performance:**
- Startup: <50ms. Zed cold-starts in under a second including editor state load.
- Idle memory: ~15-25MB for the UI layer alone.
- CPU at 60fps: near zero when idle; GPU-driven compositing.
- This is the highest-performance UI runtime on this list.

**Maturity and stability:**
- Used in production at Zed (the code editor). Production-proven for a demanding
  use case: multi-cursor editing, large file trees, terminal emulator, markdown
  preview, diff views.
- However, GPUI was extracted from Zed as an open-source framework but is not
  designed for external adoption. The API carries Zed-specific abstractions (Entity,
  Model, View, Window) that are not documented for general use.
- 8k GitHub stars on the GPUI crate itself; much larger visibility through Zed.
- API stability: no versioning guarantees. Breaking changes happen with Zed's
  development needs, not a framework-user's needs.
- Documentation: thin. Primary reference is Zed's own source code.

**Package ecosystem:**
- Almost none. GPUI is a framework where you build everything yourself, as Zed did.
- Zed's source ships its own markdown renderer, syntax highlighter (Tree-sitter),
  terminal emulator (Alacritty-based), diff view, and tree view — all as internal
  Zed modules that are tightly coupled to GPUI's internal types.
- Extracting these as standalone crates for use in charm would require significant
  adaptation.

**Ease of development:**
- For a developer coming from React: the signal/reactive model will feel familiar in
  concept, but the Rust-specifics (entity handles, strong ownership discipline, GPU
  submit paths) add meaningful friction.
- No hot reload.
- Compile times: moderate-to-slow (Zed is a large codebase; GPUI as a standalone
  crate compiles faster but still takes time on cold builds).
- The investment required to be productive in GPUI is weeks, not days.

**macOS distribution:**
- Zed ships it flawlessly — Apple Silicon, universal binary, notarized, auto-update.
  The distribution tooling is all in Zed's CI, not in GPUI itself. You would replicate
  Zed's release pipeline, not just use a framework feature.

**Verdict:** GPUI is the ceiling for performance and rendering quality in Rust UI. If
charm becomes a product with serious desktop ambitions and the team is willing to
invest 4-6 weeks building core widgets from scratch, GPUI is a legitimate path. For
charm's current stage — a developer tool in active exploration — the onboarding cost
and sparse ecosystem make it premature. Revisit GPUI when charm has stable UI
requirements and a dedicated Rust engineer.

---

### 7. Floem (v0.1)

**Rendering backend:** wgpu. Reactive signal-based model inspired by SolidJS. From
the Lapce editor team.

**Performance:**
- Startup: ~150-250ms.
- Idle memory: ~25-40MB.

**Maturity and stability:**
- Pre-alpha. 4k GitHub stars. API changes frequently between releases.
- Lapce editor uses a predecessor system; Floem is a cleaner redesign.
- Not recommended for any production or semi-production use today.

**Package ecosystem:** Very limited. You build most things yourself.

**Ease of development:** Reactive model is clean when it works, but the instability
means you spend time chasing API changes.

**macOS distribution:** Works, no tooling.

**Verdict:** Keep on the watch list. If Floem reaches v0.5+ with API stability and a
widget library, it could be a strong option. Not ready today.

---

### 8. xilem (experimental, Google/linebender)

**Rendering backend:** vello (GPU 2D renderer via wgpu). xilem is a reactive
framework built on top of Masonry (a retained-mode widget system) and vello.

**Performance:**
- vello's rendering quality is excellent (anti-aliased 2D via compute shaders).
- xilem startup: variable; the framework is experimental.
- Idle memory: ~20-30MB expected.

**Maturity and stability:**
- Experimental. API changes weekly/monthly. 4k GitHub stars.
- Not production-ready. Google and linebender are actively investing but the
  timeline to stability is unknown.
- Masonry (the widget layer) is more mature than xilem and could be used separately,
  but it is still pre-1.0.

**Package ecosystem:** Almost nothing. Building any real app means building all
widgets from scratch.

**Verdict:** Do not use for charm now. Promising architecture (vello is genuinely
excellent) but too early to build on. Check back in 2027.

---

### 9. Wails (v3, Go — contrast)

**Rendering backend:** WebView (WKWebView on macOS, WebView2 on Windows) — same
concept as Tauri, implemented in Go.

**Performance:** Similar to Tauri (~400-800ms startup, ~50-80MB idle).

**Maturity and stability:**
- v2 is mature and production-proven. v3 is in active development as of mid-2025.
  25k+ GitHub stars. Large community.

**Ecosystem:** Full web ecosystem for the UI. Go for the backend. Go builds are
fast and the Go stdlib is rich.

**Ease of development:**
- TypeScript/React frontend with hot reload.
- Go backend is simpler to write than Rust (no borrow checker, fast compile cycle).
- The key trade: you pick up Go as a dependency instead of Rust.

**macOS distribution:** Good. Code signing works, though less automated than Tauri's
CLI.

**Verdict for charm:** Wails is the "Tauri but Go" option. Given that charm's daemon
is already TypeScript/Bun, adding Go is a lighter bet than Rust — but Tauri has more
mature distribution tooling and a larger ecosystem for the specific UI needs (terminal
emulation, graphs). Wails is worth considering if the team has Go familiarity and
prefers Go over Rust for the backend glue layer.

---

## Scored Comparison Table

Scores 1-5 (5 = best). Weights reflect charm's priorities.

| Framework | Rendering quality | Startup | Idle memory | Maturity | charm ecosystem | Dev ergonomics | macOS distribution | Total /35 |
|---|---|---|---|---|---|---|---|---|
| **Tauri v2** | 4 | 3 | 3 | 5 | 5 | 5 | 5 | **30** |
| **GPUI** | 5 | 5 | 5 | 3 | 2 | 2 | 4 | **26** |
| **egui** | 4 | 5 | 5 | 4 | 3 | 4 | 3 | **28** |
| **Iced** | 4 | 4 | 4 | 3 | 2 | 3 | 3 | **23** |
| **Slint** | 5 | 5 | 5 | 4 | 2 | 3 | 3 | **27** |
| **Dioxus** | 4 | 3 | 3 | 3 | 4 | 4 | 3 | **24** |
| **Floem** | 4 | 4 | 4 | 2 | 1 | 3 | 2 | **20** |
| **xilem** | 4 | 3 | 4 | 1 | 1 | 2 | 1 | **16** |
| **Wails (Go)** | 4 | 3 | 3 | 4 | 5 | 5 | 4 | **28** |

Ecosystem score specifically reflects charm's requirements: markdown rendering, code
highlighting, tree views, diff views, terminal emulation, force-directed graph. A
WebView-based framework (Tauri, Dioxus desktop, Wails) inherits the full web
ecosystem and scores 4-5; pure-Rust native frameworks score lower because charm's
specific UI needs are not well-served by existing Rust crates.

---

## Top Candidates for charm

### 1. Tauri v2 — Recommended

**Why:** Tauri is the most pragmatic choice for charm's current situation. The entire
frontend can be written in TypeScript/React — charm's existing UI development
language. xterm.js handles terminal emulation. D3.js or vis-network handles the
force-directed graph. react-markdown handles markdown. All of these are mature,
well-documented, and already in use in the Electron ecosystem.

The Rust side stays thin: a tauri::command shim that connects to the charm daemon's
Unix socket and forwards RPC calls. This is ~100 lines of Rust, not a full Rust
UI framework investment.

The distribution story is the best on the list: tauri-cli handles code signing,
notarization, universal binaries, and auto-update with first-class support.

**Cost:** ~17-25 days to ship a full replacement for the Ink console (matching the
estimate from `prop-ui-revamp-feasibility`). The WebView startup latency (400-800ms)
is acceptable for a developer tool that stays open; it is not acceptable for a
frequent-launch CLI.

**When to choose:** When charm is ready to graduate from TUI to a proper desktop app
and the team wants to ship without learning a new UI paradigm.

---

### 2. egui — Best for a lightweight prototype

**Why:** egui is the fastest way to build a working Rust-native UI. It has the lowest
startup time, the lowest memory footprint, and the fastest iteration cycle. For a
charm prototype — something to test whether a native app is worth building — egui is
the right tool.

`egui_commonmark` handles markdown. `egui_extras` handles trees and tables.
`egui_graphs` handles force-directed graph layouts. Syntax highlighting via `syntect`
is well-supported. These are not as polished as web solutions but they work.

The limitation: egui's layout model is less expressive than CSS/flex. Building charm's
full UI (resizable split panels, tabbed views, proportional layouts) requires more
manual layout arithmetic than a web-based approach. The UI will never look as polished
as a CSS-styled Tauri app.

**When to choose:** When you want to ship a minimal native build fast (2-4 weeks vs
Tauri's 5-6 weeks) and are willing to accept a more utilitarian visual style. Also
appropriate as a stepping stone to validate native-app value before committing to
Tauri's scope.

---

### 3. GPUI — Long-term ceiling, not current bet

**Why:** GPUI is what a production-grade charm desktop app could look like in 2-3
years. Zed proves the framework works for a feature set that overlaps significantly
with charm's needs: file trees, code highlighting, diff views, terminal emulator,
markdown preview, command palette. The performance headroom is enormous.

The barrier is investment. GPUI has no meaningful third-party widget library — Zed
built everything in-house. charm would need to do the same. That is a 6-12 week
investment for the core widget library alone, before any charm-specific features.

**When to choose:** When charm has product-market fit, a dedicated Rust engineer, and
a reason to optimize for the last 20% of UI performance. Not now.

---

## Recommendation Summary

| When | Framework | Rationale |
|---|---|---|
| Prototype native app quickly | egui | Lowest effort, all required crates exist, fast startup |
| Ship a polished desktop replacement for the TUI | Tauri v2 | Full web ecosystem, TypeScript frontend, best macOS distribution |
| Long-term performance investment | GPUI | Highest ceiling; requires major widget-building investment |
| Team has Go familiarity, not Rust | Wails v3 | Same tradeoffs as Tauri but Go backend; lighter than learning Rust |

The sequence that makes the most sense for charm given the prior `prop-ui-revamp`
recommendation: close Ink gaps first (KB browser, proposals tab — 2-3 days), then if
a native app is needed, build a quick egui prototype to validate value (~2-3 weeks),
then invest in Tauri if the prototype confirms the value of a polished native desktop
app (~5-6 additional weeks).

---

## Appendix: Package Ecosystem Detail

Critical packages for charm's UI needs and their availability per framework:

| Need | Tauri (web) | egui | Iced | Slint | GPUI |
|---|---|---|---|---|---|
| Markdown rendering | react-markdown (excellent) | egui_commonmark (good) | iced_aw basic (limited) | DIY | DIY (Zed has one) |
| Code highlighting | Shiki / CodeMirror (excellent) | syntect integration (good) | syntect (manual) | syntect (manual) | Tree-sitter (Zed's own) |
| Tree view | Any React tree lib (excellent) | egui collapsing / egui_extras (good) | Basic, manual (limited) | DIY | Zed's project panel (internal) |
| Diff view | react-diff-viewer / monaco (excellent) | Manual text spans (limited) | Manual (limited) | DIY | Zed's diff view (internal) |
| Terminal emulation | xterm.js (excellent) | No ready-made (limited) | No (none) | No (none) | Zed's terminal (internal) |
| Force-directed graph | D3.js / vis-network (excellent) | egui_graphs + fdg_sim (good) | Manual canvas (limited) | DIY canvas | DIY | 
| Drag-and-drop | dnd-kit / react-dnd (excellent) | egui built-in (good) | Limited | Limited | Zed's drag handling (internal) |
