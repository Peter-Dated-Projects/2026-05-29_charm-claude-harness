# Consistency audit: 8-phase Zed-fork plan vs worktree-orchestration model and design export

**Source:** T-034 investigation (2026-06-26)
**Reads:** all phase-*.md files in PROP-zed-fork-build-plan; PROP-worktree-orchestration-model.md; Agent orchestrator setup/uploads/HANDOFF.md; canvas mockup pasted-1782238930269-0.png

---

## What the worktree-orchestration model introduces (summary)

Five architectural additions not present when the 8-phase plan was written:

1. **Three-level hierarchy.** One user-facing orchestrator -> one per-worktree sub-orchestrator -> leaf workers/investigators. The sub-orchestrator absorbs all noisy finish/event traffic; the orchestrator stays clean.
2. **First-class hierarchy in CharmState.** The bridge must carry `agent.parent_id`, `agent.worktree`, and a `SubOrchestratorRecord` type so the canvas can render the tree directly rather than inferring it from `touches:` paths.
3. **Push->pull / idle-gated text injection.** The daemon must not paste into the orchestrator's live input while the operator is typing. Injection should be queued and delivered at a turn boundary or gated on "operator idle."
4. **Single `.charm`, single daemon, MCP-mediated writes.** Worktree agents write durable artifacts through MCP, not by writing their own copy of `.charm`. One ticket counter, one registry, one KB.
5. **Worktree dependency-sharing preflight.** On worktree creation, detect gitignored dep dirs (`node_modules`, `.venv`, `target/`), share by symlink only when the worktree's lockfile hash matches main's, prompt operator once, persist config.

---

## Per-phase consistency verdict

### Phase 0 - strip-fork: CONSISTENT

No hierarchy concern. Phase 0 only removes crates. The worktree model changes nothing about what gets stripped or kept.

### Phase 1 - charm-bridge: NEEDS REVISION (critical)

Three gaps:

**Gap 1 - flat CharmState struct.** The defined struct is:

    pub struct CharmState {
        pub tickets: Vec<Ticket>,
        pub agents: Vec<AgentRecord>,
        pub pending_gates: Vec<PendingGate>,
        pub coordination: String,
        pub session: SessionMeta,
    }

This is the old flat model. Required additions:
- `pub sub_orchestrators: Vec<SubOrchestratorRecord>` (new type: id, worktree, status, agent_count)
- `agent.parent_id: Option<AgentId>` on `AgentRecord`
- `agent.worktree: Option<String>` on `AgentRecord`

Without these, Phase 3 (canvas) has no first-class data and must fall back to the infer-from-`touches:` approach the worktree model explicitly rejects.

**Gap 2 - no idle-gated injection.** The `inject_text` section describes a bare `terminal.input(bytes)` call with no gating logic. The worktree model requires the bridge to check "is the operator mid-input?" before writing to the orchestrator's terminal. Add: when the inject target is the orchestrator terminal, gate delivery on a TerminalView idle signal; queue if the operator is composing.

**Gap 3 - daemon status RPC must return hierarchy.** The daemon's `status` RPC response currently returns a flat agents list. It must be extended to include `parent_id` and `worktree` per agent, and a sub-orchestrators list, so the bridge can populate the revised CharmState.

### Phase 2 - console-panels: CONSISTENT (minor note)

The Orchestrate tab's stat row ("ACTIVE / WORKTREES / TICKETS") already matches HANDOFF section 10.1 ("active count, worktree count, total ticket count"). The sidebar layout is consistent with the design export. The one minor gap: the ticket list does not describe grouping by sub-orchestrator/worktree. This is a UI detail, not a structural contradiction, and can be addressed when building Phase 2. No blocking revision required.

### Phase 3 - orchestration-canvas: NEEDS REVISION

Two gaps:

**Gap 1 - WorktreeGroup missing sub-orchestrator field.** The CanvasState struct has `worktrees: Vec<WorktreeGroup>` but does not show an explicit `sub_orchestrator: SubOrchestratorCard` field inside `WorktreeGroup`. The design export (HANDOFF section 7.2 and canvas mockup) is explicit: each worktree has a distinct sub-orchestrator square (smaller square, different shade from the orchestrator). The struct needs:

    pub struct WorktreeGroup {
        pub sub_orchestrator: SubOrchestratorCard,  // renders as a smaller square
        pub agents: Vec<AgentCard>,                 // render as circles
        pub box_bounds: Rect<Pixels>,
    }

**Gap 2 - hierarchy derivation path.** Phase 3 says "Built from CharmState (Phase 1)" but CharmState (as written in Phase 1) has no hierarchy fields, so Phase 3 would have to infer via `touches:`. After Phase 1 is revised, Phase 3 must explicitly state that `WorktreeGroup` is derived from `CharmState.sub_orchestrators` and `agent.worktree` fields, not from `touches:` scanning.

**Gap 3 - connector shape contradicts design.** Phase 3 describes "curved/elbow lines" for connectors. HANDOFF section 7.4 says "Edges are straight lines from a parent node to a child." The Zed/GPUI build should default to straight lines matching the design. Note the deviation explicitly if curves are chosen.

### Phase 4 - terminal-tabs: NEEDS REVISION (minor)

Two gaps:

**Gap 1 - sub-orchestrators also need terminal tabs.** Phase 4 only describes spawning agent terminals. With the worktree model, each sub-orchestrator is also an agent pane. The phase should note that sub-orchestrator panes are spawned similarly to worker panes but are grouped/labeled distinctly (e.g. "sub-orch: zed-fork" vs "T-034 investigator"). The bridge's handle map must cover sub-orchestrator IDs as well as leaf agent IDs.

**Gap 2 - injection section does not reference idle-gating.** The text injection section (pingOrchestrator path) does not mention the idle-gated delivery added in Phase 1. Add a cross-reference: injection to the orchestrator terminal follows the idle-gated path; injection to sub-orchestrator and worker terminals uses direct `terminal.input()`.

### Phase 5 - session-bootstrap: NEEDS REVISION (major)

The worktree model names Phase 5 as one of the two primary integration points ("Phase 5 (bootstrap): the worktree setup preflight and dependency-sharing"). Phase 5 as written has none of this.

Three gaps:

**Gap 1 - worktree dependency-sharing preflight entirely absent.** Must add a section covering:
- Detect gitignored dependency dirs: `node_modules`, `.venv`/`venv`, Rust `target/`, build caches (`.next`, `dist`).
- Lockfile-aware sharing rule: symlink a dep dir to the main worktree's copy only when the worktree's lockfile hash matches main's (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `uv.lock`). If a branch changes deps, do not share - install locally.
- Prompt the operator once on first worktree creation with detected suggestions. Persist the answer to `.charm/worktree-config.json` (or equivalent) so future worktrees apply it automatically.
- Rust `target/` is opt-in due to cargo lock contention.

**Gap 2 - sub-orchestrator spawn missing from auto-detect sequence.** The six-step auto-detect sequence handles the main session but says nothing about what happens when a worktree is created. Add a step: when `charm create_worktree` (or equivalent) creates a new worktree, (a) run the dependency preflight for that worktree, then (b) spawn a sub-orchestrator in that worktree. The sub-orchestrator terminal is registered with the daemon via `register_panes`.

**Gap 3 - register_panes must cover sub-orchestrators.** The `register_panes` RPC currently registers the orchestrator and agents pane. In the worktree model it must also register each sub-orchestrator's terminal handle. Phase 5 should describe this.

### Phase 6 - approval-gates: NEEDS MINOR REVISION

The worktree model introduces a gate routing rule (open question #1 in that doc): plan-stage gates are owned by the sub-orchestrator within its worktree; merge-to-main gates bubble to the orchestrator. Phase 6 currently treats all gates identically, presenting any entry in `CharmState.pending_gates` to the operator.

Add a note: `pending_gates` in CharmState should carry only gates that require the operator's decision (merge-to-main gates and gates that escalated past the sub-orchestrator). Plan-stage gates resolved internally by the sub-orchestrator do not appear here. This is a daemon-side routing decision but Phase 6 should document the assumption so builders know what to expect in the gate stream.

### Phase 7 - orchestrator-hub: CONSISTENT

Multi-session hub is unaffected by within-session hierarchy. One daemon owns one session; the Hub aggregates across sessions. HANDOFF section 9.3 and section 11 confirm the single-IPC-backend assumption, which aligns with the worktree model's single-daemon design.

---

## Check 2: CharmState data model (first-class hierarchy vs infer-from-touches)

**Verdict: Phase 1 uses the old infer approach (implicitly); must be revised.**

Phase 1's CharmState has `agents: Vec<AgentRecord>` with no hierarchy fields. Phase 3 builds `worktrees: Vec<WorktreeGroup>` from CharmState - with no hierarchy fields in CharmState, the only derivation path is to scan `agent.touches` for `worktrees/<name>/` segments. That is exactly the `worktreeForTicket()` approach in `charm-parser.ts` that the worktree model (section 6, "Phase 1") explicitly identifies as the old approach to replace.

The design export (HANDOFF section 8) confirms the layout algorithm currently uses this infer-from-touches approach and calls it out as the gap: "the UI is built; the backend that produces a real hierarchy is not."

Required fix is in Phase 1 only: add `parent_id` and `worktree` to `AgentRecord`, add `SubOrchestratorRecord`, add `sub_orchestrators` to `CharmState`. Phase 3 then derives its `WorktreeGroup` list from `state.sub_orchestrators` keyed on `agent.worktree`.

---

## Check 3: Contradictions with design export structural assumptions

| Assumption (HANDOFF) | Phase plan | Status |
|---|---|---|
| Single IPC backend per session (section 11) | One daemon socket per session (Phase 1, 7) | CONSISTENT |
| 4-column shell: activity bar + explorer + center + right sidebar (section 4) | Same layout across Phases 2, 3, 5 | CONSISTENT |
| Three node types: orchestrator (large square), sub-orchestrator (smaller square), agent (circle) (section 7.2) | Phase 3 CanvasState has orchestrator + worktrees + standalone agents, but WorktreeGroup has no explicit sub_orchestrator field | CONTRADICTION - Phase 3 needs explicit SubOrchestratorCard in WorktreeGroup |
| Edges are straight lines (section 7.4) | Phase 3 says "curved/elbow lines" | CONTRADICTION - Phase 3 should match design's straight lines or document deviation |
| Canvas is the hero / default center content (section 7) | Phase plan makes canvas an optional tab (README, Phase 3) | KNOWN DIVERGENCE - explicitly acknowledged in README; not a gap to fix |
| Hierarchy inferred from touches: (section 8) | Same in current Phase 1 CharmState | BOTH STALE - worktree model requires first-class hierarchy in both; fix is in Phase 1 |

---

## Concrete edit list (sorted by phase)

**Phase 1 (3 edits):**
1. Add `pub sub_orchestrators: Vec<SubOrchestratorRecord>` to `CharmState`. Define `SubOrchestratorRecord { id: AgentId, worktree: String, status: AgentStatus, agent_count: usize }`.
2. Add `parent_id: Option<AgentId>` and `worktree: Option<String>` to `AgentRecord`.
3. Add "Idle-gated injection" subsection: when inject target is the orchestrator terminal, check `TerminalView` idle state before calling `terminal.input()`; queue the payload and deliver at the next turn boundary if the operator is mid-input.
4. Note that the daemon's `status` RPC response must be extended to return per-agent `parent_id`/`worktree` and a sub-orchestrators list.

**Phase 3 (3 edits):**
1. Update `WorktreeGroup` to include `sub_orchestrator: SubOrchestratorCard` (renders as a smaller square per HANDOFF 7.2).
2. Add paragraph: hierarchy derivation comes from `CharmState.sub_orchestrators` and `agent.worktree` fields (first-class data from Phase 1 revision), not from scanning `touches:` paths.
3. Change connector description from "curved/elbow lines" to "straight lines" matching HANDOFF section 7.4, or add an explicit note documenting the intentional deviation.

**Phase 4 (2 edits):**
1. Add paragraph on sub-orchestrator terminals: sub-orchestrators are spawned identically to leaf agents but labeled distinctly; their IDs are registered in the bridge's handle map alongside leaf agent IDs.
2. Add cross-reference to Phase 1's idle-gated injection: the `pingOrchestrator` inject path uses idle-gated delivery; all other inject paths (sub-orchestrator, worker) use direct `terminal.input()`.

**Phase 5 (3 edits):**
1. Add section "Worktree dependency-sharing preflight" (see Phase 5 gap detail above).
2. Add step to auto-detect sequence: on worktree creation, run dependency preflight then spawn a sub-orchestrator in that worktree.
3. Update `register_panes` description to include sub-orchestrator terminal handles.

**Phase 6 (1 edit):**
1. Add note on gate routing: CharmState.pending_gates contains only operator-level gates (merge-to-main and escalated plan gates). Plan-stage gates resolved internally by sub-orchestrators do not appear in this stream.
