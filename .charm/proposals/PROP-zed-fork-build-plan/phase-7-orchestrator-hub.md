# Phase 7 — Orchestrator Hub (multi-session)

**Status:** draft
**Depends on:** Phase 1 (bridge); needs a new daemon RPC
**Source:** T-025 (Hub gap analysis), T-028 (Hub mapping)

The Hub lets the operator see and switch between multiple charm sessions. Today
each `charm start` is one tmux session = one daemon = one UUID, with no
cross-session view. The Tauri design surfaced this as a separate
`WebviewWindow`; in the fork it is a second GPUI window.

---

## Where this phase sits in the architecture

The full charm-on-Zed architecture, with **Phase 7** highlighted in blue and its direct dependencies (one step away) in light blue. Everything gray is elsewhere in the system, untouched by this phase. Same diagram as the [architecture overview](architecture-diagram.svg), recolored to this phase.

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

  LEGEND["LEGEND · Phase 7 focus<br/>BLUE = built or changed in Phase 7<br/>LIGHT BLUE = directly connected (one step away)<br/>GRAY = elsewhere in the system, untouched by this phase<br/>==> primary data flow    -.-> secondary / control flow"]:::legend

  class hubview,sessrpc focus;
  class charmd near;
  class s1,s2,s3,s4,s5,s6,s7,spawn,mcp,bridge,state,injsock,handlemap,files,editor,termviews,charmview,orchestrate,general,orchtab,agpane,liveness,cli,autodetect,banner,modal dim;
```

---

## GPUI multi-window

GPUI natively supports multiple top-level windows (Zed uses this for its own
panels). Open the Hub as a second window:

```rust
cx.open_window(WindowOptions { /* small, always-on-top picker */ }, |window, cx| {
    cx.new(|cx| HubView::new(sessions, cx))
});
```

The Hub lists running sessions; clicking one focuses/opens that session's
workspace.

---

## Prerequisite: sessions_manifest RPC (new daemon code)

This is the blocking gap. The daemon currently has no way to enumerate sessions
— each daemon only knows about itself. The Hub needs a manifest.

Add a `sessions_manifest` RPC that scans `.charm/run/*/meta.json` and returns:

```
[
  { uuid, label, status, agent_count, socket_path },
  ...
]
```

This is a **pure addition** — no interface-breaking changes to existing RPC
methods. It reads the `meta.json` files the daemon already writes (including
the label set by `set_session_description`, which currently writes to a dead
end because nothing reads it).

Two implementation options:
- **(a)** Any running daemon answers `sessions_manifest` by scanning the
  sibling `run/*` directories.
- **(b)** A separate lightweight session-registry process owns the manifest.

Option (a) is simpler and sufficient — any daemon can scan the filesystem.

---

## Data flow closure

This phase closes a loop noted in T-025: `set_session_description` writes a
session label to `meta.json`, but with no Hub and no manifest RPC, nothing ever
reads it. Once `sessions_manifest` exists and the Hub renders it, that metadata
finally has a consumer.

---

## Relationship to the within-session hierarchy

The worktree-orchestration model (orchestrator -> sub-orchestrators -> workers)
is a within-session concern. Phase 7 is cross-session and is unaffected by it.

The `sessions_manifest` RPC fits the single-daemon-per-session model exactly:
each daemon knows about itself and can scan sibling `run/*/meta.json` entries
written by other daemons. There is one daemon per session; the Hub aggregates
across those sessions. No change is needed to this RPC's design to accommodate
the within-session hierarchy.

---

## Why this is last

The Hub is multi-session polish. The single-session IDE (Phases 0-6) is fully
useful without it. It also carries the only required new daemon RPC in the whole
plan, so it is cleanly separable and can wait until the core experience is
solid.

---

## Status: draft
