# PROP-zed-fork-build-plan

**Status:** draft

Fork the Zed editor into the charm native IDE. This proposal is split across
phase files (linked below) because the implementation detail will grow large.
This README is the entry point: the problem, the high-level approach, the build
sequence, and cross-cutting decisions. Each phase file owns the detailed
implementation plan for that slice.

A color-coded component + data-flow diagram (STAY / KEPT / per-phase) is saved
alongside this README as [architecture-diagram.svg](architecture-diagram.svg).

## Document map

**Picking this up cold? Start with [HANDOFF.md](HANDOFF.md)** -- the orientation
prompt: locked decisions, current state, and where to begin.

Read these in order:

1. **[orchestration-model.md](orchestration-model.md)** -- the architecture spine.
   Defines the agent hierarchy (one user-facing orchestrator + per-worktree
   sub-orchestrators + workers), the single-daemon / single-`.charm` workspace
   layout, the agent role + tool-capability contract, and the v1 decisions the
   phases build against. **Read this first; the phases implement it.**
2. **This README** -- problem, why-Zed, build sequence, cross-cutting questions.
3. **phase-0 .. phase-7** -- the per-phase implementation plans.
4. **[theme-charm-design.md](theme-charm-design.md)** -- re-theming the fork to
   the charm studio design language (theme JSON + `CharmPalette`).

---

## Problem

The charm harness runs entirely in a tmux terminal session. This was the right
call for speed-to-working, but it caps what the orchestration UI can express,
limits the operator experience to terminal power-users, and makes approval
gates and agent-fleet visualizations hard to surface without modal context
switching.

The goal is to move charm to a Zed-based native IDE that inherits the terminal
emulation, pane management, and GPU-accelerated rendering already built into
Zed — while keeping the daemon, MCP shim, ticket store, and all agent behavior
completely unchanged.

This is an internal, single-operator tool. GPL-3.0 (Zed's license) is not a
concern.

---

## Why Zed (and not the alternatives)

| Option | Verdict | Why |
|---|---|---|
| **Fork Zed** | **Chosen** | Inherits terminal emulator, pane system, file tree, markdown renderer for free. GPL is fine for internal use. |
| GPUI-as-library (build from scratch) | Rejected | Apache-2 license, but 6-12 weeks rebuilding terminal/panes/tree/markdown before parity with what Zed ships today. |
| Zed extension | Hard no | Extensions cannot render custom panels, access Unix sockets, or embed arbitrary UI (T-023). |
| Tauri + React (current plan) | Deferred | Still right if charm ever becomes a publicly distributed product. The Zed fork is specifically for the internal-use, performance-first scenario. |

### Why this overrules the investigation's own recommendation

The investigations that fed this plan (T-023, T-025) explicitly recommended
**staying on Tauri + React** and *not* adopting Zed/GPUI. That recommendation
was correct under its stated assumptions — and those assumptions have since
changed. The recommendation rested on three premises, two of which no longer
hold:

1. **"GPL-3.0 is a material risk."** True only for a distributed commercial
   product. This is now scoped as an internal, single-operator tool, so GPL is
   a non-issue (T-026 confirmed). This premise is void.
2. **"The animated SVG canvas is the hero and is browser-native."** The design
   has since moved to a card-flow layout (`Orchestration Canvas.dc.html`) that
   is mostly plain divs — far more GPUI-friendly than the old SVG star graph.
   The "must keep a WebView for the canvas" argument is much weaker now.
3. **"Iteration speed favors React's HMR."** Still true, and still a real cost
   of the Zed path. This premise stands and is the genuine tradeoff we are
   accepting in exchange for native terminal/pane/editor reuse and startup
   performance.

So the pivot is not a contradiction of the evidence — it is the same evidence
re-evaluated after the internal-use decision and the design's move away from
SVG. We accept the slower Rust iteration cycle (premise 3) as the price.

---

## UI architecture: additive, not a takeover

The guiding principle: **keep Zed's normal IDE experience intact and add charm
as an overlay on top of it.** charm does not replace the editor — it sits
alongside it.

- **File explorer** — Zed's native `ProjectPanel`, kept as-is. A second "Charm"
  view in the same left area shows the `.charm/` workspace (tickets, kb,
  COORDINATION.md), matching the Files/Charm tab split in the design.
- **File editor** — Zed's native `Editor`, kept as-is. You open, edit, and save
  files exactly as in stock Zed.
- **Orchestration view** — an **optional tab in the center pane**, opened on
  demand (command or activity-bar button). It renders the orchestrator/agent/
  worktree card layout with animated connectors. It is one `Item` among your
  normal editor tabs — not a hero that takes over the window. Close it and you
  are back to plain editing.
- **Right sidebar** — Orchestrate tab (session stats + live/complete ticket
  list) and General tab (summary, model/context, conversation), matching the
  design's right panel.

This is a lighter touch than a full console replacement: most of charm's
read-out lives in the right sidebar and the optional center tab, while the
left side stays a normal file explorer.

## What stays vs. what changes

**Mostly unchanged (the daemon backend):** charm-mcp shim, ticket store, schema,
solver, approvals queue, COORDINATION.md writer, and the existing agent-facing
RPC methods. These are 100% tmux-free today.

**New on the daemon (from the orchestration model):** the daemon gains the
orchestrator -> sub-orchestrator -> worker hierarchy as first-class state
(`agent.parent_id`, `agent.worktree`, a sub-orchestrator record), returns that
tree from the `status` RPC, routes worker finish-events to the owning
sub-orchestrator instead of the orchestrator, splits gate ownership (Stage-2 plan
gate per-worktree, Stage-4 merge gate to the orchestrator), and runs the
worktree dependency-sharing preflight. So "the daemon is completely unchanged" is
no longer accurate -- it is unchanged *except* for these hierarchy additions. See
[orchestration-model.md](orchestration-model.md).

**Kept from Zed (native, no work):** file explorer (`ProjectPanel`), file editor
(`Editor`), terminal (`terminal_view`), pane/tab management, command palette,
markdown rendering (`MarkdownElement`).

**Changes:** the eight tmux touch-points in `src/daemon/index.ts`
(`spawnAgentLocked`, `tearDownAgent`, `pingOrchestrator`, `continue_agent`,
`sweepDeadPanes`, `relayoutLocked`, `set_mode`, `spawn_suborchestrator`) get
replaced by calls into the Zed fork over a new bridge. The Ink TUI console and
`charm-graph` are replaced by the right sidebar, the optional orchestration tab,
and a Charm explorer view.

**The one hard thing:** GPUI has no SVG renderer, no DOM, no `animateMotion`.
The orchestration view (the optional center tab) must be rendered as GPUI
elements — cards as divs, connectors via `PathBuilder`, traveling dots via an
imperative animation loop. See [Phase 3](phase-3-orchestration-canvas.md).

---

## Build sequence

| Phase | File | Description | Unlocks |
|---|---|---|---|
| 0 | [phase-0-strip-fork.md](phase-0-strip-fork.md) | Strip removed features (login, collab/org, edit-prediction, AI, remote, telemetry, auto-update); keep terminal + debugger + panel layouts | Everything else |
| 1 | [phase-1-charm-bridge.md](phase-1-charm-bridge.md) | Charm bridge: IPC + state entity | Live data for all UI |
| 2 | [phase-2-console-panels.md](phase-2-console-panels.md) | Right sidebar + Charm explorer view | Real-time fleet view |
| 3 | [phase-3-orchestration-canvas.md](phase-3-orchestration-canvas.md) | Orchestration view (optional center tab) | The visualization |
| 4 | [phase-4-terminal-tabs.md](phase-4-terminal-tabs.md) | Per-agent terminal tabs + injection | Spawn/kill/wake agents |
| 5 | [phase-5-session-bootstrap.md](phase-5-session-bootstrap.md) | Session bootstrap + CLI | Clean operator UX |
| 6 | [phase-6-approval-gates.md](phase-6-approval-gates.md) | Approval gate UX | Stage 2 + 4 gates |
| 7 | [phase-7-orchestrator-hub.md](phase-7-orchestrator-hub.md) | Orchestrator Hub | Multi-session management |

Phases 0 and 1 are blockers. Once Phase 1 is complete, Phases 2, 3, 4, 6, and 7
can all proceed in parallel: Phase 6 needs only Phases 1 + 2 (the Orchestrate tab
that hosts the gate banner), and Phase 7 needs only Phase 1. Phase 5 is the real
tail -- it arranges Phases 1, 2, and 4 (Phase 3 is opened on demand and is not a
boot prerequisite). "Phases 5-7 are polish" was the old framing; only Phase 5 is
genuinely late.

Every phase implements [orchestration-model.md](orchestration-model.md) -- the
hierarchy and `.charm` layout there are the contract. Phase 1 (hierarchical
`CharmState`) and Phase 5 (worktree preflight + sub-orchestrator spawn) carry the
bulk of the new model.

---

## Cross-cutting open questions

These spanned multiple phases. All three de-risk spikes have now been RUN against
a real Zed checkout -- full results in `.charm/kb/zed-spike-results.md`.

1. **`project.create_terminal()` signature** — **RESOLVED.** No
   `create_terminal` at the pinned version; the call is
   `Project::create_terminal_task(SpawnInTerminal, cx) -> Task<Result<Entity<Terminal>>>`.
   `TerminalKind`/`TerminalBuilder` framing was wrong. (See Phase 4.)

2. **`inject_text` push flow** — **PARTIALLY RESOLVED.** The terminal-side call
   is `Terminal::paste(&str)` (NOT raw `input()`); it already does the
   bracketed-paste wrapping the tmux path needed. The daemon-to-bridge push
   mechanism (which transport carries the notification) is still a Phase 1
   design choice; the terminal API it lands on is settled. (Affects Phases 1, 4.)

3. **Canvas performance at 15+ agents** — **RESOLVED. PASS.** A charm-realistic
   scene (16 cards + 15 connectors + 15 animated dots) ran at ~118fps avg in an
   unoptimized debug build, 0.7% of frames over the 60fps budget, not
   vsync-capped. Comfortable headroom; release is faster. (Affects Phase 3.)

---

## Source research

Full evidence for every claim here lives in the investigation tickets:

- **T-023** — Zed/GPUI architecture, three customization paths, license
- **T-024** — charm harness deep-dive, TerminalBackend analysis, what ports
- **T-025** — design integration, color token system, GPUI canvas feasibility
- **T-026** — fork setup, build system, the 23 crates to strip, Gram prior art
- **T-027** — Zed internals: Panel/Item traits, PathBuilder, terminal spawning
- **T-028** — full charm-to-Zed component mapping, top 3 prototype risks

---

## Status: draft
