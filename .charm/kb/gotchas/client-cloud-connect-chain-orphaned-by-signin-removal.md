---
id: client-cloud-connect-chain-orphaned-by-signin-removal
root: gotchas
type: gotcha
status: current
summary: "Removing client::sign_in_with_optional_connect (the sign-in entry point) leaves the cloud-websocket chain connect_to_cloud -> run_cloud_connection -> Client::handle_message_to_client as unreachable dead_code; it was the chain's only root, so a cloud/remote teardown can delete the whole chain plus its _cloud_connection_task / cloud_connection_id state holistically."
created: 2026-06-26
updated: 2026-06-26
---

In the Phase-0 sign-in strip (T-048), deleting `Client::sign_in_with_optional_connect`
in `crates/client/src/client.rs` removed the ONLY caller of `connect_to_cloud`.
That orphaned a self-contained chain (build stays green -- these are `dead_code`
warnings, not errors):

- `connect_to_cloud` (was called only by the deleted sign-in method) ->
- `run_cloud_connection` (called only inside connect_to_cloud's reconnect loop) ->
- `Client::handle_message_to_client` (called only inside run_cloud_connection).

Note: `UserStore::handle_message_to_client` in `client/src/user.rs` is a SEPARATE,
still-live method on a different type -- don't confuse them.

T-048 intentionally LEFT this chain in place: removing it cascades into cloud
connection state (`_cloud_connection_task`, `cloud_connection_id` on the client
state struct, the `INITIAL_/MAX_RECONNECTION_DELAY` consts, and the `StdRng`
imports), which is cloud/remote teardown scope, not sign-in/settings scope. The
two imports the sign-in method alone used (`feature_flags::FeatureFlagAppExt as _`
and gpui `TaskExt`) WERE removed since they were trivially orphaned.

For the future cloud/remote teardown: the sign-in removal already severed the only
live entry point, so `connect_to_cloud` + `run_cloud_connection` +
`Client::handle_message_to_client` + the `_cloud_connection_task` field can be
deleted as one unit. `cloud_client` itself stays -- user.rs still calls
`cloud_client.get_authenticated_user`.
