---
id: agent-settings-keeps-collaboration-panel-and-agent-groups-alive
root: gotchas
type: gotcha
status: current
summary: "In Phase-0 settings dead-key cleanup, the `agent` and `collaboration_panel` settings groups are NOT dead leftovers -- the kept agent_settings crate reads collaboration_panel.dock and the agent group, and settings_ui still renders collaboration_panel_section, so removing either breaks the build."
created: 2026-06-26
updated: 2026-06-26
---

When stripping dead settings keys for stripped features (sign-in, collab, AI), it
is tempting to also delete the `agent` and `collaboration_panel` groups from
`assets/settings/default.json` + `crates/settings_content` because their headline
features (the agent panel, the collaboration panel) were torn down. Do NOT -- both
are still load-bearing for the KEPT `agent_settings` crate:

- `crates/agent_settings/src/agent_settings.rs` reads
  `content.collaboration_panel.as_ref()...dock` and writes it back as the agent
  panel's `collaboration_panel_dock` layout value. The agent panel reuses the
  `collaboration_panel.dock` setting for its own dock position.
- `crates/settings_ui/src/page_data.rs` still has a live
  `collaboration_panel_section() -> [SettingsPageItem; 4]` wired into a page, and
  reads `settings_content.collaboration_panel...` in several closures.
- `agent: Option<AgentSettingsContent>` in `settings_content.rs` is consumed by
  agent_settings (on the Phase-0 KEEP list).

Consequence: in the T-048 settings dead-key pass, the only genuinely dangling keys
were the three title_bar sign-in/account toggles
(`show_sign_in`/`show_user_menu`/`show_user_picture`) -- removed from both
`title_bar.rs` and `default.json`. There were NO top-level `assistant` or `call`
keys in default.json. `edit_predictions` was left untouched because it is owned by
the deferred editor edit-prediction ticket (T-045), not this one.

Rule of thumb for "is this settings group dead?": grep for the field on the
top-level struct in `settings_content/src/settings_content.rs` (or language.rs),
then grep consumers OUTSIDE settings_content. If agent_settings or settings_ui
reads it, it survives -- a torn-down feature can still leave a setting that another
kept crate piggybacks on.
