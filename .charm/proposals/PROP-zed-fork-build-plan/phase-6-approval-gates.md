# Phase 6 — Approval gate UX

**Status:** draft
**Depends on:** Phase 2 (Orchestrate tab hosting the inline gate banner), Phase 1 (gate state)
**Source:** T-028 (approval gate UX), T-024 (await_approval mechanics)

The approval gates (Stage 2: approve worker plan; Stage 4: approve diff before
merge) are blocking and must not be missed. Use two layers, mirroring the Ink
console's auto-tab-switch behavior.

---

## Where this phase sits in the architecture

The full charm-on-Zed architecture, with **Phase 6** highlighted in blue and its direct dependencies (one step away) in light blue. Everything gray is elsewhere in the system, untouched by this phase. Same diagram as the [architecture overview](architecture-diagram.svg), recolored to this phase.

```mermaid
flowchart TB
  classDef dim fill:#2a2f36,color:#7f8893,stroke:#3a4049,stroke-width:1px;
  classDef near fill:#9cc4ee,color:#0b2a4a,stroke:#5e93cf,stroke-width:1.5px;
  classDef focus fill:#1d6fe0,color:#ffffff,stroke:#cfe4ff,stroke-width:3px;
  classDef legend fill:#1e293b,color:#cbd5e1,stroke:#475569,stroke-width:1px;

  subgraph STRIP["PHASE 0 STRIP · zed upstream crates · being removed from fork"]
    direction LR
    s1["login · sign-in<br/>oauth_callback_server · crates/client (auth paths)"]
    s2["collab · org · channel · call<br/>crates/collab_ui · LiveKit voice/video"]
    s3["edit-prediction · Zeta<br/>crates/edit_prediction · zeta_prompt · 7 crates"]
    s4["AI assistant · LLM<br/>agent · anthropic · language_model · 14 crates"]
    s5["remote dev<br/>crates/remote · remote_connection"]
    s6["telemetry<br/>crates/telemetry · telemetry_events"]
    s7["auto-update<br/>auto_update · auto_update_helper · auto_update_ui"]
  end

  subgraph DAEMON["DAEMON BACKEND · src/daemon/index.ts · hierarchy routing added · STAYS"]
    direction TB
    charmd["charmd<br/>RPC · ticket store · solver · approvals"]
    spawn["spawn.ts<br/>agent command builder"]
    mcp["charm-mcp shim<br/>one per claude agent"]
  end

  subgraph BRIDGE["THE BRIDGE · Phase 1 · single seam · daemon to Zed"]
    direction TB
    bridge{{"CharmBridge<br/>socket client · 1500ms poll"}}
    state["CharmState<br/>tickets · agents (parent_id · worktree)<br/>sub_orchestrators · gates · coord"]
    injsock["inject_text listener<br/>receives ping · continue · set_mode"]
    handlemap["agent_id -> Entity&lt;Terminal&gt; map"]
  end

  subgraph NATIVE["ZED NATIVE · kept as-is · zero new code"]
    direction LR
    files["ProjectPanel<br/>file explorer"]
    editor["Editor + tabs<br/>normal editing"]
    termviews["TerminalView<br/>one per agent"]
  end

  subgraph LEFT["LEFT DOCK · Phase 2 · charm explorer view"]
    charmview["Charm view<br/>.charm/ tree · tickets · kb"]
  end

  subgraph RIGHT["RIGHT SIDEBAR · Phase 2 · console panels"]
    direction TB
    orchestrate["Orchestrate tab<br/>stats · LIVE/COMPLETE tickets"]
    general["General tab<br/>summary · model · conversation"]
  end

  subgraph CENTER["CENTER PANE · Phase 3 · optional tab · one Item among editor tabs"]
    orchtab["Orchestration tab<br/>cards · worktrees · connectors"]
  end

  subgraph TERMS["AGENT TERMINALS · Phase 4 · spawn + liveness"]
    direction TB
    agpane["Agents pane (split)"]
    liveness["exit-event liveness<br/>replaces 15s sweep"]
  end

  subgraph BOOT["SESSION BOOTSTRAP · Phase 5 · clean operator UX"]
    direction LR
    cli{{"charm CLI<br/>start · --tmux legacy"}}
    autodetect[".charm/ auto-detect<br/>start daemon · register_panes"]
  end

  subgraph APPROVE["APPROVAL GATES · Phase 6 · stage-2 + stage-4"]
    direction LR
    banner["gate banner<br/>inline in Orchestrate tab"]
    modal["gate modal<br/>on arrival"]
  end

  subgraph HUB["MULTI-SESSION HUB · Phase 7 · second GPUI window"]
    direction TB
    hubview["hub window<br/>second GPUI window"]
    sessrpc["sessions_manifest RPC<br/>new daemon addition"]
  end

  charmd ==>|"status poll"| bridge
  bridge ==> state
  state ==> charmview
  state ==> orchtab
  state ==> orchestrate
  state ==> banner
  orchestrate -.->|"dismiss · kill"| charmd
  banner -.->|"approve_gate"| charmd
  modal -.->|"approve_gate"| charmd
  charmd ==>|"spawnAgentLocked"| bridge
  spawn -.->|"command string"| agpane
  bridge ==>|"spawn_task"| agpane
  agpane --- termviews
  charmd -.->|"ping · continue · set_mode"| injsock
  injsock -.-> handlemap
  handlemap -.->|"terminal.input()"| termviews
  termviews -.->|"exit-event"| liveness
  liveness -.->|"tearDownAgent"| charmd
  cli ==> autodetect
  autodetect ==> bridge
  hubview -.-> sessrpc
  sessrpc -.->|"reads run/*/meta.json"| charmd

  LEGEND["LEGEND · Phase 6 focus<br/>BLUE = built or changed in Phase 6<br/>LIGHT BLUE = directly connected (one step away)<br/>GRAY = elsewhere in the system, untouched by this phase<br/>==> primary data flow    -.-> secondary / control flow"]:::legend

  class banner,modal focus;
  class state,charmd near;
  class s1,s2,s3,s4,s5,s6,s7,spawn,mcp,bridge,injsock,handlemap,files,editor,termviews,charmview,orchestrate,general,orchtab,agpane,liveness,cli,autodetect,hubview,sessrpc dim;
```

---

## How gates work today (unchanged)

The orchestrator calls `await_approval(stage, label)` which blocks in the MCP
shim until a human resolves the gate. The daemon's `ApprovalQueue` stores the
promise and resolves it when `approve_gate` arrives from *any* client. This is
daemon-side state and survives the UI being closed/reopened — the fork does not
change any of this.

The fork only changes how the gate is *surfaced* and how the
approve/reject click reaches `approve_gate`.

---

## Layer 1 — ambient (Orchestrate tab banner)

The ambient layer lives in the **right sidebar's Orchestrate tab**
([Phase 2](phase-2-console-panels.md)), not a separate left-dock panel. When a
gate is pending, an inline banner appears at the top of the Orchestrate tab with
the gate label, stage, and Approve / Reject buttons. An operator with the
sidebar open never misses a gate. This is the baseline.

(Earlier drafts and T-028 section 2 described a standalone left-dock
`ApprovalsPanel`; that is superseded by the design's right-sidebar layout. There
is no separate approvals panel.)

---

## Layer 2 — modal on arrival

When a new gate enters `CharmState.pending_gates`, the bridge dispatches a GPUI
modal so the operator cannot miss a blocking gate even with the panel
collapsed:

```rust
cx.open_modal(window, |modal, _, _| {
    modal.child(
        v_flex()
            .child(Label::new(format!("Stage {} gate", gate.stage)))
            .child(Label::new(gate.label.clone()))
            .child(h_flex()
                .child(Button::new("approve", "Approve")
                    .on_click(cx.listener(move |_, _, _, cx| {
                        approve_gate(socket, gate_id, true, cx);
                    })))
                .child(Button::new("reject", "Reject")
                    .on_click(cx.listener(move |_, _, _, cx| {
                        approve_gate(socket, gate_id, false, cx);
                    }))))
});
```

Both buttons fire the `approve_gate` RPC; the daemon resolves the parked promise
and the orchestrator unblocks.

---

## Surfacing nudges

The Ink console auto-switched to the Approvals tab when `pendingCount > 0`. The
fork's equivalents:

- The modal (above) is the primary nudge
- A badge/status dot on the Orchestrate tab in the right sidebar (the design
  already shows a status dot on the Orchestrate tab when an agent is active)
- Optionally open/focus the right sidebar to the Orchestrate tab when a gate
  arrives

---

## Edge case: daemon restart

If the daemon crashes mid-gate, the in-memory `ApprovalQueue` is lost and any
blocking `await_approval` gets a closed socket. This is a **pre-existing**
limitation, not introduced by the fork — noted here so it is not mistaken for a
regression. Durable gate persistence is out of scope for this proposal.

---

## Gate routing (orchestration-model Decision 1)

Not all gates reach the operator. The daemon routes them by stage:

- **Stage-2 PLAN gate** — owned by the sub-orchestrator *inside its worktree*.
  The sub-orchestrator calls `await_approval(stage=2, ...)`, the daemon routes
  the approval back to that sub-orchestrator, and the sub-orchestrator resolves
  it without the operator's involvement. These gates are NOT pushed to
  `CharmState.pending_gates` and do not appear in the banner or modal.

- **Stage-4 MERGE-TO-MAIN gate** — owned by the top-level orchestrator, because
  merging into the shared tree is the orchestrator's responsibility. This gate
  IS pushed to `pending_gates` and surfaces in the banner/modal to the operator.

- **Escalations** — if a sub-orchestrator encounters a gate it cannot resolve
  (e.g. a conflict requiring operator judgment), it escalates to the orchestrator.
  Escalated gates also appear in `pending_gates` and reach the operator.

What this means for Phase 6 builders: the gate stream arriving in
`CharmState.pending_gates` contains only operator-level decisions (Stage-4 merges
and escalations). The UI does not need to distinguish between these subtypes for
basic rendering -- every entry in `pending_gates` is something the operator must
act on. Stage-2 plan approvals are transparent to this phase; they are handled
entirely by the daemon and the relevant sub-orchestrator.

---

## Status: draft
