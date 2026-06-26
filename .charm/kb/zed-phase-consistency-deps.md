# Zed-fork build plan: dependency graph and consistency audit

**Source:** T-032 investigation of `.charm/proposals/PROP-zed-fork-build-plan/`
**Phases audited:** 0 through 7 (README.md + 8 phase files + architecture-diagram.mmd)

---

## Validated dependency graph

Each row lists a phase's declared direct dependencies. The graph is a DAG; no cycles exist.

```
P0  depends on: (nothing)
P1  depends on: P0
P2  depends on: P1
P3  depends on: P1
P4  depends on: P1
P5  depends on: P1, P2, P3, P4
P6  depends on: P1, P2
P7  depends on: P1
```

Topological order (one valid linearization):
  P0 -> P1 -> P2/P3/P4 (parallelizable) -> P6 (can start after P2) -> P5 (after P2, P3, P4) -> P7

P6 and P7 can be started earlier than the README implies (see Issue 4 below).

---

## Check 1: DAG validation (cycles, forward references)

RESULT: PASS

No cycles. All edges point from higher-numbered (later) phases to lower-numbered (earlier) ones. No phase references a capability that does not exist at that point in the build sequence.

---

## Check 2: Capability-before-use

RESULT: PASS

Each phase's runtime requirements are met by earlier phases:

- P1 uses `gpui`, `workspace`, `terminal`, `terminal_view`, `project`, `markdown`, `ui` -- none stripped in P0, all kept.
- P2 uses Panel trait (`crates/workspace`) and `MarkdownElement` -- kept.
- P3 uses GPUI primitives and PathBuilder -- GPUI is the core framework, not stripped.
- P4 uses `terminal`, `terminal_view` -- explicitly kept in P0 (operator list row 6).
- P5 launches the daemon and connects the bridge (P1), opens the sidebar (P2), splits the agents pane (P4). All built before P5.
- P6 reads `CharmState.pending_gates` from P1's bridge and renders inside P2's Orchestrate tab. Both exist before P6.
- P7 adds a second GPUI window and a new daemon RPC. No earlier-phase capability required beyond P1's bridge.

---

## Check 3: Strip-vs-need (Phase 0 removal list vs later phase requirements)

RESULT: PASS (with one pre-existing gotcha already noted in the plan)

Phase 0 strips: login/auth, collab/org/channel/call, edit-prediction/Zeta (7 crates), AI/LLM assistant (14 crates including `agent_settings`), remote dev, telemetry, auto-update.

Phase 0 explicitly keeps: terminal, terminal_view, dap/debugger suite, workspace (panel layout system).

Phases 1-7 use only kept crates. No later phase requests a crate from the strip list.

**Pre-existing gotcha (already noted in P0, not a new finding):**
`agent_settings` is flagged in P0 as "also referenced by editor/inline-assist paths -- audit before deleting." P0's guidance is to gut rather than delete outright. No later phase needs `agent_settings`, so no contradiction, but the strip worker must do the audit P0 calls for or a build breakage will occur from crates kept by P0 transitively depending on a stripped crate.

---

## Check 4: Blocks/Depends-on mutual consistency

RESULT: 3 ISSUES FOUND

### Issue 1 -- Phase 1 Blocks under-declares (significant)

Phase 1 header: `Blocks: Phases 2, 3, 4`

Phases 5, 6, and 7 all include Phase 1 in their `Depends on`:
- P5: `Depends on: Phases 1-4`
- P6: `Depends on: Phase 2, Phase 1`
- P7: `Depends on: Phase 1`

Phase 1's Blocks list is missing Phases 5, 6, and 7.

**Fix:** Change Phase 1 header to `Blocks: Phases 2, 3, 4, 5, 6, 7`

---

### Issue 2 -- Phase 6 Depends-on has stale capability reference (significant)

Phase 6 header: `Depends on: Phase 2 (ApprovalsPanel), Phase 1 (gate state)`

Phase 2 does not build an ApprovalsPanel. From Phase 2's own content: "Earlier drafts and T-028 section 2 described a standalone left-dock ApprovalsPanel; that is superseded by the design's right-sidebar layout. There is no separate approvals panel."

Phase 6's actual dependency on Phase 2 is for the right sidebar's Orchestrate tab, which hosts Phase 6's inline gate banner. The dependency direction is correct; the stated reason is wrong and refers to a scrapped design.

**Fix:** Change Phase 6 header to:
  `Depends on: Phase 2 (Orchestrate tab in right sidebar -- hosts the inline gate banner), Phase 1 (gate state)`

---

### Issue 3 -- Phase 0 "Blocks: every other phase" vs phases 2-7 direct headers (documentation)

Phase 0 header: `Blocks: every other phase`

Phases 2-7 do not list Phase 0 in their `Depends on`. Their dependency on P0 is real but transitive (they all depend on P1, which depends on P0). Phase 0's claim is technically true but misleadingly broad: P0 is only a direct blocker of P1. All others are blocked indirectly.

**Fix (two options):**
- (a) Change Phase 0 header to `Blocks: Phase 1` and add a note "(transitively blocks all subsequent phases through Phase 1)".
- (b) Keep "every other phase" for intent, but add a line noting it is the transitive effect, not a direct blocking relationship.

Either fix eliminates the false symmetry expectation.

---

## Additional findings (not contradictions; documentation gaps)

### Finding 4 -- README parallelism claim understates Phases 6 and 7

README states: "Phases 0 and 1 are blockers. Phases 2-4 can be worked in parallel once Phase 1 is complete. Phases 5-7 are polish."

Actual dependency graph shows:
- P6 only requires P1 and P2. It can start as soon as Phase 2 is complete, in parallel with Phases 3 and 4. It does not need to wait for Phase 5.
- P7 only requires P1 (plus a new daemon RPC it adds itself). It can start in parallel with Phases 2, 3, and 4.

Calling 5-7 "polish" is editorial (lower priority), not a strict ordering. A team doing parallel work may unnecessarily serialize Phases 6 and 7 behind the full 2-4 cluster because the README groups them.

**Fix:** Add a note to the README table, e.g.: "Phase 6 can begin after Phase 2 is complete (does not require Phase 3 or 4). Phase 7 can begin after Phase 1 (independent of 2-4)."

---

### Finding 5 -- Phase 5 over-declares Phase 3 in its Depends-on (minor)

Phase 5 header: `Depends on: Phases 1-4 (the things the bootstrap arranges)`

Phase 5's auto-detect logic actively needs Phase 1 (bridge), Phase 2 (sidebar open), and Phase 4 (agents pane split). Phase 3 (the optional orchestration tab) is opened on demand by the operator after the IDE is running. Phase 5 says only "the operator opens the OrchestrationItem tab on demand" -- it does not need Phase 3 to be built in order to complete.

This is an over-declaration that creates a false serial constraint: a worker completing Phase 5 need not wait for Phase 3 to finish.

**Fix:** Change Phase 5 header to `Depends on: Phases 1, 2, 4`. Add a note: "Phase 3 (orchestration tab) is independently openable on demand; Phase 5 does not block on it."

---

## Summary table

| # | Check | Result | Severity |
|---|---|---|---|
| 1 | DAG -- no cycles | PASS | -- |
| 2 | No forward references | PASS | -- |
| 3 | Strip-vs-need | PASS | pre-existing gotcha noted |
| 4.1 | Phase 1 Blocks under-declares (missing P5, P6, P7) | FAIL | significant |
| 4.2 | Phase 6 stale ApprovalsPanel reference | FAIL | significant |
| 4.3 | Phase 0 "every other phase" vs transitive-only reach | FAIL | documentation |
| 4.4 | README groups P6, P7 as "polish" obscuring parallel opportunity | gap | minor |
| 4.5 | Phase 5 over-declares P3 as a hard dependency | gap | minor |
