---
id: 0012-phase5-fork-bootstrap-register-panes-and-daemon-spawn
root: decisions
type: decision
status: current
summary: "Phase 5 fork-side bootstrap spawns charmd directly (uuid minted in Rust, cmd overridable via CHARM_DAEMON_CMD) and fires register_panes with Zed entity-id handles against the still-tmux-shaped daemon contract -- safe because the daemon's relayout() no-ops on non-tmux pane ids. Daemon-side Zed-aware pane model is deferred."
created: 2026-06-26
updated: 2026-06-26
---

T-058 implemented the fork-side auto-detect bootstrap (the ceremony around the
already-existing `init_charm_bridge` detect-and-connect). Two design calls worth
recording, both shaped by the rule that daemon/CLI TS changes were out of scope.

## 1. Fork spawns `charmd` directly, minting its own session UUID

`CharmBridge::ensure_daemon_and_start` connects to a live session if one is
found; otherwise, if a `.charm/` dir is on an ancestor, it spawns the daemon
itself: `charmd --root <root> --uuid <uuid>`, detached, stdio -> `.charm/charmd-fork.log`.

- UUID is minted in Rust (`uuid::Uuid::new_v4`), not derived, so it is unique
  per bootstrap. `--session` is omitted (the daemon derives a default; tmux
  session names are irrelevant in the fork).
- Command resolution: `$CHARM_DAEMON_CMD` (whitespace-split) overrides, else the
  installed `charmd` on PATH. The override is needed in a source checkout, where
  the daemon runs as `bun run src/daemon/index.ts` (no `charmd` on PATH) -- mirrors
  cli.ts `resolveChild("daemon")`.
- We do NOT replicate `writeSessionMeta` (which would mean re-deriving the socket
  path via `resolveSocketPath` in Rust). Instead the bridge reads the socket from
  the daemon's own `charm.json` -- see [[daemon-writes-charm-json-not-meta-json-at-boot]].
  This keeps the socket path authoritative (daemon-computed) rather than
  re-derived and drift-prone.
- The child handle is dropped without waiting (daemon is long-lived; no
  parent-tracking, no setsid -- a GPUI app has no controlling TTY so no SIGHUP
  storm on Zed exit).

## 2. register_panes fires fork-side with Zed entity-id handles

The bootstrap fires `register_panes` (new client method in crates/charm) with the
agents-pane gpui entity id (stringified) as the agent pane handle, console handle
empty (the right-dock console is a gpui panel, not a terminal).

The daemon's `register_panes` is still tmux-shaped (`{console_pane_id,
agent_pane_ids}`, first agent pane = orchestrator). Firing it with Zed entity ids
is SAFE against today's daemon: `relayoutLocked()` early-returns when a handle
does not resolve to a tmux pane index (`tmux.paneIndex` returns null), so the
daemon records the handles but performs no tmux layout and kills no panes. It is
fired off the UI thread (RPC is blocking) and best-effort (a failure only logs).

This is forward-wiring in the same spirit as Phase 4's dormant spawn path: the
fork-side ceremony is complete and correct; teaching the daemon to DRIVE Zed
panes from these handles (and to relay spawn specs so orchestrator/leaf terminal
handles join the registration) is deferred daemon-source work (T-055 / the
daemon-restart batch). Related:
[[phase4-agent-command-not-on-status-wire]].

## Bootstrap step placement (for future readers)

- Step 1 (ensure daemon + connect): `crates/charm` `ensure_daemon_and_start`,
  called from `init_charm_bridge` in `crates/zed/src/main.rs`.
- Step 2 (open left explorer + right console on Orchestrate, no focus steal):
  `crates/zed/src/zed.rs` `initialize_workspace`, right after the charm panels are
  added, gated on `charm_ui::session_detected()`.
- Steps 3-4 (split agents pane + fire register_panes): `crates/zed/src/charm_terminal.rs`
  `CharmTerminalManager::install` (runs on the first workspace via observe_new).
- Step 5 (center stays on normal editing): achieved by using `open_panel`
  (activate + reveal) rather than `focus_panel` for the docks.
