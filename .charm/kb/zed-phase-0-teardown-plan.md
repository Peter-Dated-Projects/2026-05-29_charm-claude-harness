# Phase 0 -- reverse-dependency teardown plan (evidence-based)

This is the leaf-first teardown order the phase-0 doc asks for, derived from the
ACTUAL reverse-dependency graph of the pinned Zed checkout (not from the feature
list). It replaces "delete the targets and chase the fallout" -- the approach
that broke the first strip attempt.

Method: for each strip target, `grep -rlE "^<crate>(\.workspace|=)" crates/*/Cargo.toml`
to find every crate that inherits it. Counts below are dependent crate dirs.

## Two findings that change the plan

1. **Some "targets" are NOT deletable -- they must be GUTTED.** They are
   load-bearing inside KEEP crates (editor, workspace, project, terminal_view):
   - `telemetry` -- **34 dependents**, incl. editor, workspace, project_panel,
     client, fs, dap, theme_selector, recent_projects, title_bar. Deleting means
     patching 34 crates. GUT instead: keep the crate, make its API a no-op.
   - `remote` (16: incl. project, terminal_view, workspace, recent_projects,
     file_finder, project_panel) + `remote_connection` (7). Remote-project types
     are referenced pervasively. Keep/stub; full removal is post-v1, not Phase 0.
   - `client` -- already flagged "gut not delete" in the phase doc. Confirmed:
     entangled with collab AND LLM token refresh; 1 direct telemetry-style use
     plus collab. Gut auth/collab paths, keep crate.
   - `agent_settings` -- **10 dependents** incl. workspace, title_bar, git_ui,
     diagnostics. Woven into editor chrome. Gut (stub settings struct), don't drop.

2. **The strip list is INCOMPLETE.** The dependency graph surfaces AI-surface
   crates not on the phase-0 removal list. Deleting `language_model` (20 deps)
   before these are gone leaves the tree non-building. Add to the delete set
   (classified by name + dep profile; (V) = verify before deleting):
   - delete: `codestral`, `acp_thread`, `acp_tools`, `ai_onboarding`,
     `prompt_store`, `web_search_providers`, `google_ai`, `open_ai`,
     `open_router`, `opencode`, `cloud_llm_client`, `eval_cli`,
     `sidebar` (V -- depends on the whole agent surface; looks like the agent
     panel), `cloud_api_types` (V -- confirm nothing in `client` needs it).

## KEEP-but-patch (remove the dep line + delete the call sites, keep the crate)

- `language_tools` -- LSP log / syntax-tree tooling, NOT AI. Drop its
  `edit_prediction` + `telemetry` deps.
- `activity_indicator` -- general status-bar indicator (LSP/download progress),
  NOT just auto-update. Drop its `auto_update` dep, keep the indicator.
- `context_server` -- Zed's MCP integration. Depends on `oauth_callback_server`
  (MCP OAuth). Removing oauth requires patching context_server. Decide: keep
  oauth_callback_server, or gut the MCP-OAuth path. (charm runs its own MCP shim;
  Zed's context_server is independent and harmless to keep.)
- `notifications` -- collab notifications panel (depends on `channel`). Delete
  with the collab cluster or gut.

## Teardown ORDER (leaf-first; build after each step)

Prereq: a GREEN baseline `cargo build -p zed` before touching anything, so new
breakage is attributable.

**Step 1 -- true leaves (0 external dependents, safest first):**
`edit_prediction_cli` (0), `auto_update_helper` (0). Delete crate dirs + remove
from `[workspace.members]`/`[workspace.dependencies]`. Build.

**Step 2 -- auto-update cluster:** [CORRECTED after T-039 -- the original
"auto_update_ui is zed-init-only / auto_update just needs title_bar+activity_indicator"
was wrong.]
- `auto_update_ui`: consumed only by the `zed` crate, but in BOTH `main.rs` init
  AND `crates/zed/src/zed/app_menus.rs` (ViewReleaseNotesLocally) + `crates/zed/Cargo.toml`.
  Deletable now once those zed refs are removed.
- `auto_update`: NOT a clean Step-2 deletion. Besides the editor UI (title_bar,
  activity_indicator, `app_menus.rs` auto_update::Check, `zed.rs` namespace test,
  zed Cargo dep -- all removable now), it is used by `remote_connection`
  (`AutoUpdater::download_remote_server_release` -- remote-server binary download,
  NOT editor update). remote_connection is a later remote-cluster teardown target.
  So in Step 2: remove the editor's auto-update FEATURE (decouple title_bar +
  activity_indicator + zed), delete `auto_update_ui`, but KEEP the `auto_update`
  crate alive for remote_connection. Delete the `auto_update` crate in the
  remote-teardown step, in dependency order.
- Windows-only note: `auto_update_helper` (deleted in Step 1, 0 cargo deps) is
  referenced by `bundle-windows.ps1` + a cfg(windows) exe-join in auto_update.rs;
  dead on macOS, no `cargo build -p zed` impact. Revisit if Windows packaging matters.

**Steps 3+4 -- MERGED: the AI + edit-prediction connected component (T-042).**
[REVISED after T-039: edit-prediction and AI/LLM are NOT separable. `copilot` is
depended on by BOTH `edit_prediction` and `language_models`; `edit_prediction_types`
by BOTH `copilot` and `editor`. Splitting breaks the build mid-step.] Tear the
whole component down as ONE leaf-first campaign, using `cargo tree -p zed -i
<crate>` for the true LINK order (more reliable than Cargo.toml grep -- cf. the
auto_update namespace-test gotcha).

DELETE: all `edit_prediction*` (cli done), `zeta_prompt`, `codestral`,
`copilot`/`copilot_ui`/`copilot_chat`, `agent`/`agent_servers`/`agent_skills`/
`agent_ui`, `anthropic`, `bedrock`, `language_model`/`language_model_core`/
`language_models`/`language_models_cloud`, `google_ai`/`open_ai`/`open_router`/
`opencode`, `acp_thread`/`acp_tools`, `ai_onboarding`, `prompt_store`,
`web_search_providers`, `eval_cli`. [DONE so far (T-042): acp_tools, sidebar,
web_search_providers, eval_cli -- build green.]

DO NOT DELETE `cloud_api_types` + `cloud_llm_client` [CORRECTED after T-042 via
cargo tree -- they are load-bearing for `client`/`cloud_api_client`/extensions/
onboarding (cloud_api_types) and client+web_search (cloud_llm_client). Removing
them guts client+extensions, a LATER phase. The plan's earlier "(V) delete" was
wrong.] `sidebar` was confirmed = the agent panel and IS deleted.

KEEP but PATCH (these are the integration EDGES into the component -- sever them):
`editor` (inline edit-prediction -- the delicate one), `settings_ui`,
`settings_content` (drops `language_model_core` -- a 566-line module + settings
schema), `agent_settings` (drops `language_model` -- it is an integration EDGE,
not just a downstream dep; the earlier classification was backwards),
`language_tools`, `git_ui`, `zed` (main.rs, zed.rs ~9 refs, open_listener.rs,
app_menus, Cargo.toml). NOTE: `title_bar` needs NO patch -- it reaches the
component only via `cloud_api_types`, which we keep.

KEEP, do NOT delete this campaign (later gut targets; keeps depend on them):
`agent_settings` (patched, not deleted), `client`, `telemetry`,
`remote`/`remote_connection`, `cloud_api_types`, `cloud_llm_client`, plus the
hard-keeps (editor, workspace, project, terminal*, dap*, debugger*, text, theme).

ENDGAME (worker-003's strategy, better than leaf-by-leaf): the ~27 remaining
crates are an interlocking core fed by ~8 integration edges (zed direct,
settings_ui, editor, git_ui, agent_settings, settings_content, language_tools).
Peeling leaves is slow because they interlock; instead SEVER all 8 edges first
(remove each KEEP crate's dep + call sites into the component), which orphans the
whole component, THEN bulk-delete the orphaned crate dirs + their
`[workspace.members]`/`[workspace.dependencies]` entries in one green step.
Gotcha [CORRECTED after T-044 -- excluding from members is INSUFFICIENT]:
`remote_server` is a `[dev-dependency]` of `recent_projects` (a KEEP crate), so
cargo parses remote_server's manifest during workspace resolution REGARDLESS of
`[workspace.members]`. remote_server hard-deps `acp_thread` + dev-deps `agent`
(whose closure anchors ~20 of the 26 component crates), so the component cannot be
removed from `[workspace.dependencies]` until remote_server's manifest stops
inheriting them. STEP B therefore MUST edit `crates/remote_server/Cargo.toml`
(drop its acp_thread + agent deps) and/or `crates/recent_projects/Cargo.toml`
(drop the remote_server dev-dep). remote_server is not in the `cargo build -p zed`
gate (later remote-teardown), so it may be left non-building as long as the
workspace manifest PARSES and `cargo build -p zed` is green.

zeta_prompt [CORRECTED after T-044]: KEEP it -- load-bearing via `cloud_api_types`
(a keep) and self-contained. Removed from the delete-set; the component is 26
crates, not 27.

The editor edge was severed by RELOCATION not excision (T-044): the
`edit_prediction_types` crate contents were moved INTO `editor` as a local module
(only change icons::IconName -> ui::IconName), so editor links no AI crate and
`Direction` survives as `editor::Direction`. The editor keeps an INERT
edit-prediction shell because `vim`/`workspace` (hard-keeps, out of scope)
hard-depend on `Editor::refresh_edit_prediction`/`accept_edit_prediction`/
`EditPredictionRequestTrigger`/`AcceptEditPrediction`. Fully excising the shell
needs a later ticket scoped to include vim + workspace + editor.

Build green after EVERY removal. Resumable: a worker low on context reports what it
removed, what remains, and the next safe leaf; the orchestrator relays a continuation.

**Step 5 -- collaboration cluster. [DONE in T-046, build green.]**
- DELETED: `call` (LiveKit), `channel`, `collab_ui` + their workspace entries.
  Edges severed in: zed (main.rs init/CLI channel-notes, zed.rs collab panel,
  app_menus), title_bar (deleted collab.rs 780L + ActiveCall), file_finder
  (ChannelStore), git_ui (dropped the `call` cargo feature).
- `notifications`: GUTTED, not deleted -- it bundles the collab NotificationStore
  AND a general-purpose `StatusToast` widget used by 5 OUT-OF-SCOPE keep crates
  (component_preview, debugger_ui, keymap_editor, onboarding, project_panel) +
  git_ui. Removed notification_store.rs + the channel/rpc coupling; kept
  status_toast.rs. `notifications::status_toast::StatusToast` path preserved.
  (workspace::notifications is a SEPARATE module in the keep crate -- untouched.)
- server-side `collab` crate: NOT a workspace member and nothing in zed's tree
  deps it, so its manifest is never parsed by `cargo build -p zed` -- left as-is,
  no Cargo.toml edit needed (contrast remote_server, which IS parsed via a dev-dep).
- FINDING: the LiveKit/WebRTC binary-size win is PARTIAL. `livekit_client` (the
  SDK) is gone, but `libwebrtc` + `webrtc-sys` remain -- pulled by the hard-keep
  `audio` crate (audio processing, not collab; used by zed + settings_ui). Fully
  dropping WebRTC needs separate work on `audio`.
- DEFERRED (folded into the deferred-cleanup bucket, T-045): relocate StatusToast
  into `ui/` and delete the notifications shell (needs touches on the 6 consumers);
  remove file_finder's now-dead `Match::Channel` variant.

**Step 6 -- account/auth. [DONE in T-047, build green.]**
- title_bar: removed the sign-in button, the "Signing in..." label, and the ENTIRE
  user-menu render (`render_sign_in_button` + `render_user_menu_button` deleted).
  Dropped the now-dead `show_sign_in`/`show_user_menu`/`show_user_picture` fields from
  `TitleBarSettings` + `from_settings`, and deleted `plan_chip.rs` (+ its mod/use).
- settings_ui: removed the "Show Sign In"/"Show User Menu"/"Show User Picture"
  toggles from `title_bar_section()` in page_data.rs. NOTE: those section builders
  return fixed-size arrays `[SettingsPageItem; N]` -- had to drop N from 10 to 7 or
  E0308 (see gotchas/settings-ui-page-sections-fixed-size-arrays).
- client: removed `SignIn`/`SignOut` from the `actions!` macro + their two
  `on_action` handlers in `init()` (the command-palette/menu entry points); kept
  `Reconnect`. KEPT the public `sign_in`/`sign_in_with_optional_connect`/`sign_out`
  methods -- they are load-bearing for the out-of-scope `onboarding` crate. No
  keymap binds `client::SignIn/SignOut` (keymaps use the unrelated
  `onboarding::SignIn`), so removing the actions is safe.
- zed/main.rs: removed the launch-time `cx.spawn(authenticate(...))` and the
  `authenticate` fn (its only caller) -- no auto-sign-in on launch.
- `oauth_callback_server`: untouched (kept, per plan -- context_server's MCP OAuth).
- CARRYOVER (out of T-047 touches, needs follow-up tickets):
  1. `onboarding` crate STILL has a sign-in surface (`onboarding::SignIn` action +
     a sign-in button in `basics_page.rs`, both calling
     `client.sign_in_with_optional_connect`). First-run onboarding can still prompt
     sign-in. A later ticket scoped to `onboarding` must strip it (and can then
     delete client's now-unused public sign-in methods).
  2. Removing the title-bar user menu also removed its Settings/Keymap/Themes/
     Extensions/Panel-Layout shortcuts. Still reachable via the app menu bar +
     command palette, but no longer from the title bar. Revisit if a lightweight
     title-bar menu is wanted.
  3. `assets/settings/default.json` still has `"show_sign_in": true` and the
     `settings_content` title_bar schema still defines show_sign_in/show_user_menu/
     show_user_picture (out of scope: assets/ + settings_content). Harmless dead
     keys; fold into Step 8 settings cleanup.

**Step 7 -- GUT (do last, separately):** stub `telemetry` to no-op (keeps all 34
dependents compiling), neuter `remote`/`remote_connection` UI entry points
(don't delete the types), finalize `agent_settings` stub. Full removal of
remote/telemetry types is explicitly post-v1.

**Step 8 -- settings + toolchain cleanup:** prune `settings_content` /
`assets/settings/` keys for removed features; remove `wasm32-*` targets from
`rust-toolchain.toml` if extensions are dropped; drop `x86_64-unknown-linux-musl`
(remote_server only). Confirm Settings page shows only surviving features.

**Done when:** `cargo run` launches a working editor -- no sign-in, no
collab/org UI, no edit-prediction -- terminal + debugger intact, Settings clean.

## Honest scale note

This is a multi-day teardown (the phase doc says so, and the graph confirms it:
telemetry alone touches 34 crates). Steps 1-3 are mechanical and safe; steps 4-7
are where the real call-site surgery lives. Build after every crate, never batch.
