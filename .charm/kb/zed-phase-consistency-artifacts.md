# Zed-fork build plan: cross-phase consistency audit

Investigation ticket: T-033
Audited: phase-0 through phase-7, README.md, architecture-diagram.mmd

---

## Verdict table

| # | Entity / Symbol | Phases involved | Verdict |
|---|---|---|---|
| 1 | `CharmBridge` struct shape | 1 (def), 2, 4, 5 | CONSISTENT |
| 2 | `CharmState` fields | 1 (def), 2, 3, 6 | CONSISTENT |
| 3 | `agent_id -> Terminal` handle map -- diagram label vs. code type | all diagrams | INCONSISTENT |
| 4 | `spawnAgentLocked` relay mechanism | 1, 4 (diagram + text) | INCONSISTENT |
| 5 | `inject_text` / push mechanism | 1, 4 | CONSISTENT (open question, both phases acknowledge) |
| 6 | `status` RPC name and direction | 1 (def), all diagrams | CONSISTENT |
| 7 | `spawn_task` (Zed TerminalPanel API) | 1 (diagram), 4 (code) | CONSISTENT |
| 8 | `register_panes` RPC | 1 (daemon section), 5 | CONSISTENT |
| 9 | `orchestrator_pane` RPC | 5 only | REFERENCED BUT NEVER DEFINED |
| 10 | `approve_gate` RPC | 6 (def), all diagrams | CONSISTENT |
| 11 | `tearDownAgent` | 4 (text), all diagrams | CONSISTENT |
| 12 | `sessions_manifest` RPC | 7 (def), all diagrams | CONSISTENT |
| 13 | Phase 6 `Depends on` header | 6 header vs. 6 body | INCONSISTENT |
| 14 | Panel/dock placement (left/center/right) | README, all diagrams, 2, 3 | CONSISTENT |
| 15 | `crates/charm` module names for Phases 3-7 | 3, 4, 5, 7 | GAP (incomplete, not contradictory) |

---

## Discrepancy detail

### D1: Handle map diagram label says "TerminalView" but code holds `Entity<Terminal>`

All eight diagrams (architecture-diagram.mmd plus per-phase mermaid blocks in phases 0-7)
contain:

    handlemap["agent_id -> TerminalView map"]

Both Phase 1 and Phase 4 code snippets use `Entity<Terminal>`:

    Phase 1: "The bridge keeps a map of `agent_id -> Entity<Terminal>` populated as agents spawn"
    Phase 4: "The bridge holds `agent_id -> Entity<Terminal>`"; bridge.register_terminal(agent_id, terminal)

`Terminal` and `TerminalView` are different Zed types. `Terminal` is the PTY backend with
`input()` for text injection. `TerminalView` is the UI widget. The map must hold
`Entity<Terminal>` for injection to work.

Fix: In architecture-diagram.mmd and in all per-phase mermaid diagrams, change:
    handlemap["agent_id -> TerminalView map"]
to:
    handlemap["agent_id -> Entity<Terminal> map"]

Blast radius: diagram files only. Code snippets are already correct.

---

### D2: `spawnAgentLocked` relay mechanism -- diagram implies push, only polling is defined

Architecture diagram and all per-phase copies show:
    charmd ==>|"spawnAgentLocked"| bridge   (primary data-flow arrow, push-style)

Phase 4 body: "When the daemon fires `spawnAgentLocked` (relayed to the bridge), open a new
terminal in the agents pane."

Phase 1 defines only a 1500ms polling loop on the `status` RPC. No phase defines how the
bridge detects a new agent to trigger `spawn_task`. The push-style diagram arrow is
inconsistent with the polling-only implementation.

Two consistent resolutions:

Option A (polling diff, recommended): `CharmState.apply()` diffs the incoming agent list
against the previous snapshot; for each new `agent_id`, it fires an `on_agent_spawned`
callback registered by Phase 4's terminal manager. No new daemon code. The diagram arrow
should be relabeled to show the path runs through the status poll.

Option B (push extension): Add a push channel as described in Phase 1 section "Daemon-side
change" (option a or b). The diagram arrow is accurate as drawn. Requires new daemon code.

Phase 1 worker must resolve this before Phase 4 can proceed; it determines what `apply()`
must do and whether the bridge needs a spawn-callback API.

---

### D3: Phase 6 `Depends on` header references non-existent `ApprovalsPanel`

Phase 6 header:
    **Depends on:** Phase 2 (ApprovalsPanel), Phase 1 (gate state)

Phase 6 body (same file):
    "(Earlier drafts and T-028 section 2 described a standalone left-dock ApprovalsPanel;
    that is superseded by the design's right-sidebar layout. There is no separate approvals
    panel.)"

Fix: Change the Phase 6 header to:
    **Depends on:** Phase 2 (Orchestrate tab in right sidebar), Phase 1 (gate state)

---

### D4: `orchestrator_pane` RPC referenced in Phase 5 but never defined

Phase 5 (`charm resume` detail):
    "re-register its handle with the daemon via `orchestrator_pane`. The daemon side
    (`orchestrator_pane` RPC) is unchanged -- only the handle type differs."

This RPC name appears only in Phase 5. It is absent from: the architecture diagram, Phase 1
daemon-side section, Phase 4, all other phases.

The phrase "is unchanged" implies it already exists in the daemon today. If so, it is missing
from the diagram. If it does not exist, Phase 5 must define it.

Fix: Verify `orchestrator_pane` in `src/daemon/index.ts`. If it exists, add it to the
architecture diagram. If it does not, Phase 5 must define it alongside `register_panes`.

---

### Gap G1: Module names for Phases 3-7 in `crates/charm/` not specified

Named: `charm_bridge.rs` (Phase 1), `charm_explorer.rs` and `charm_sidebar.rs` (Phase 2).
Unnamed: OrchestrationItem/CanvasState (Phase 3), terminal management (Phase 4),
auto-detect (Phase 5), HubView (Phase 7).

No contradictions. The incomplete module map creates ambiguity for workers on later phases.

Recommended fix: Phase 1 scaffold adds a `crates/charm/src/charm.rs` (the crate root per
`[lib] path = "src/charm.rs"`) that declares `mod` lines for all expected submodules upfront,
even as stubs. This gives later workers an unambiguous home for their code.
