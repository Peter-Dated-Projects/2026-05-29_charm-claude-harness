---
id: charm-ui-daemon-write-rpcs-need-socket-global
root: conventions
type: convention
status: current
summary: "The gpui side only receives the bridge's read-state (Arc<Mutex<CharmState>>) via set_bridge_state -- it has no daemon socket. UI->daemon WRITE RPCs (approve_gate, future dismiss/kill) reach the socket through a second charm_ui OnceLock<PathBuf> set by the binary (set_bridge_socket), and run on a background executor because the RPC client blocks."
created: 2026-06-26
updated: 2026-06-26
---

Established by Phase 6 (`approve_gate`), the first UI-initiated daemon *write*.

The Phase 1/2 data flow is read-only: the binary hands the gpui layer the bridge's
shared state with `charm_ui::set_bridge_state(bridge.state())` -- an
`Arc<Mutex<CharmState>>`. That state carries tickets/agents/gates/coordination but
NOT the daemon socket path, so the UI cannot call any RPC from it.

To add a write path, mirror the read pattern with a second global:

- `crates/charm_ui`: `static BRIDGE_SOCKET: OnceLock<PathBuf>` plus
  `pub fn set_bridge_socket(&Path)` / `pub(crate) fn bridge_socket() -> Option<PathBuf>`.
- `crates/zed/src/main.rs`: alongside `set_bridge_state`, call
  `charm_ui::set_bridge_socket(bridge.socket())` before the bridge is moved into
  its `OnceLock`. (`CharmBridge::socket()` exposes the detected data socket.)
- The RPC itself lives in the gpui-free `charm` crate as a free fn taking the
  socket: `charm::approve_gate(socket, gate_id, approve) -> Result<()>` (wraps the
  existing blocking `rpc_call`).
- Call it OFF the UI thread: `cx.background_executor().spawn(async move { .. }).detach()`.
  The RPC client uses blocking std sockets, so an inline call on a click handler
  would jank the frame for a full daemon round-trip. Let the next poll tick reflect
  the result (e.g. a resolved gate drops out of `pending_approvals` and the
  banner/badge clear themselves -- no optimistic local mutation needed).

`bridge_socket()` returns `None` when no charm session was detected, so the write
buttons are inert in stock Zed -- same graceful-degradation contract as
`bridge_state()`. See [[charm-bridge-seams-marshal-to-main-thread-via-channels]]
for the read-side seam direction (daemon -> UI).
