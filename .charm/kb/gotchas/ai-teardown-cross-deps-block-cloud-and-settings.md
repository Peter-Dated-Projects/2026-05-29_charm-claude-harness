---
id: ai-teardown-cross-deps-block-cloud-and-settings
root: gotchas
type: gotcha
status: current
summary: "In the Phase-0 AI/edit-prediction teardown, cloud_api_types and cloud_llm_client are load-bearing for client/extensions/web_search (NOT deletable this campaign), agent_settings + settings_content sit in zed's tree but outside T-042's touches yet must be patched to drop language_model(_core), and collab/remote_server/benchmarks must be excluded from [workspace.members] to delete agent/language_model/prompt_store/acp_thread."
created: 2026-06-26
updated: 2026-06-26
---

Verified against the actual reverse-dependency graph of the pinned `zed-charm` checkout
while doing T-042 (tear down the AI + edit-prediction connected component). Four
cross-dependency facts contradict or extend the original delete list in
[[zed-phase-0-teardown-plan]] and will mislead a continuation worker if not known:

1. **`cloud_api_types` and `cloud_llm_client` are NOT deletable in this campaign.**
   The plan tentatively listed them "(V)". The graph says keep:
   - `cloud_api_types` <- client, cloud_api_client, extension, extension_cli,
     extension_host, extensions_ui, onboarding, title_bar, collab. It is the shared
     cloud API types crate, not AI-specific.
   - `cloud_llm_client` <- client AND web_search (web_search is a keep crate).
   Deleting either requires gutting `client` + the extension subsystem, which is a
   later phase. KEEP both. Consequence: `title_bar` depends on the component ONLY via
   `cloud_api_types`, so title_bar needs NO patch in this campaign.

2. **Two in-tree integration crates are OUTSIDE T-042's `touches` but must be patched.**
   `cargo build -p zed` compiles them (via title_bar/git_ui/workspace and the settings
   schema), and they depend on delete-set crates:
   - `agent_settings` -> `language_model` (uses `language_model::LanguageModel`, 1 site
     in agent_settings.rs `language_model_to_selection`).
   - `settings_content` -> `language_model_core` (`Speed`) plus a 566-line
     `language_model.rs` module + `AllLanguageModelSettingsContent` woven into the
     settings schema.
   To delete `language_model` / `language_model_core` you MUST edit these two crates.
   They are not in the ticket's touches list. The ticket body grants "AUTHORIZED to edit
   any file in the fork needed to keep the build green" + "no other agent is in the fork",
   so editing them is sanctioned -- but flag it; the plan's note that agent_settings is
   only a *dependency* of deleted crates was backwards (it is also a *dependent*).

3. **`collab`, `remote_server`, `benchmarks` are NOT in zed's build tree** (cargo tree
   -p zed -i errors for all three) but are workspace members whose Cargo.toml reference
   `agent` / `language_model` / `prompt_store` / `acp_thread` via workspace.dependencies.
   `cargo build -p zed` still validates every workspace member's manifest, so deleting
   those workspace.dependencies entries breaks the build via these three. To delete
   agent/language_model/prompt_store/acp_thread, exclude collab/remote_server/benchmarks
   from `[workspace.members]` (their real teardown is later phases: collab=Step 5,
   remote=later). Removing from members != deleting; it just drops them from the
   workspace build, which only `cargo build` (full) exercises -- the green gate is
   `cargo build -p zed`.

4. **The component is one interlocking core fed by ~8 integration points.** After the
   trivial top-leaves are gone, every remaining component crate stays linked through one
   of: zed (direct, ~12 deps), `settings_ui` (agent, agent_skills, copilot, copilot_ui,
   edit_prediction, edit_prediction_ui, codestral, language_model), `editor`
   (edit_prediction_types -- the delicate inline integration), `git_ui` (language_model,
   prompt_store), `agent_settings` (language_model), `settings_content`
   (language_model_core), `language_tools` (edit_prediction). Nothing downstream deletes
   until its integration point is severed -- so the endgame is: sever all 8 integration
   points, then bulk-delete the orphaned crate dirs + workspace entries in one green step.
   Use `cargo tree -p zed -i <crate>` (NOT Cargo.toml grep) to confirm the true leaf at
   each step; a crate often stays linked via a transitive path after one edge is dropped.
