# Conventions

Patterns and idioms *this specific repo* follows -- how code is structured, named, tested.

| Note | Summary | Status |
|---|---|---|
| [problem-decomposition](problem-decomposition.md) | How to write prompts that decompose complex problems into orthogonal, well-scoped sub-tasks for parallel worker dispatch. | current |
| [charm-bridge-seams-marshal-to-main-thread-via-channels](charm-bridge-seams-marshal-to-main-thread-via-channels.md) | The gpui-free charm crate's UI seams (InjectHandler, OnAgentSpawned) are called from background threads; the gpui side forwards onto a futures mpsc channel and drains it in a foreground task spawned on the first Workspace via observe_new. | current |
| [charm-ui-daemon-write-rpcs-need-socket-global](charm-ui-daemon-write-rpcs-need-socket-global.md) | The gpui side only gets the bridge's read-state via set_bridge_state, not the daemon socket; UI->daemon write RPCs (approve_gate, future dismiss/kill) reach the socket via a second charm_ui OnceLock<PathBuf> set by the binary, and run on a background executor since the RPC client blocks. | current |
