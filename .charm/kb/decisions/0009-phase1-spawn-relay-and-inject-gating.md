---
id: 0009-phase1-spawn-relay-and-inject-gating
root: decisions
type: decision
status: current
summary: "Phase 1 adopts Option A (apply() diff) for agent-spawn detection and a three-tier idle-gating model for text injection, both avoiding new daemon-side push channels."
created: 2026-06-26
updated: 2026-06-26
---

## Spawn relay: Option A (apply() diff, no new push channel)

The cross-phase audit identified a push-vs-poll gap: all diagrams show
`spawnAgentLocked` as a push arrow from charmd to the bridge, but Phase 1 only
defined a 1500ms poll. Phase 4 (terminal manager) needs to open a pane the
moment a new agent is spawned.

**Decision:** `CharmState.apply()` diffs the incoming agent list against the
previous snapshot on every poll cycle. For each agent ID that is new, it fires
an `on_agent_spawned(agent_id, worktree)` callback. Phase 4 registers this
callback once at bridge construction. No new daemon push channel, no protocol
extension. The diagram's `spawnAgentLocked` arrow is understood as "the status
poll detects the spawn."

**Why Option A over Option B (new push channel):** Option B would require adding
a server-push frame to the daemon socket protocol plus a second listener in the
bridge. That is new daemon code that all other phases would need to know about.
Option A is self-contained in the bridge and adds no daemon surface area. The
worst-case latency is one poll cycle (1500ms), which is acceptable for opening a
terminal pane.

## Inject dispatch: three-tier idle-gating

The raw `terminal.input()` call is correct but must be gated to prevent the
typing-collision hazard (worker event pasted into orchestrator input while
operator is composing).

**Decision:** the inject dispatcher classifies the target agent by tier using
`CharmState.agents[id].parent_id` + role and applies different gating:

- **Orchestrator terminal:** queue payload; deliver only at TerminalView idle
  (operator not composing). Orchestrator pulls rollups on its own turn.
- **Sub-orchestrator terminals:** idle-gated, but delivery delay is acceptable
  (it is the "allowed to get messy" layer).
- **Leaf agents (workers/investigators/testers):** direct `terminal.input()`,
  no gating.

**Why:** the orchestrator is the only agent where a collision is operator-visible
and harmful. Sub-orchestrators are noisy by design. Leaf agents are never
composing messages the operator interacts with.

**How to apply:** any future change to the injection path must respect this
three-tier contract. Adding a new inject call site should route through the
single `dispatch_inject()` entry point in `CharmBridge`, not call
`terminal.input()` directly.
