# Phase 0 — Clean Zed fork (strip what we will never use)

**Status:** draft
**Blocks:** Phase 1 (transitively all later phases)
**Source:** T-026 (fork setup), Gram fork prior art, operator walkthrough of the running app

This is the first thing we do. Strip the features charm will never use. There
are no Cargo feature flags for any of these, so the only path is removing crates
from the workspace, deleting their UI call sites, and cleaning the related
settings.

---

## Where this phase sits in the architecture

The full charm-on-Zed architecture, with the components **Phase 0 strips** highlighted in blue. Everything gray is kept (or built in a later phase). Same diagram as the [architecture overview](architecture-diagram.svg), recolored to this phase.

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

  LEGEND["LEGEND · Phase 0 focus<br/>BLUE = upstream Zed feature stripped in Phase 0<br/>GRAY = the rest of the system (kept as-is, or built in later phases)<br/>strip targets connect to nothing here — they are being deleted<br/>==> primary data flow    -.-> secondary / control flow"]:::legend

  class s1,s2,s3,s4,s5,s6,s7 focus;
  class charmd,spawn,mcp,bridge,state,injsock,handlemap,files,editor,termviews,charmview,orchestrate,general,orchtab,agpane,liveness,cli,autodetect,banner,modal,hubview,sessrpc dim;
```

---

## Operator removal list (UI-driven — the authoritative target list)

Derived from walking through the running Zed app. Each item maps to the crates,
UI surfaces, and settings that implement it.

| # | Remove / Keep | Feature (as seen in the app) | What it maps to in the source |
|---|---|---|---|
| 1 | **REMOVE** | Sign-in button / login | Title-bar sign-in UI (`crates/title_bar/src/title_bar.rs`, settings `show_sign_in` + `show_user_menu` in `title_bar_settings.rs`); Zed Cloud auth in `crates/client`; `crates/oauth_callback_server` |
| 2 | **REMOVE** | Organization stuff | Org/channel concepts surfaced via `crates/collab_ui` (`collab_panel.rs`) and any org pages in `crates/settings_ui`; mostly falls out once collab is removed (see #4) |
| 3 | **KEEP** | Panel layouts | Zed's dock/panel layout system (`crates/workspace`) — untouched; charm relies on it |
| 4 | **REMOVE** | Collaborative working ("work with your team in real time — collaborative editing, voice, shared notes") | `crates/collab_ui`, `crates/call` (LiveKit voice/video), `crates/channel`, server-side `crates/collab` |
| 5 | **REMOVE** | Edit prediction (Zed's inline AI completion / Zeta) | `crates/edit_prediction`, `edit_prediction_cli`, `edit_prediction_context`, `edit_prediction_metrics`, `edit_prediction_types`, `edit_prediction_ui`, `crates/zeta_prompt`; the status-bar edit-prediction button; the `edit_prediction_*` settings block; the `settings_ui/src/pages/edit_prediction_provider_setup.rs` page |
| 6 | **KEEP** | Terminal + debugging | `crates/terminal`, `terminal_view`; debugger `crates/dap`, `dap_adapters`, `debug_adapter_extension`, `debugger_tools`, `debugger_ui` — all kept. Any AI hook in the debugger gets repointed to Claude later (out of scope for Phase 0; noted so it is not stripped). |

The "KEEP" rows matter as much as the "REMOVE" rows — they are explicit guards
against over-stripping (a worker following the AI-removal group must not delete
the debugger or terminal).

---

## Crates to delete (by group)

The operator list above plus the standard Gram-style strip. Edit-prediction and
the account/auth crates are additions beyond the original AI/collab/remote set.

| Group | Crates |
|---|---|
| Login / account / auth (#1) | `oauth_callback_server`; gut `client` (see gotcha) |
| Collaboration (#2, #4) | `collab_ui`, `call`, `channel` (server-side `collab` optional) |
| Edit prediction / Zeta (#5) | `edit_prediction`, `edit_prediction_cli`, `edit_prediction_context`, `edit_prediction_metrics`, `edit_prediction_types`, `edit_prediction_ui`, `zeta_prompt` |
| AI / LLM assistant | `agent`, `agent_servers`, `agent_settings`, `agent_skills`, `agent_ui`, `anthropic`, `bedrock`, `language_model`, `language_model_core`, `language_models`, `language_models_cloud`, `copilot`, `copilot_chat`, `copilot_ui` |
| Remote development | `remote`, `remote_connection` |
| Telemetry | `telemetry`, `telemetry_events` |
| Auto-update | `auto_update`, `auto_update_helper`, `auto_update_ui` |

> Note: `agent_settings` is also referenced by the editor/inline-assist paths —
> audit before deleting, like `client`. When in doubt, gut (remove the feature
> wiring) rather than delete the crate outright.

---

## Settings cleanup

Stripping a feature leaves dangling settings keys and settings-UI pages. After
the crate removals, clean these so the Settings page does not reference removed
features:

- **`crates/settings_ui`** — remove the pages tied to removed features:
  `pages/edit_prediction_provider_setup.rs`, any account/sign-in page, any
  collaboration/calls page. Audit `page_data.rs` and `settings_ui.rs` for
  entries pointing at removed crates.
- **`title_bar_settings.rs`** — drop `show_sign_in` and `show_user_menu` (or
  hardcode them off) so the title bar never renders the account UI.
- **Edit-prediction settings block** — remove the `edit_prediction_*` keys from
  the default settings schema (`assets/settings/`) and the settings content
  structs (`crates/settings_content`).
- **Assistant / agent settings** — remove the `agent`/`assistant` settings group
  once the AI crates are gone.
- **Calls / collaboration settings** — remove once `call`/`collab_ui` are gone.

The goal: open the Settings page in the stripped build and see only settings
for features that still exist (editor, terminal, debugger, theme, panel
layouts, keymap).

---

## Files to touch (mechanism)

1. **Root `Cargo.toml`** — remove the crates from `[workspace.members]` and
   `[workspace.dependencies]`.
2. **`crates/zed/Cargo.toml`** — remove the crates as direct deps.
3. **`crates/zed/src/main.rs`** — delete `use` imports and `::init(cx)` call
   sites for each stripped crate.
4. **`crates/title_bar/src/title_bar.rs`** — delete the sign-in button, user
   menu, and any organization/collab UI in the title bar.
5. **`crates/settings_ui/`** — delete the settings pages for removed features.

---

## The cascade dependency problem (the trap)

This is what broke the first strip attempt. You cannot delete a crate from
`[workspace.dependencies]` while other crates still reference it via
`dependency.workspace = true` in their own `Cargo.toml`. ~47 other crates
transitively reference the AI/collab crates.

The error looks like:

```
error: failed to load manifest for workspace member `.../crates/acp_thread`
Caused by: error inheriting `language_model` from workspace root manifest's
           `workspace.dependencies.language_model`
Caused by: `dependency.language_model` was not found in `workspace.dependencies`
```

**The correct order of operations** is a proper dependency-graph teardown, not
"delete the targets and fix the fallout":

1. Build the reverse-dependency graph: for each target crate, find every crate
   that lists it (`grep -rl "<crate>.workspace = true" crates/*/Cargo.toml`).
2. Classify each dependent: is it *also* something we want to delete (e.g.
   `acp_thread` is part of the AI surface), or a crate we keep that needs the
   dependency line removed and its call-sites patched?
3. Delete leaf-first: remove crates nothing-we-keep depends on, then work inward.
4. For each kept crate that referenced a deleted one, remove the dep line AND
   delete the code that used it. This is the real work — not just manifest edits.

This is a multi-day effort. Budget for it.

---

## Do NOT delete

- **`crates/text`** — the CRDT buffer model. The CRDTs are how every buffer
  works; orthogonal to the collaborative-editing *network* feature
  (`collab_ui`/`call`/`channel`). Removing `text` breaks everything.
- **`crates/client`** — entangled with BOTH the Zed Cloud collab connection AND
  the LLM token refresh. After stripping AI and collab, audit whether it can be
  removed entirely or just gutted. Safe to gut, dangerous to blindly drop.
- **`crates/collab`** — the server-side daemon binary; harmless to keep, won't
  link into the main binary either way.
- **Debugger + terminal** — `dap`, `dap_adapters`, `debug_adapter_extension`,
  `debugger_tools`, `debugger_ui`, `terminal`, `terminal_view`. Explicitly kept
  (operator list #6).

---

## Toolchain notes

- Rust `1.95.0` is pinned in `rust-toolchain.toml`.
- **Build prerequisites the preview build hit:** `cmake` (`brew install cmake`)
  and the **Metal Toolchain** (`xcodebuild -downloadComponent MetalToolchain`,
  ~700MB) are both required on macOS — the build fails without them. Document
  these in the fork README.
- If charm will not support user-installable extensions, the `wasm32-wasip2`
  and `wasm32-unknown-unknown` targets can be removed from
  `rust-toolchain.toml`. The `x86_64-unknown-linux-musl` target is only for the
  `remote_server` binary — remove once remote dev is stripped.

---

## Build + verify

```
cargo run               # debug build, fastest iteration
```

First cold build on Apple Silicon: ~3 min (after cmake + Metal toolchain are
present). `cargo run` in dev mode needs no code signing.

**Done when:** `cargo run` launches a working editor with **no sign-in button,
no collaboration/organization UI, no edit-prediction**, the Settings page shows
only surviving features, and the terminal + debugger still work. The
LiveKit/WebRTC native libs from `call` are the biggest binary-size win.

---

## Status: draft
