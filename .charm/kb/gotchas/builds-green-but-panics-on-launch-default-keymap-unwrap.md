---
id: builds-green-but-panics-on-launch-default-keymap-unwrap
root: gotchas
type: gotcha
status: current
summary: "The stripped fork compiles green but panicked on launch: load_default_keymap unwrapped KeymapFile::load_asset, which errors because ~115 default bindings still reference deleted actions (agent::*, edit_prediction::*, etc); fix is the tolerant load_asset_allow_partial_failure path, not asset pruning."
created: 2026-06-26
updated: 2026-06-26
---

# Builds green, panics on launch: default-keymap unwrap on stripped actions

`cargo build -p zed` passing does NOT mean the assembled fork launches. The
binary compiled clean but aborted before the window opened, in
`crates/zed/src/zed.rs::load_default_keymap`. That function used to do:

```rust
cx.bind_keys(KeymapFile::load_asset(DEFAULT_KEYMAP_PATH, Some(KeybindSource::Default), cx).unwrap());
```

`load_asset` returns `SomeFailedToLoad` -> `bail!` whenever a binding names an
action that is no longer registered. Our Phase-0 strip deleted whole crates
(`agent`, `agents_sidebar`, `edit_prediction`, `copilot`, `inline_assist`,
assistant, sign-in/onboarding), but the default keymap assets still bind keys to
their actions -- ~115 such bindings in `assets/keymaps/default-macos.json`
alone, plus the linux/windows variants, the `macos/`+`linux/` subdirs, and
`specific-overrides*.json`. So the `.unwrap()` panicked at startup.

## The fix (robust, in-scope)

Don't unwrap, and don't try to prune 115+ bindings across every keymap file.
`KeymapFile` already exposes a tolerant loader -- `load_asset_allow_partial_failure`
-- that keeps every binding whose action still resolves and silently drops the
rest (per-binding granularity: a bad binding does not take out valid siblings in
the same section). A small zed.rs helper wraps it, applies the `KeybindSource`
meta itself (the partial-failure loader doesn't take a source param), and logs
on hard failure:

```rust
fn load_default_keymap_asset(asset_path: &str, source: KeybindSource, cx: &App) -> Vec<KeyBinding> {
    match KeymapFile::load_asset_allow_partial_failure(asset_path, cx) {
        Ok(mut bindings) => { for kb in &mut bindings { kb.set_meta(source.meta()); } bindings }
        Err(err) => { log::error!("Failed to load built-in keymap \"{asset_path}\": {err:#}"); Vec::new() }
    }
}
```

This is the correct posture for a fork that strips features: a stale binding must
never panic the app. It lives entirely in `crates/zed/src/zed.rs` --
`load_asset_allow_partial_failure` is already `pub` in `crates/settings`, so no
edit to the settings crate is needed.

## Why NOT prune the keymap assets

Pruning is cosmetic only: the tolerant loader discards the accumulated error
message, so dropped bindings produce zero log spew. Hand-removing 115+ bindings
per file across macos/linux/windows + subdirs + overrides is large churn with a
real risk of deleting a still-valid binding. Skip it -- the loader reflects
reality at runtime.

## Verified launch

After the fix, `./target/debug/zed <dir>` rendered its first frame and stayed
alive in its event loop with no `panicked at` in either stderr or
`~/Library/Logs/Zed/Zed.log`. No second startup panic surfaced. Notably the
charm bridge did NOT no-op as the ticket anticipated: with a live charm session
present at `~/.charm/run/<uuid>/`, the Phase-5 bootstrap detected the socket,
installed the terminal manager, and created the agents pane -- cleanly. Related:
[[agentrecord-union-breaks-test-helper-literals-not-binary-build]] (the inverse
gap: builds green but `cargo test` fails).
