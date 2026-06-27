---
id: ai-component-deletion-blocked-by-remote-server-devdep
root: gotchas
type: gotcha
status: current
summary: "Physically bulk-deleting the AI/edit-prediction component in Phase 0 is blocked: remote_server (a [dev-dependency] of the keep crate recent_projects, so its manifest is parsed during workspace resolution regardless of [workspace.members] exclusion) hard-depends on acp_thread and dev-depends on agent, whose closure anchors 20 of the 26 component crates in the manifest-parse graph. Severing the editor+zed edges makes zed build AI-free, but full crate deletion needs remote_server (+recent_projects) in touches."
created: 2026-06-26
updated: 2026-06-26
---

RESOLVED in T-044 via authorized scope expansion: dropped remote_server/Cargo.toml's
`acp_thread` (regular) + `agent`/`language_model` (dev) deps, which unanchored the component
from the workspace manifest parse; then deleted all 26 component crate dirs (keeping
zeta_prompt) + their members/deps + the edit_prediction_ui profile override, and excluded
collab/remote_server/benchmarks from [workspace.members]. `cargo build -p zed` GREEN; all AI
crates now "did not match any packages". remote_server no longer compiles standalone (it uses
acp_thread in source) -- acceptable, it is a later remote-teardown target and not in the build
gate. The trap below is kept as durable knowledge for any future virtual-workspace teardown.

Found in T-044 (editor + zed edges, then STEP B bulk-delete). The editor edge and zed
edge were severed successfully and `cargo build -p zed` is GREEN with NO AI component crate
in zed's compile graph (verified via `cargo tree -p zed -i <crate>` -- all 26 report
orphaned except zeta_prompt). But STEP B (physically deleting the orphaned crate dirs +
their `[workspace.members]`/`[workspace.dependencies]` entries) fails the workspace
manifest parse.

## Why "exclude remote_server from [workspace.members]" is NOT sufficient

The prior plan ([[ai-teardown-cross-deps-block-cloud-and-settings]]) assumed excluding
collab/remote_server/benchmarks from `[workspace.members]` would free the component for
deletion. That is true for collab and benchmarks (they are ONLY members; nothing depends on
them, so member-exclusion removes them from the parse graph). It is FALSE for remote_server:

- `crates/recent_projects/Cargo.toml` has `remote_server.workspace = true` under
  **`[dev-dependencies]`** (not `[dependencies]`). recent_projects is a keep crate in zed's
  tree (zed -> ... -> recent_projects).
- Cargo resolves the whole virtual workspace into one lockfile, parsing EVERY member's full
  manifest including dev-dependencies. So remote_server's manifest is parsed because
  recent_projects (a member) dev-depends on it -- even after remote_server itself is dropped
  from `[workspace.members]`. (Empirically confirmed: with remote_server removed from members
  AND acp_thread removed from `[workspace.dependencies]`, `cargo check -p zed` fails with
  "error inheriting acp_thread ... was not found in workspace.dependencies", surfaced via the
  collab_ui -> title_bar -> recent_projects -> remote_server load chain.)

## What this anchors

`crates/remote_server/Cargo.toml`:
- `[dependencies]`: `acp_thread.workspace = true` (regular dep)
- `[dev-dependencies]`: `agent`, `language_model` (test-support)

Because the manifest parse must resolve these, and `agent`'s manifest in turn inherits the
whole AI surface (language_model, anthropic, prompt_store, copilot*, agent_servers,
agent_skills, the open_ai/open_router/google_ai/opencode/bedrock providers, ai_onboarding,
language_models*, edit_prediction_types, etc.), removing any of them from
`[workspace.dependencies]` breaks the parse. `cargo tree -p remote_server -e normal,dev,build`
intersected with the delete-set = 20 of the 26 crates are UNDELETABLE while remote_server is
parsed.

Only 6 component crates are OUTSIDE remote_server's closure and could be deleted in scope:
`edit_prediction`, `edit_prediction_ui`, `edit_prediction_context`,
`edit_prediction_metrics`, `codestral`, `agent_ui`. (Deleting only these was judged low-value
and was deferred so STEP B can be done in one clean pass once unblocked.)

NOTE: `zeta_prompt` is genuinely load-bearing (in zed's COMPILE graph via cloud_api_types, a
keep) and is self-contained -- keep it, like cloud_api_types/cloud_llm_client. It is NOT part
of the remote_server blocker; it must simply be dropped from the delete-set.

## To unblock

Expand a continuation ticket's `touches` to include `crates/remote_server/Cargo.toml`
(drop its `acp_thread` regular dep + `agent`/`language_model` dev-deps) and/or
`crates/recent_projects/Cargo.toml` (drop the `remote_server` dev-dep). This couples the AI
component's physical deletion to the remote-server teardown -- consistent with the Phase-0
plan already treating remote/* removal as a later phase ([[zed-phase-0-teardown-plan]] Step 7,
[[auto-update-not-deletable-in-phase0.md]]). Once severed, delete the 26 crate dirs (NOT
zeta_prompt) + their members/deps + the `edit_prediction_ui` profile override, and exclude
collab/benchmarks from members (their agent/language_model/prompt_store deps resolve fine
while those crates remain, so exclusion is only needed once those are deleted).

See also [[editor-edit-prediction-types-holds-direction]] for the (completed) editor edge.
