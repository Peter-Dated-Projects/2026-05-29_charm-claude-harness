---
name: restart
description: Cleanly restart a running charm session — stop the daemon, tmux session, and graph viewers, verify everything is down, then start again on the SAME .charm/ workspace state. Use when the user asks to restart charm, bounce the session, or pick up code changes to the daemon/MCP/console.
---

# Restart charm

Charm has no native `restart` command — only `stop` and `start`. This skill is the procedure that chains them safely, because two facts make a naive stop/start lossy:

1. **The goal and the mode are NOT persisted.** The mode (`research`/`development`) rides in as the `CHARM_MODE` env var when the daemon launches; the goal only ever becomes the main agent's opening prompt. Neither is written to disk. If you don't re-supply them, the restarted session loses both.
2. **The workflow state IS persisted** — `.charm/` holds `db.sqlite` (ticket index), `tickets/`, `COORDINATION.md`, `kb/`, and `meta.json`. `charm start` reuses an existing `.charm/` (it scaffolds with `force: false`), so restarting on the same root continues the same workflow rather than starting over.

So a correct restart = stop cleanly → re-supply goal + mode → start on the same root.

## When to use

- "restart charm" / "bounce the charm session" / "restart the daemon"
- After editing daemon / MCP / console source and wanting the running session to pick it up
- The tmux session or daemon is wedged and needs a clean cycle

## Before stopping: capture goal + mode

These can't be recovered after stop, so get them first.

- **Goal** — ask the user for the original goal string (or, if continuing in-flight work, whether they want to resume with the same goal or open a plain window and let the main agent read existing `.charm/` state).
- **Mode** — ask whether to restart in `--research` (Sonnet fleet) or `--development` (Opus fleet). If they don't know/care, pass the flag explicitly anyway so the start doesn't drop into an interactive prompt (which hangs under `--no-attach`).

If the user only said "restart" with no detail, ask both with `AskUserQuestion` rather than guessing.

## Steps

Run from the repo root (the dir holding `charm.sh`). Substitute `--root` if the charm workspace is elsewhere.

1. **Stop the running session.**
   ```bash
   ./charm.sh stop
   ```
   This closes graph viewers by tracked PID, kills the daemon via its pidfile, and tears down the tmux session — in that order, so viewers are reaped even if the daemon is already gone.

2. **Verify it's actually down, and force-clean stale artifacts.** `stop` best-effort-kills; a wedged process can survive and leave a stale socket/pidfile that makes the next `start` think a daemon is already up.
   ```bash
   # Should print nothing / "no server" — tmux session gone
   tmux has-session -t charm 2>/dev/null && echo "STILL UP" || echo "tmux down"
   # Stale runtime artifacts in .charm/ (socket, daemon pidfile, viewer pids)
   ls -la .charm/sock .charm/charmd.pid .charm/graph-viewers.pids 2>/dev/null || echo "clean"
   ```
   If the daemon pidfile still exists and names a live PID, kill it, then remove the stale files:
   ```bash
   [ -f .charm/charmd.pid ] && kill "$(cat .charm/charmd.pid)" 2>/dev/null || true
   rm -f .charm/sock .charm/charmd.pid .charm/graph-viewers.pids
   ```
   Do NOT touch `db.sqlite`, `tickets/`, `COORDINATION.md`, `kb/`, or `meta.json` — those are the workflow state you're preserving.

3. **(Only if running installed binaries) rebuild first.** `charm.sh`/`frieren.sh` run the TS sources via `bun`, so a source-mode restart picks up code changes automatically — no build needed. But if charm was installed onto PATH (`frieren.sh install`), the running binaries are stale; rebuild and reinstall before starting:
   ```bash
   ./frieren.sh install
   ```

4. **Start again on the same root, re-supplying goal + mode.**
   ```bash
   ./charm.sh start --development "the original goal string"
   # or, to resume without re-driving the main agent through Stage 0:
   ./charm.sh start --development        # plain window; main agent reads existing .charm/ state
   ```
   Because `.charm/` is preserved, the daemon comes back up with the existing ticket store and coordination file intact.

## Caveats to flag

- **Discovery may re-run.** Starting *with* a goal re-prompts the main agent to "Begin Stage 0 (Discovery)". If the workflow was already past discovery, prefer the plain-window form (`start` with no goal) so the agent picks up where `.charm/` left off instead of redoing Stage 0.
- **Session name.** All commands assume the default tmux session `charm`. If the session was started with `--session NAME`, pass the same `--session NAME` to `stop` and `start`, and check `tmux has-session -t NAME`.
- **Want a clean slate, not a resume?** That's not a restart — it's a fresh run. Stop, remove the whole `.charm/` directory (or `./frieren.sh clean` for build artifacts only — it does NOT touch `.charm/`), then `./charm.sh init` + `start`.
