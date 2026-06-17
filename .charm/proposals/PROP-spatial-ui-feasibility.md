# PROP-spatial-ui-feasibility

**Status:** draft
**Ticket:** T-015

---

## Verdict

**Skip for now.** Spatial canvas UI is technically feasible in Rust but requires a
large, largely-from-scratch rendering investment that does not address any current
workflow bottleneck. The approval flow, KB navigation, and agent monitoring are
all well-served by a TUI. The force-directed graph (`charm-graph`) already exists
as a standalone spatial viewer. A full canvas UI should only be reconsidered if
charm becomes a distributed product used by non-terminal operators — at which point
the correct substrate is a web canvas via Tauri, not a native Rust renderer.

---

## Research Questions

### 1. Which Rust frameworks have primitives for infinite canvas / pan-zoom?

**egui**
The most widely-used immediate-mode Rust GUI framework. `egui::Area` supports
floating, overlapping widgets at arbitrary positions. `egui::Frame` with a custom
`eframe` painting pass can host a `ScrollArea` with a transform, but infinite canvas
pan-zoom is not a built-in primitive — it requires manual transform math (scale a
`Vec2` offset by a zoom factor, apply to all child positions, handle mouse drag deltas).
Several community projects (e.g. `egui_node_graph`, `egui_extras`) demonstrate
node-graph editors on top of egui's canvas, so this pattern is established.

The limiting factor: egui is designed for tooling UI (settings panels, inspector
windows). Its layout model is not naturally spatial — each frame is stateless and
re-executed from scratch. Node/canvas applications built on egui accumulate position
state in a `HashMap<NodeId, Pos2>` that lives outside the immediate-mode loop.

**GPUI**
Zed's framework. Has explicit 2D `Transform` types, `Bounds<Pixels>`, and an
`Element` protocol that composites via GPU-accelerated painting. It is the most
capable Rust GUI framework for high-performance spatial rendering. However, GPUI is
not a general-purpose library — it was purpose-built for Zed and its API surface
changes frequently. There is no published crate; you vendor the source. The
documentation is sparse outside of Zed's own codebase.

GPUI can absolutely do infinite canvas, but the answer to "how much work?" is
"read Zed's source and adapt it," because there is no canvas abstraction to import.

**Dioxus**
React-style framework, primarily targeting web and desktop (via webview). There is
no built-in canvas primitive. The practical path is to embed an HTML `<canvas>` element
in the webview and drive it with JavaScript/WebGL from the Rust side via Tauri IPC.
This is the Tauri/web-canvas hybrid discussed in question 3 below.

**Ratatui**
The standard Rust TUI crate. Not relevant for spatial UI — it renders to a character
grid, not a 2D coordinate space.

**wgpu / raw GPU**
Any custom spatial canvas could be built on `wgpu` directly. This is the lowest-level
option and the highest implementation cost. There is no scene graph, no layout engine,
no widget library. It makes sense for a game or a specialized renderer, not for a
dev-tool UI.

**Slint**
Declarative Rust GUI with GPU rendering. Has some scene-graph capabilities. Younger
than egui, smaller ecosystem, but type-safe UI descriptions via a custom DSL. Not
designed for infinite canvas; the work would be similar to egui.

**Summary table:**

| Framework | Canvas primitives | Pan-zoom built-in | Maturity | Verdict |
|---|---|---|---|---|
| egui | `Area`, `Painter`, manual transform | No, manual | High | Best pure-Rust option |
| GPUI | `Transform`, GPU compositing | No, manual | High (Zed only) | Most capable; highest buy-in cost |
| Dioxus | None (webview) | Via JS/WebGL | Medium | Delegate to web canvas |
| wgpu | Full GPU API | Build from scratch | High | Only if owning rendering stack |
| Slint | Declarative scene | No | Medium | Similar effort to egui |

---

### 2. What crates exist for force-directed graph layout in Rust?

**fdg-sim** (`crates.io/crates/fdg-sim`)
The most targeted option. Implements force-directed graph simulation with
configurable repulsion/attraction forces. Designed to work with any renderer —
it produces `Vec<(NodeId, position)>` positions each tick, leaving drawing to the
caller. Well-suited for embedding in an egui canvas loop. Active at time of
research (last release 2024).

**petgraph** (`crates.io/crates/petgraph`)
Graph data structure library (adjacency list, directed/undirected). Provides
algorithms (DFS, BFS, Dijkstra, topological sort) but **no layout or force
simulation**. It is a complement to `fdg-sim`, not an alternative: `petgraph` holds
the graph topology, `fdg-sim` simulates positions.

**layout-rs** (`crates.io/crates/layout`)
Implements the Sugiyama hierarchical layout algorithm (layered, like Graphviz's dot).
Good for DAGs with a natural top-down reading order (ticket dependency trees).
Deterministic — no simulation. Less useful for free-floating spatial exploration.

**Custom physics**
`charm-graph` already implements a bespoke 3D force-directed simulation (~100 lines
of TypeScript). Porting it to Rust is straightforward (the physics is simple: repulsion
proportional to 1/r^2, spring attraction toward edges, velocity damping). No
external crate strictly required.

**Recommendation for charm:** use `fdg-sim` for force-directed layout (if following the
spatial canvas path), `petgraph` for the underlying graph structure, and `layout-rs`
for the ticket dependency DAG view where topological order matters more than free
positioning.

---

### 3. Implementation cost: native Rust canvas vs web canvas (Tauri/Dioxus)

#### Path A: egui infinite canvas

| Piece | Effort |
|---|---|
| egui app scaffold (eframe, event loop) | 0.5 day |
| Pan-zoom transform: drag to pan, scroll to zoom, coordinate conversion | 1 day |
| Ticket card widget: rounded rect, title/status/stage, live-update streaming | 2 days |
| Edge rendering: draw lines between cards with arrowheads | 0.5 day |
| Force layout via fdg-sim: tick simulation, apply positions to card map | 1 day |
| Card expand (click to show plan/log inline, smooth resize animation) | 1.5 days |
| Approval modal overlay on canvas | 1 day |
| Daemon IPC: new HTTP or Unix socket subscription feed for card updates | 2 days |
| Polish (selection highlight, zoom-to-fit, label readability at different zoom levels) | 1.5 days |
| **Total** | **~11 days** |

Risks:
- egui's immediate-mode loop makes smooth animation (card expand, edge follow) harder
  than in a retained-mode system. Each animated property needs manual interpolation
  state stored outside the loop.
- egui ships as a native window, not inside the tmux session. It becomes a second OS
  window alongside `charm-graph`, which already has this problem.
- Text rendering in egui uses its own font rasterizer — quality is good but not
  terminal-native. The experience is different from the TUI console.

#### Path B: Tauri with web canvas (HTML Canvas2D / Fabric.js / Konva.js)

| Piece | Effort |
|---|---|
| Tauri app scaffold (sidecar daemon, Tauri IPC bridge) | 2 days |
| HTML Canvas2D pan-zoom: existing libraries (Konva.js, Fabric.js) | 0.5 day |
| Card rendering in Canvas2D (custom draw calls or Konva Group) | 1.5 days |
| Edge rendering (Konva Line with arrowhead) | 0.5 day |
| Force layout: existing JS library (d3-force, @antv/layout) | 0.5 day |
| Card expand / streaming update (WebSocket from sidecar daemon) | 2 days |
| Approval modal in HTML over canvas | 0.5 day |
| Daemon HTTP/WS layer (needed for Tauri IPC) | 2 days |
| Polish | 1.5 days |
| **Total** | **~11 days** |

Advantages over Path A:
- The web canvas ecosystem is far more mature for exactly this use case. Konva.js and
  Fabric.js are purpose-built for infinite canvas node graphs. d3-force is the
  reference force-directed layout implementation.
- Obsidian's canvas is built this way (Electron + Canvas2D), so there is direct prior
  art and community tooling.
- Tauri shares work with the broader Electron/web track (PROP-charm-harness-ui-revamp
  Track B). A canvas UI built on Tauri is a natural extension of that investment.

Disadvantages:
- Rust is only the shell; the canvas logic is JavaScript. If the motivation was
  native Rust rendering, Tauri does not deliver it.
- Tauri adds a Rust build dependency and WebView system dependency. On macOS, WKWebView
  is bundled; on Linux, WebKitGTK must be installed.

#### Comparison

Both paths cost roughly the same (11 days). Path A is pure Rust but uses a
non-standard rendering model that requires more custom work per interaction. Path B
gets spatial UI faster via mature web canvas libraries and is consistent with the
Track B direction in PROP-charm-harness-ui-revamp. If spatial UI is ever built, Path
B is the recommended substrate.

---

### 4. Prior art: Obsidian's canvas

Obsidian Canvas (released January 2023) is built on Electron with a custom Canvas2D
renderer. Key implementation choices:

- Cards are `<canvas>` draw calls, not DOM elements. This allows 10,000+ cards without
  DOM performance cliffs.
- Pan and zoom are implemented as a CSS `transform: translate(x,y) scale(z)` applied
  to a single container div. Obsidian does NOT use Canvas2D transforms — instead it
  uses CSS transforms on a positioned container, which hardware-accelerates via the
  browser's compositor. This is simpler and faster than manual Canvas2D matrix math.
- Edge arrows are SVG overlays, positioned absolutely over the canvas container.
- Force layout is NOT used. Cards are placed manually by the user; there is no
  auto-layout. The dependency arrow rendering is purely cosmetic.

**Lesson for charm:** if adopting the Obsidian approach, the canvas is not a drawing
surface — it is a positioned container (`position: relative; overflow: hidden`) holding
absolutely-positioned card divs, panned/zoomed via CSS transforms. Arrows are SVG.
This is dramatically simpler than a Canvas2D or WebGL implementation. A prototype
could be built in a few days of HTML/CSS, no canvas API needed.

The force-directed layout (from `charm-graph`) would be an optional auto-arrange
feature, not the primary mode.

---

### 5. Spatial UI and the approval workflow

The current approval flow is modal: an approval gate pauses the orchestrator, the
console flips to the Approvals tab, the operator presses y/n. This is intentionally
disruptive — it demands attention.

On a canvas, two options:

**Option A: overlay modal.** When a gate arrives, a semi-transparent modal appears
over the canvas. The operator approves/rejects in the modal; the canvas is visible
behind it. This is the natural canvas equivalent and preserves the same forcing
function. Implementation: a React/HTML element absolutely positioned over the Tauri
WebView, outside the canvas layer. No changes to the approval RPC semantics.

**Option B: in-card approval.** The ticket card that triggered the gate shows an
inline y/n prompt. The operator clicks it directly on the canvas. This is spatially
coherent (the decision is co-located with the work) but requires the card to carry
approval state and the canvas to remain usable while a gate is open.

Option A is lower risk for a first implementation. Option B is the more interesting
spatial design but needs care to ensure gates are not missed.

The approval gating mechanism (daemon's `await_approval`, `approve_gate` RPC) is
UI-agnostic and requires no changes for either option.

---

### 6. Performance ceiling

**How many cards at 60fps?**

With the CSS-transform approach (Obsidian method):

- The browser's compositor handles pan/zoom at 60fps natively via hardware
  acceleration. No JavaScript runs on each frame during a smooth pan.
- Cards are DOM elements; the browser layout engine re-renders them only when their
  content changes. At 60fps pan/zoom, only the container's CSS transform changes.
- Real-world ceiling: ~500-1000 cards before scroll/pan becomes noticeably laggy
  on typical hardware (GPU memory and DOM node count are the limits, not frame math).
- charm's typical session: 10-50 tickets. Canvas perf is not a concern at any
  realistic scale.

With Canvas2D (manual draw calls):

- All cards are drawn each frame. At 60fps with 50 cards: trivial.
- With 500 cards: still fine (Canvas2D handles thousands of draw calls at 60fps).
- The frame budget is consumed by edge routing (quadratic in edges) and text
  measurement (expensive in Canvas2D). Spatial indexing (quad-tree) would be needed
  above ~2000 visible edges.

With egui (Path A):

- egui runs on wgpu and can push thousands of widgets at 60fps. The limiting factor
  is the per-widget Rust allocation cost, not the GPU. For charm's scale (10-50
  agents/tickets), egui performance is irrelevant.

**Streaming agent output:** Live streaming into card text areas is the real
performance question. If 8 agents each stream 10 lines/second, the canvas must
re-render ~80 cards/second with new text. With CSS-transform cards (DOM), each update
is a `textContent` mutation — cheap. With Canvas2D, each update requires re-drawing
the affected card — also cheap at charm's scale. This is not a concern.

---

## Framework Recommendation (if building)

**Tauri + CSS-transform canvas (Obsidian approach).**

Reasons:
1. Lowest implementation risk. CSS transforms for pan/zoom are battle-tested and
   hardware-accelerated. No canvas math to debug.
2. Most mature ecosystem for node-graph interactions (drag, snap, selection).
3. Consistent with the Electron/Tauri track in PROP-charm-harness-ui-revamp. The
   canvas UI would be a view within a Tauri app that also includes the existing tab
   UI, not a separate tool.
4. Force-directed layout via d3-force or @antv/layout, both production-quality.
5. The Rust layer (Tauri) handles IPC and system integration; the canvas logic is
   in its natural habitat (browser APIs).

The egui (Path A) option is viable but accumulates ~11 days of effort into a
rendering approach that is harder to maintain and extends into an unusual niche
(native Rust GUI). It is the right choice only if the project is committed to a
pure-Rust, no-webview binary, and accepts the egui model's constraints.

---

## Estimated Effort (if building)

| Milestone | Approach | Estimate |
|---|---|---|
| Proof-of-concept canvas (pan, zoom, 5 static cards, edges) | Tauri + CSS-transform | 2 days |
| Live-updating cards from daemon stream | + WebSocket feed | 2 days |
| Force layout (auto-arrange) | + d3-force integration | 1 day |
| Approval modal overlay | + approval RPC | 1 day |
| Expandable cards with log streaming | | 1.5 days |
| Polish and keyboard nav | | 2 days |
| **Total (Tauri canvas prototype)** | | **~9-10 days** |

This is additive to the Track B work in PROP-charm-harness-ui-revamp (which covers
the Tauri shell, daemon HTTP/WS layer, and existing tab UI). If Track B is in flight,
the canvas view is an additional ~5-6 days of frontend work on top of that foundation.

---

## Recommendation Summary

| Question | Answer |
|---|---|
| Feasible in Rust? | Yes — native (egui/GPUI) or hybrid (Tauri + web canvas) |
| Best framework? | Tauri + CSS-transform canvas (if building) |
| Force-directed layout? | fdg-sim (Rust) or d3-force (JS via Tauri) |
| Implementation cost? | ~9-10 days (Tauri); ~11 days (egui); both assume Tauri/HTTP daemon work done |
| Approval flow impact? | Modal overlay; no daemon changes needed |
| Performance ceiling? | Not a concern at charm's scale (10-100 tickets) |
| Build vs skip? | **Skip.** Spatial UI solves a problem charm does not have yet. |

The existing TUI serves the current use case well. The force-directed graph
(`charm-graph`) already provides spatial navigation of the KB. A canvas UI becomes
worth building if:

1. charm is used by operators who do not work in a terminal, or
2. The number of concurrent agents/tickets routinely exceeds what a list-based UI
   can navigate (roughly >50 concurrent tickets), or
3. The ticket dependency graph becomes complex enough that linear lists obscure
   relationships.

None of these conditions hold today. The right sequencing is:

1. Close the current TUI gaps (KB browser, proposals tab) — 2-3 days.
2. If TUI ceiling is hit, migrate to Bubble Tea (PROP-charm-harness-ui-revamp Track A).
3. Only start a canvas UI when charm is being shared with non-terminal users (Track B).
4. Canvas view is a follow-on to Track B, not a standalone effort.
