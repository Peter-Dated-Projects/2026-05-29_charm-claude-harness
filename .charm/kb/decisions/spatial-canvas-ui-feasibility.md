---
id: spatial-canvas-ui-feasibility
root: decisions
type: decision
status: current
summary: "Spatial canvas UI is feasible (Tauri + CSS-transform is the best path) but should be skipped until charm is shared with non-terminal users or ticket volume exceeds ~50 concurrent."
created: 2026-06-16
updated: 2026-06-16
---

# Decision: Spatial Canvas UI — Skip for Now

## What was evaluated

Feasibility and framework fit for an Obsidian-style infinite canvas showing
charm tickets/agents as draggable cards with dependency edges and embedded
force-directed KB graph.

## Decision

Skip. The existing TUI (and planned Bubble Tea upgrade) serves the current use case.
Spatial canvas UI solves a problem charm does not yet have.

## Framework recommendation (if revisited)

Tauri + CSS-transform canvas (Obsidian approach) — not native Rust (egui/GPUI).
CSS transforms handle pan/zoom at 60fps via the browser compositor with no frame
math. d3-force or @antv/layout for force layout. This is additive on top of
PROP-charm-harness-ui-revamp Track B (~5-6 additional days once the Tauri shell
and daemon HTTP/WS layer exist).

## Rust-native canvas options assessed

- **egui**: feasible, ~11 days, but immediate-mode model requires manual animation state
  and results in a native OS window (not inside tmux).
- **GPUI**: most capable, but no published crate; must vendor Zed source; API unstable.
- **wgpu**: full GPU API; full implementation cost; only for owning the rendering stack.

## Force-directed graph layout crates

- `fdg-sim` — force simulation, outputs positions, no renderer; best fit.
- `petgraph` — graph topology/algorithms only; no layout; complements fdg-sim.
- `layout-rs` — Sugiyama DAG layout; useful for ticket dependency tree (deterministic).

## Build trigger conditions

Revisit when any of these hold:
1. Charm is used by non-terminal operators (distributable product).
2. Concurrent ticket count routinely exceeds ~50 (list UI breaks down).
3. Ticket dependency graph is deep enough that linear lists obscure relationships.

**Why:** [[prop-ui-revamp-feasibility]] establishes Track B (Tauri) as the right
native app path; canvas is a follow-on view within that app, not a standalone effort.
