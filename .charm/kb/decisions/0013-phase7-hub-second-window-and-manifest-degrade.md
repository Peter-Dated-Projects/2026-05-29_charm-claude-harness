---
id: 0013-phase7-hub-second-window-and-manifest-degrade
root: decisions
type: decision
status: current
summary: "Phase 7 multi-session Hub is a SECOND top-level GPUI window (cx.open_window) in a new charm_hub crate, opened by the `charm: Open Hub` action; its session list comes from charm::sessions_manifest(socket), which degrades ANY RPC failure to an empty Vec because the daemon-side sessions_manifest RPC is deferred to the daemon go-live batch."
created: 2026-06-26
updated: 2026-06-26
---

**Context.** Phase 7 (T-059) is the cross-session Hub: a picker listing every
running charm session so the operator can jump between them. The fork-side UI and
the bridge client method are buildable now, but the daemon RPC that actually
enumerates sessions is not -- it edits the live charm daemon and needs the
session-ending restart, so it was deferred to the daemon go-live batch.

**Decision.**

- *A new `charm_hub` crate, not a center-pane tab.* The Hub is a SECOND top-level
  GPUI window via `cx.open_window(WindowOptions{..}, |_, cx| cx.new(|cx|
  HubView::new(socket, cx)))`. This mirrors how the Tauri design surfaced it (a
  separate `WebviewWindow`) and is distinct from the orchestration canvas, which
  is an `Item` tab in the existing window (`charm_canvas`). The window is small
  and centered (`Bounds::centered`, ~380x560), titled "Charm Hub".
- *Action wiring mirrors `charm_canvas::init`.* `charm_hub::init(socket, cx)`
  registers the `charm: Open Hub` action on every workspace via `observe_new` +
  `workspace.register_action`. `main.rs` calls it right after
  `charm_canvas::init`, passing `CHARM_BRIDGE.get().map(|b| b.socket().to_path_buf())`.
  The `register_action` handler's `Context<Workspace>` derefs to `App`, which is
  what `cx.open_window` needs to mint the new window.
- *The session list is a graceful-degrade RPC.* `charm::sessions_manifest(socket)
  -> Vec<SessionManifestEntry>` calls the daemon `sessions_manifest` RPC and maps
  ANY failure (unknown method, malformed reply, dead socket) to an empty `Vec`.
  Today's daemon returns `unknown method`, so the Hub renders a clean "no
  sessions" empty state and the build stays green. Same pattern as
  `StatusSnapshot::sub_orchestrators` degrading an omitted field to an empty list.
  HubView fetches the manifest off the UI thread (`background_executor().spawn`,
  the RPC client blocks) then `cx.notify()`s.
- *`SessionManifestEntry` carries `root`, not just the spec's documented fields.*
  The phase-7 spec lists the manifest as `{ uuid, label, status, agent_count,
  socket_path }`. But a row click must open the session's PROJECT ROOT in a Zed
  workspace (`workspace::open_paths(&[root], AppState::global(cx),
  OpenOptions::default(), cx)`), and the root is NOT derivable from `socket_path`
  -- on macOS the socket lives under the OS temp dir, not the run dir. So the
  struct adds an optional `root: String` field. The deferred daemon RPC already
  scans `.charm/run/*/meta.json`, which carries `root`, so populating it is free.
  All fields past `uuid` are `#[serde(default)]` so partial/older entries still
  deserialize.

**Dependency (the one open gap).** The Hub stays empty until the daemon-side
`sessions_manifest` RPC lands. That RPC is a pure addition (scans sibling
`run/*/meta.json`, returns the manifest including each session's `root`) -- no
interface-breaking change to existing methods. It is the only required new daemon
RPC in the whole fork plan, and the reason Phase 7 is last. It also gives
`set_session_description`'s `meta.json` label its first consumer (today it writes
to a dead end). See [[0012-phase5-fork-bootstrap-register-panes-and-daemon-spawn]]
for the other deferred daemon-source work (inject push, spawn-spec relay) and
[[charm-ui-daemon-write-rpcs-need-socket-global]] for the socket-handoff pattern.
