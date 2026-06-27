# Phase 3 — Orchestration view (optional center tab)

**Status:** draft
**Depends on:** Phase 1 (CharmState entity)
**Source:** T-025 (canvas design, no-SVG verdict), T-027 (PathBuilder, animation), T-028 (canvas strategy), `Orchestration Canvas.dc.html`

The orchestration view is an **optional tab in the center pane**, opened on
demand. It is one `Item` among your normal editor tabs — open it to see the
fleet, close it to go back to plain editing. It does not take over the window.
This is the single largest build item because GPUI has no SVG and no
`animateMotion`, so it is rendered entirely with GPUI elements + an imperative
animation loop.

---

## Where this phase sits in the architecture

The full charm-on-Zed architecture, with **Phase 3** highlighted in blue and its direct dependencies (one step away) in light blue. Everything gray is elsewhere in the system, untouched by this phase. Same diagram as the [architecture overview](architecture-diagram.svg), recolored to this phase.

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

  LEGEND["LEGEND · Phase 3 focus<br/>BLUE = built or changed in Phase 3<br/>LIGHT BLUE = directly connected (one step away)<br/>GRAY = elsewhere in the system, untouched by this phase<br/>==> primary data flow    -.-> secondary / control flow"]:::legend

  class orchtab focus;
  class state near;
  class s1,s2,s3,s4,s5,s6,s7,charmd,spawn,mcp,bridge,injsock,handlemap,files,editor,termviews,charmview,orchestrate,general,agpane,liveness,cli,autodetect,banner,modal,hubview,sessrpc dim;
```

---

## It is a tab, not a takeover

Implement `Item` so the view opens as a center-pane tab labeled
"Orchestration". Open it via a command (`charm: Show Orchestration`) or the
Charm activity-bar button. Multiple normal editor tabs coexist with it; closing
it returns to whatever file you were editing. `Item` types are `Entity<T>`
where `T: Render`; only `tab_content_text()` is strictly required.

```rust
pub struct OrchestrationItem {
    state: Entity<CanvasState>,
    animation_frame: Option<Task<()>>,
}
```

---

## The design: card-flow, not a star graph

The current design (`Orchestration Canvas.dc.html`) is **not** the old
concentric-ring SVG node graph. It is a scrollable, zoomable **card layout**:

- **Orchestrator card** — a dark filled card with gold accent text, a label
  ("main"), and a stats row: ACTIVE / TREES / TICKETS.
- **Standalone agent cards** — each with a left accent stripe, status dot, a
  STAGE chip, the ticket id + title, an optional blocker note (`⚠ {note}`), and
  a progress bar + elapsed time.
- **Worktree groups** — dashed-border panels grouping a branch's agent cards,
  labeled with the branch name and a count.
- **Connectors** — straight lines drawn behind the cards from the
  orchestrator to each branch, carrying animated flow dots (HANDOFF section 7.4
  mandates straight edges; do not use curved or elbow routing).
- A zoom control and light/dark theme toggle.

This card-flow layout is **far more GPUI-friendly** than the old star graph:
the cards are plain GPUI divs with flexbox. Only the connector lines and their
traveling dots need custom drawing. This is the design to build.

---

## Rendering (all GPUI primitives, no SVG)

| Design element | GPUI implementation |
|---|---|
| Orchestrator / agent / worktree cards | `div()` with flexbox, borders, accent stripe child |
| Stats row, stage chips, progress bar | nested `div()`s; progress bar is a width-animated fill |
| Status dot | small rounded `div()` |
| Blocker note (`⚠ …`) | conditional `div()` child |
| Connector lines | `cx.paint_path(path_builder)` with `PathBuilder` straight segments (no bezier curves) |
| Traveling flow dots | small quad positioned along the connector at `dot_t` |
| Dashed worktree border | GPUI dashed border style on the group `div()` |

The bulk of the view is plain styled divs — the hard part is just the
connectors and dots. Glow effects (the design's soft halos) have no direct GPUI
equivalent; approximate with layered translucent fills or defer for v1.

---

## CanvasState

```rust
pub struct CanvasState {
    pub orchestrator: OrchestratorCard,
    pub standalone: Vec<AgentCard>,
    pub worktrees: Vec<WorktreeGroup>,
    pub connectors: Vec<Connector>,   // path precomputed; only dot_t advances
    pub zoom: f32,
}

// One group per git worktree. The sub_orchestrator field carries the
// per-worktree sub-orchestrator (rendered as a smaller square per HANDOFF 7.2)
// alongside the agent circles it manages.
pub struct WorktreeGroup {
    pub sub_orchestrator: SubOrchestratorCard,  // renders as a smaller square
    pub agents: Vec<AgentCard>,                 // render as circles
    pub box_bounds: Rect<Pixels>,
}

// SubOrchestratorCard mirrors the fields the canvas needs to render the
// smaller square: its agent id, the worktree name it manages, its current
// status, and how many leaf agents it is running.
pub struct SubOrchestratorCard {
    pub id: AgentId,
    pub worktree: String,
    pub status: AgentStatus,
    pub agent_count: usize,
}

pub struct Connector {
    pub path: Path,        // straight line, recomputed only on topology change
    pub dot_t: f32,        // 0.0..1.0 traveling-dot progress
    pub state: EdgeState,  // active | idle | blocked
}
```

Built from `CharmState` (Phase 1 revised model). The hierarchy derivation uses
**first-class fields only** -- never `touches:` path scanning:

- `CanvasState.worktrees` is built by iterating `CharmState.sub_orchestrators`
  (the `Vec<SubOrchestratorRecord>` added in the Phase 1 revision). One
  `WorktreeGroup` per `SubOrchestratorRecord`.
- Each group's `agents` list is built by filtering `CharmState.agents` on
  `agent.worktree == sub_orchestrator.worktree`.
- `CanvasState.standalone` collects agents where `agent.worktree` is `None`
  (leaf agents that are not assigned to any worktree).
- The `WorktreeGroup.sub_orchestrator` card is populated directly from the
  `SubOrchestratorRecord` fields (`id`, `worktree`, `status`, `agent_count`).

This derivation path is only valid after the Phase 1 revision lands (the
`sub_orchestrators` list and `agent.worktree`/`agent.parent_id` fields must
exist on `CharmState`). Do NOT fall back to inferring the tree from `touches:`
paths -- that is the old approach this model replaces.

Card positions come from a layout function: orchestrator card on the left,
branch cards/worktree groups stacked on the right (the card-flow "activity
feed" orientation), or a ring layout if that is preferred later. Layout is a
pure function on the node list -- unit-testable, no GPUI dependency.

---

## Animation loop (replaces `<animateMotion>`)

```rust
fn start_animation(&mut self, cx: &mut Context<Self>) {
    self.animation_frame = Some(cx.spawn(async move |this, cx| {
        loop {
            cx.background_executor().timer(Duration::from_millis(16)).await;
            this.update(cx, |item, cx| {
                item.state.update(cx, |s, cx| {
                    s.advance_dots(0.016);   // step each connector's dot_t, wrap at 1.0
                    cx.notify();
                });
            }).ok();
        }
    }));
}
```

Pause the loop when the tab is not visible (no point animating a backgrounded
tab) — check the `Item`'s active/focus state and stop the task when hidden.

---

## Click handling

Each card registers a mouse handler:

```rust
div().on_mouse_down(MouseButton::Left, cx.listener(|this, _ev, _w, cx| {
    // open the matching ticket as a markdown tab, or focus the agent terminal
}))
```

Clicking an agent card can open its ticket detail or jump to its terminal tab
([Phase 4](phase-4-terminal-tabs.md)).

---

## Risk: benchmark first

Open question #3 in the README. Before building the full view, prototype: ~15
mock agent cards + worktree groups + animated connectors at 60fps. Expected
well within budget (cards are cheap divs; only the dots animate), but verify.
This is the highest-uncertainty item in the plan.

---

## Status: draft
