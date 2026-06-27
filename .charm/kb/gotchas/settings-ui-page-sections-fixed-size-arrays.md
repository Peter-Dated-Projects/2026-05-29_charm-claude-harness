---
id: settings-ui-page-sections-fixed-size-arrays
root: gotchas
type: gotcha
status: current
summary: "settings_ui page_data.rs builds each settings section as a fixed-size array [SettingsPageItem; N] with the count in the return type, so adding/removing a SettingItem requires bumping that N or the crate fails to compile (E0308)."
created: 2026-06-26
updated: 2026-06-26
---

In `crates/settings_ui/src/page_data.rs`, each settings section is produced by a
function whose return type is a **fixed-size array**, e.g.
`fn title_bar_section() -> [SettingsPageItem; 10] { [ ... ] }`. The element count
is baked into the type signature, not inferred.

Consequence: when you remove (or add) a `SettingItem` / `SectionHeader` entry from
one of these section arrays, you MUST update the `N` in `[SettingsPageItem; N]` to
match the new element count, or the crate fails with `E0308: mismatched types`
("expected an array with a size of N, found one with a size of M"). The build
gate `cargo build -p zed` surfaces this only when it reaches `settings_ui`, well
after the crate you actually edited.

Hit during the Phase-0 sign-in/account teardown (T-047): removing the "Show Sign
In" / "Show User Menu" / "Show User Picture" toggles from `title_bar_section()`
dropped it from 10 to 7 entries and required changing the return type to
`[SettingsPageItem; 7]`. Mirror the AI-page removals: every section deletion is a
two-edit change -- delete the entry block AND fix the array length. Grep the
surrounding function for `-> [SettingsPageItem;` after editing.
