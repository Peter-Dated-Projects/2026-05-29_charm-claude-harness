# Phase 4 — Per-agent terminal tabs

**Status:** draft
**Depends on:** Phase 1 (bridge + terminal handle map)
**Source:** T-027 (terminal spawning), T-028 (terminal mapping)

Each claude agent gets its own `TerminalView` in the Zed fork, replacing the
tmux pane. The daemon spawns, kills, and injects text into these terminals
through the bridge.

---

## Where this phase sits in the architecture

The full charm-on-Zed architecture, with **Phase 4** highlighted in blue and its direct dependencies (one step away) in light blue. Everything gray is elsewhere in the system, untouched by this phase. Same diagram as the [architecture overview](architecture-diagram.svg), recolored to this phase.

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

  LEGEND["LEGEND · Phase 4 focus<br/>BLUE = built or changed in Phase 4<br/>LIGHT BLUE = directly connected (one step away)<br/>GRAY = elsewhere in the system, untouched by this phase<br/>==> primary data flow    -.-> secondary / control flow"]:::legend

  class agpane,liveness focus;
  class spawn,bridge,termviews,charmd near;
  class s1,s2,s3,s4,s5,s6,s7,mcp,state,injsock,handlemap,files,editor,charmview,orchestrate,general,orchtab,cli,autodetect,banner,modal,hubview,sessrpc dim;
```

---

## Sub-orchestrator terminal tabs

Sub-orchestrators are agents too: each per-worktree sub-orchestrator gets its
own terminal tab spawned through the same bridge path as a leaf worker. The
difference is labeling and grouping:

- **Label:** `sub-orch: <worktree-name>` (e.g. `sub-orch: zed-fork`) rather
  than a ticket-id prefix. This makes sub-orchestrator panes visually
  distinguishable from the leaf agent tabs that orbit them.
- **Handle map:** the bridge's `agent_id -> Entity<Terminal>` map must include
  sub-orchestrator IDs alongside leaf agent IDs. There is no separate registry;
  sub-orchestrators are first-class entries in the same map. Phase 3's canvas
  depends on this: clicking a sub-orchestrator card can focus its terminal tab.
- **Spawn path:** identical to leaf agents -- `spawnAgentLocked` is relayed to
  the bridge, which calls `spawn_task` with the sub-orchestrator's command and
  env block. The `CHARM_AGENT_ID` env var is the sub-orchestrator's ID.
- **Teardown path:** also identical -- `tearDownAgent` closes the terminal item
  and calls `bridge.unregister_terminal(agent_id)`.

Sub-orchestrators are spawned before any leaf workers in their worktree, and
reaped after the last leaf worker in their worktree is reaped. Their terminals
should appear at the top of the agents pane for their worktree (or in a
dedicated sub-section if the agents pane gains grouping in a later phase).

---

## Spawning an agent terminal

When the daemon fires `spawnAgentLocked` (relayed to the bridge), open a new
terminal in the agents pane. **[VERIFIED against pinned Zed 1.95.0 source]** The
plan's earlier candidates (`terminal_panel.spawn_task(&SpawnInTerminal)` and
`project.create_terminal(TerminalKind::Shell(..))`) do NOT exist at this version.
The confirmed entry point is:

- **`Project::create_terminal_task(spawn_task: SpawnInTerminal, cx) -> Task<Result<Entity<Terminal>>>`**
  (crates/project/src/terminals.rs) — carries a full command spec (command,
  args, env, cwd, shell) and returns the `Entity<Terminal>` directly. This
  resolves the old sub-question: the returned handle IS suitable for
  `terminal.paste()`/`input()` injection and is exactly what the bridge
  registers in its `agent_id -> Entity<Terminal>` map.
- (`Project::create_terminal_shell(cwd, cx)` is the default-shell-only variant —
  not used by charm, which always spawns the `claude` command.)

`SpawnInTerminal` lives in crates/task/src/task.rs and derives `Default`;
`command` is `Option<String>`, `args: Vec<String>`, `env: HashMap<String,String>`,
`cwd: Option<PathBuf>`, with label/strategy fields covered by
`..Default::default()`.

Sketch:

```rust
let spec = SpawnInTerminal {
    command: Some("claude".into()),
    args: claude_args,          // --session-id ... --mcp-config ... --append-system-prompt ...
    env: charm_env,             // CHARM_AGENT_ID, CHARM_SOCKET, ...
    cwd: Some(PathBuf::from(cwd)),
    ..Default::default()
};
let terminal: Entity<Terminal> = project
    .update(cx, |p, cx| p.create_terminal_task(spec, cx))
    .await?;

// create_terminal_task returns the Terminal entity but does NOT place it in a
// pane; wrap it in a TerminalView and add it to the agents pane:
let terminal_view = cx.new(|cx| TerminalView::new(terminal.clone(), ..., window, cx));
ws.add_item_to_pane(&agents_pane, Box::new(terminal_view), None, true, window, cx);

// Register the handle so the bridge can inject text later:
bridge.register_terminal(agent_id, terminal);
```

The command string itself is unchanged from `spawn.ts`:

```
export CHARM_AGENT_ID=<id>
export CHARM_SOCKET=<socket>
exec claude --session-id <uuid> --model <m> --permission-mode auto \
  --mcp-config <sessionMcpConfig> --append-system-prompt <rolePrompt> <prompt>
```

Only *where* it runs changes (a Zed terminal tab instead of a tmux pane). The
env vars, flags, and system-prompt assembly all stay.

**Open question #1: RESOLVED.** The call is
`Project::create_terminal_task(SpawnInTerminal { command, args, env, cwd, .. }, cx)`
returning `Task<Result<Entity<Terminal>>>` (verified against pinned Zed source).
The `TerminalKind` / `TerminalBuilder` framing in earlier drafts was wrong for
this version.

---

## Text injection (pingOrchestrator, continue_agent)

The bridge holds `agent_id -> Entity<Terminal>`. On an inject request, use
`Terminal::paste`, NOT raw `input`:

```rust
terminal_entity.update(cx, |terminal, cx| {
    terminal.paste(&text);
});
```

**[VERIFIED against pinned Zed source]** `Terminal::paste(&str)` already does the
bracketed-paste handling the old tmux path needed: when the terminal is in
`Modes::BRACKETED_PASTE` it wraps the text in `\x1b[200~ .. \x1b[201~`; otherwise
it converts `\n`/`\r\n` to `\r`. `Terminal::input(bytes)` is the RAW path (writes
straight to the PTY with no newline handling) and should NOT be used for
multi-line agent messages -- it is the bug the old `send-keys -l` split caused.

Original open question + T-028 Risk 1 (do newlines submit early?) is therefore
answered by an existing API rather than a hand-rolled escape wrap. One residual
runtime check (needs the full editor build): confirm claude's REPL enables
`TermMode::BRACKETED_PASTE` so the wrapping branch is taken. `paste()` degrades
safely either way.

### Idle-gated delivery for the orchestrator target

Injection to the **orchestrator's** terminal uses the idle-gated pull path
defined in orchestration-model.md Decision 4 and the Phase 1 revision:

- Before calling `terminal.input()`, check whether the operator is mid-input on
  the orchestrator's `TerminalView`.
- If the operator is composing, queue the payload and deliver it at the next
  turn boundary (when the `TerminalView` signals idle). This prevents the
  typing-collision hazard where an injected event interleaves with the operator's
  half-typed message.
- The Zed fork's real `TerminalView` handle makes this reliable; a tmux pane has
  no equivalent idle signal.

Injection to **sub-orchestrator and worker terminals** uses direct
`terminal.input()` with no idle gate -- those terminals are not operator-facing,
so collision is not a concern.

This call serves:

- `pingOrchestrator` — wake the orchestrator after a sub-agent changes state
  (idle-gated; orchestrator terminal target)
- `continue_agent` — deliver orchestrator guidance to a blocked agent
  (direct; sub-orchestrator or worker terminal target)
- `set_mode` — inject `/model <id>` into the orchestrator's REPL
  (idle-gated; orchestrator terminal target)

---

## Liveness (replaces sweepDeadPanes)

Instead of the 15-second `tmux list-panes --pane_dead` poll, subscribe to each
terminal's exit event:

```rust
cx.subscribe(&terminal_entity, |this, _, event, cx| {
    if matches!(event, terminal::Event::CloseTerminal) {
        // mark agent dead, notify daemon, reap
    }
}).detach();
```

This is event-driven and strictly cleaner than the poll. The two-streak filter
(seen-dead-twice before reaping) that the tmux sweep needed to avoid racing a
normal teardown is no longer necessary — the exit event is authoritative.

---

## Teardown

When the daemon fires `tearDownAgent`, close the terminal item:

```rust
agents_pane.update(cx, |pane, cx| {
    pane.close_item_by_id(terminal_view_id, SaveIntent::Skip, window, cx);
});
bridge.unregister_terminal(agent_id);
```

Zed's `PaneGroup` resizes the remaining tabs automatically — no relayout math
(the tmux layout-checksum code is gone entirely).

---

## Status: draft
