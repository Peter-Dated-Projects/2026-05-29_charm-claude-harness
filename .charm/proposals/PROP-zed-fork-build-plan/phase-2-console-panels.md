# Phase 2 — Right sidebar + Charm explorer view

**Status:** draft
**Depends on:** Phase 1 (CharmState entity)
**Source:** T-024 (console tabs inventory), T-027 (Panel trait), T-028 (panel strategy), `Orchestration Canvas.dc.html` (panel placement)

The charm read-out lives in two places, matching the design: a **Charm view**
in the left explorer area, and a **right sidebar** with Orchestrate/General
tabs. This is additive — Zed's native file explorer and editor are untouched.

---

## Where this phase sits in the architecture

The full charm-on-Zed architecture, with **Phase 2** highlighted in blue and its direct dependencies (one step away) in light blue. Everything gray is elsewhere in the system, untouched by this phase. Same diagram as the [architecture overview](architecture-diagram.svg), recolored to this phase.

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

  LEGEND["LEGEND · Phase 2 focus<br/>BLUE = built or changed in Phase 2<br/>LIGHT BLUE = directly connected (one step away)<br/>GRAY = elsewhere in the system, untouched by this phase<br/>==> primary data flow    -.-> secondary / control flow"]:::legend

  class charmview,orchestrate,general focus;
  class state,charmd near;
  class s1,s2,s3,s4,s5,s6,s7,spawn,mcp,bridge,injsock,handlemap,files,editor,termviews,orchtab,agpane,liveness,cli,autodetect,banner,modal,hubview,sessrpc dim;
```

---

## Panel placement (from the design)

The `Orchestration Canvas.dc.html` design is a VS Code-style shell:

- **Left** — activity bar + explorer with **Files / Charm** tabs. Files is
  Zed's native `ProjectPanel`. Charm is a new view of the `.charm/` workspace.
- **Center** — editor tabs + the optional orchestration tab ([Phase 3](phase-3-orchestration-canvas.md)).
- **Right** — sidebar with **Orchestrate / General** tabs.

So Phase 2 builds: the Charm explorer view (left) and the right sidebar (right).
There is no wholesale "replace the console with 4 left-dock panels" — the
earlier framing is superseded by the design's actual layout.

---

## The Panel trait

A dock panel implements:

```rust
pub trait Panel: Focusable + EventEmitter<PanelEvent> + Render + Sized { ... }
```

Required methods (no defaults): `persistent_name()`, `panel_key()`,
`position()`, `position_is_valid()`, `set_position()`, `size()`, `set_size()`,
`icon()`, `icon_tooltip()`, `toggle_action()`. Reference: `crates/project_panel`
and `TerminalPanel` in `crates/terminal_view`.

---

## Left: Charm explorer view (`charm_explorer.rs`)

A second view in the left dock alongside the native file tree, toggled by the
explorer's Files/Charm tab strip.

- Renders the `.charm/` workspace: `tickets/` (each ticket `.md`), `kb/`,
  `COORDINATION.md`, `meta.json`, `worktrees/`
- Ticket and coordination rows carry a real path; clicking a `.md` opens it in
  the center as a rendered markdown tab via Zed's `MarkdownElement`
- Status badges per row (modified / untracked / ticket-dot), same idiom as the
  design's tree
- Files tab itself is Zed's native `ProjectPanel` — zero new code

---

## Right: sidebar (`charm_sidebar.rs`)

A right-dock `Panel` with two tabs.

**Orchestrate tab** (the live coordination read-out):
- Stat row: ACTIVE / WORKTREES / TICKETS counts (big number over a caps label),
  matching the design export section 10.1. These three stats stay fixed; do not
  add or rename them.
- Ticket list grouped into LIVE (open/in_progress/blocked) and COMPLETE
  sections; each row: id, status word, title, stage chip
- Reads `state.tickets` + `state.agents` from the bridge. Both the sidebar and
  the left-dock Charm explorer read from the HIERARCHICAL `CharmState`
  (orchestrator -> sub-orchestrator -> agent) produced by the revised Phase 1
  bridge. The sidebar groups agents under their sub-orchestrator when `agent.worktree`
  is set; top-level agents (no worktree) render directly under the orchestrator
  row.

**General tab:**
- SUMMARY, MODEL & CONTEXT, REPOSITORY sections (static/derived metadata). The
  SUMMARY can show the session label that `set_session_description` already
  writes to `meta.json` — the Phase 1 `status` poll can return it, so this
  works now without waiting for Phase 7's `sessions_manifest` RPC.
- CONVERSATION area — for now a read-only message list; wiring a live composer
  to charmd is open work (charmd has no conversation-stream RPC yet)

---

## Agents + approvals: where they go

The old plan had standalone Agents and Approvals panels. In the design's layout
these fold in more naturally:

- **Agent fleet status** is the Orchestrate tab's stat row + the live ticket
  list (each live ticket maps to an agent). Dismiss/kill actions attach to the
  agent rows there. Double-confirm kill via `pending_kill: Option<AgentId>` +
  timer reset (mirrors the Ink `x·x` mechanic).
- **Approvals** surface primarily as the modal in [Phase 6](phase-6-approval-gates.md),
  plus an inline banner in the Orchestrate tab when a gate is pending. No
  dedicated panel needed.

---

## Shared polling pattern

Both views read the bridge's single `CharmState` entity. Phase 1's polling loop
updates it and calls `cx.notify()`, re-rendering every observer. No per-panel
polling; the chokidar file-watches from the Ink console collapse into this one
update path.

---

## Status: draft
