# HANDOFF -- building charm on a Zed fork

You are picking up the charm-on-Zed fork. This file is your entry point: what the
project is, what is already decided (do not relitigate), the current state, and
where to start. Everything here is backed by the other docs in this folder --
this is the map, not the territory.

---

## Mission in one paragraph

Fork the Zed editor into charm's native IDE. charm today runs entirely in a tmux
terminal session; the goal is to inherit Zed's terminal emulator, pane system,
file tree, and GPU rendering, and add charm as an overlay on top -- while the
charm daemon backend (ticket store, MCP shim, solver, approvals) stays. This is
an internal, single-operator tool, so GPL-3.0 (Zed's license) is a non-issue.

---

## Start here (read in this order)

1. **orchestration-model.md** -- the architecture spine. The agent hierarchy, the
   `.charm` workspace layout, the agent role + tool-capability contract, and the
   locked v1 decisions. READ THIS FIRST; every phase implements it.
2. **README.md** -- problem framing, why-Zed-over-alternatives, the build
   sequence, and the cross-cutting prototype risks.
3. **phase-0 .. phase-7** -- the per-phase implementation plans (details below).
4. **theme-charm-design.md** -- re-theming the fork to the charm studio design
   language (theme JSON for Zed chrome + a `CharmPalette` struct for the
   charm-specific colors).

---

## Decisions already locked (v1) -- do not relitigate

These were debated and settled. Each is overridable if you find a real reason,
but do not reopen them by default. Full rationale in orchestration-model.md.

- **Agent hierarchy.** One user-facing **orchestrator** (clean context, talks to
  the operator, owns worktree topology) -> one **sub-orchestrator per git
  worktree** (runs the pipeline, spawns/reaps its own workers, absorbs the noisy
  finish/event traffic) -> **workers/investigators/testers** scoped to a worktree.
  The main session has no sub-orchestrator of its own.
- **Gate split.** Stage-2 PLAN gates are owned by the sub-orchestrator INSIDE its
  worktree (they never reach the operator). Stage-4 MERGE-TO-MAIN gates, and any
  escalation a sub-orchestrator cannot resolve, bubble up to the orchestrator and
  surface to the operator.
- **Injection is pull / idle-gated.** The daemon never pastes into the
  orchestrator's input while the operator is composing. The orchestrator pulls
  rollups on its own turn; the fix for the old "my typing collides with an
  injected event" bug.
- **One daemon, one `.charm`.** A single session-level daemon in the main
  workspace owns the single `.charm` (one ticket counter, one KB, one proposals
  tree). Worktree agents write durable artifacts via MCP, not relative paths.
  Per-worktree = the code checkout + symlinked dependency dirs only. Do NOT
  symlink the git-tracked `.charm` subdirs (it fights git).
- **Operator brainstorm lieutenant is dropped for v1.** The clean user-facing
  orchestrator serves that need.

---

## Current state -- what exists and what does not

- **This is a plan, not code.** Every file here is a draft proposal. Nothing has
  been built yet.
- **The Zed source is NOT in this repo.** This repo is the charm harness
  (TypeScript daemon, docs, proposals). Your first real step is to fork Zed into
  its own checkout and start Phase 0 there. The phase docs reference Zed crate
  paths (e.g. `crates/charm`, `crates/theme`) that will exist in YOUR fork, not
  here.
- **The Zed API names in these docs are research-derived, not verified against
  source.** The investigations that produced this plan did not have a Zed
  checkout. Treat specific symbol names (`theme::add_user_theme_from_content`,
  `project.create_terminal()`, `ThemeColors` fields, the theme schema URL) as
  "approximately right -- confirm against the pinned Zed version when you build."
- **The design palette is already extracted.** The charm studio design export
  (the source of the visual language) lives outside this repo with the operator;
  its concrete light+dark hex palette has already been pulled into
  theme-charm-design.md, so you do not need the original to start theming.

---

## How to begin

Phases 0 and 1 are hard blockers; do them first and in order.

1. **Phase 0 -- strip the fork.** Fork Zed, then remove the crates charm will
   never use (login, collab/org, edit-prediction, AI, remote, telemetry,
   auto-update -- ~23 crates). THE TRAP: you cannot just delete a crate while
   others still inherit it via `dependency.workspace = true`. Do a proper
   reverse-dependency teardown (leaf-first), not "delete and fix the fallout."
   Build prereqs on macOS: Rust 1.95.0 (pinned), `cmake`, and the Metal Toolchain
   (~700MB) -- the build fails without them.
2. **Phase 1 -- the bridge.** Scaffold `crates/charm`, add the `CharmBridge`
   socket client + the hierarchical `CharmState` (with `parent_id`, `worktree`,
   `sub_orchestrators`), the polling loop with the `apply()` diff +
   `on_agent_spawned` callback, and the pull/idle-gated injection path.
3. **Then parallelize.** Once Phase 1 lands, Phases 2, 3, 4, 6, and 7 can proceed
   in parallel. Phase 5 (session bootstrap + worktree dependency preflight) is the
   real tail -- it arranges Phases 1, 2, and 4.

---

## De-risk these THREE prototype risks before committing to the full builds

(From the README's cross-cutting open questions. Each is a short spike.)

1. **inject_text / multi-line paste.** The tmux path needed bracketed paste for
   multi-line messages. Confirm a bare `terminal.input(bytes)` with embedded
   newlines lands intact in claude's REPL; if not, wrap in the bracketed-paste
   escape sequence. A bug here causes silent orchestrator-wake failures.
2. **`project.create_terminal()` signature.** Confirm the exact call for spawning
   a terminal with a specific command (not the default shell). `TerminalKind` /
   `TerminalBuilder` are the entry points.
3. **Canvas performance at 15+ agents.** 60fps for GPUI-drawn cards + connectors +
   traveling dots is expected to be within budget but unbenchmarked. A 10-minute
   mock-node prototype is the right mitigation.

---

## Conventions and gotchas

- **ASCII only.** No emoji or pictographic/box-drawing characters anywhere in
  charm files (code, comments, commits, docs). Use `[x]`, `->`, `*`, `-`.
- **GPUI has no SVG / no DOM / no `animateMotion`.** The orchestration canvas
  (Phase 3) is GPUI elements: cards as divs, connectors via `PathBuilder`
  (straight lines), traveling dots via an imperative animation loop. Glow/shadows
  are approximated with layered translucent divs; full glow is post-v1.
- **Do not infer the agent hierarchy from `touches:` paths.** The old charm-studio
  canvas did this; the new model requires the daemon to expose the hierarchy as
  first-class data (Phase 1). Read it from `CharmState`, never re-derive it.
- **Latent charm bug to be aware of.** The `reviewer -> investigator` pipeline
  migration did not backfill old tickets; legacy `status: reviewed` / `stage:
  review` values fail the current schema and block agent spawns. If you hit a
  spawn validation error, check for tickets carrying legacy enum values.

---

## Reference map -- which doc answers what

| Question | Read |
|---|---|
| What is the agent hierarchy / who owns which gate? | orchestration-model.md |
| How does the `.charm` workspace lay out across worktrees? | orchestration-model.md section 3 |
| What does each build phase do? | phase-0 .. phase-7 |
| How do I re-theme the fork? | theme-charm-design.md |
| Is the phase plan internally consistent? | `.charm/kb/zed-phase-consistency-{deps,artifacts,vs-design}.md` |
| Why Zed and not Tauri/extension/GPUI-from-scratch? | README "Why Zed" |
| What is the component / data-flow shape? | architecture-diagram.svg |

---

## Still open (does not block starting)

- Rollup cadence (orchestrator pulls on its own turn vs. timer vs. milestone) --
  default to on-its-own-turn, tune later.
- Caps on concurrent worktrees / sub-orchestrators -- no hard cap in v1.
- Whether the operator brainstorm lieutenant is ever re-added as a distinct
  off-graph helper.
