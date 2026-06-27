---
id: auto-update-not-deletable-in-phase0
root: gotchas
type: gotcha
status: current
summary: "The auto_update crate cannot be deleted until the remote-cluster teardown: remote_connection reuses auto_update::AutoUpdater for remote-server binary download (not update UI), keeping it linked into zed; and gpui registers action namespaces at LINK time (inventory), so the zed.rs expected_namespaces test must keep \"auto_update\" until the crate is fully unlinked."
created: 2026-06-26
updated: 2026-06-26
---

Phase-0 (T-039) outcome: the two true leaves (`edit_prediction_cli`, `auto_update_helper`)
and `auto_update_ui` were deleted, and the editor's auto-update feature was fully removed
(title_bar update-status UI, activity_indicator, zed main.rs init, and the "Check for
Updates" / "View Release Notes Locally" app menu items). The **`auto_update` crate is
intentionally retained** and stays a workspace member — its deletion is folded into the
later remote-cluster teardown ticket so it happens in dependency order.

Why auto_update can't be deleted yet:

- `crates/remote_connection/src/remote_connection.rs` — `use auto_update::AutoUpdater;` and
  four calls to `AutoUpdater::download_remote_server_release` / `get_remote_server_release_url`.
  This is the remote-dev server-binary download path, NOT editor update UI. `remote_connection`
  is a later remote-cluster teardown target, and `cargo tree -p zed -i auto_update` shows
  it pulls auto_update into zed via many paths (agent_ui, git_ui, recent_projects, title_bar,
  ...). So auto_update stays linked into the zed binary regardless of the editor changes.

GOTCHA for the eventual remote-teardown agent (this is the part that bites twice):

- gpui collects actions via `inventory::collect!(MacroActionBuilder)` / `inventory::iter`
  (see `crates/gpui/src/action.rs`) — i.e. **link time**, not at `init()`. Any linked crate's
  `actions!` macro contributes its namespace to `cx.all_action_names()`. So removing
  `auto_update::init` and the menu items does NOT drop the `"auto_update"` namespace; only
  fully unlinking the crate does. The `test_action_namespaces` test in `crates/zed/src/zed.rs`
  (~line 5300) asserts the exact namespace set, so **keep `"auto_update"` in
  `expected_namespaces` until auto_update is no longer linked into zed**; remove that line only
  in the same change that drops the crate. (`cargo build -p zed` does not compile this
  `#[gpui::test]`, so a stale entry won't surface until `cargo test`.)
- `auto_update_ui` registered its actions under the `auto_update` namespace (not its own), and
  `"auto_update_ui"` was never in `expected_namespaces`, so deleting it required no test change.

Lower-priority fallout to clean up when auto_update is finally removed:
`script/bundle-windows.ps1` builds `--package auto_update_helper` (already deleted — will break
Windows bundling); `crates/auto_update/src/auto_update.rs` joins `auto_update_helper.exe` by
runtime path; `typos.toml`, `.github/CODEOWNERS.hold`, and
`crates/edit_prediction_context/src/git_log_context.rs` test fixtures hold stale path strings.
