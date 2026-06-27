---
id: phase4-agent-command-not-on-status-wire
root: gotchas
type: gotcha
status: current
summary: "Phase 4 cannot spawn a real agent terminal from today's data: the daemon `status` AgentRecord carries no command/env/cwd (the daemon spawns claude in tmux itself), so the terminal manager logs-and-skips until the daemon relays the spawn spec -- the same deferred daemon-source work as the inject_text push."
created: 2026-06-26
updated: 2026-06-26
---

The Phase 4 plan (and the architecture diagram) shows the bridge calling
`Project::create_terminal_task` with "the agent's command/env/cwd". That data
does not exist on the wire today.

What the daemon `status` poll returns for an agent (`src/schema.ts` Agent,
mirrored in `crates/charm` `AgentRecord`) is: `id, role, ticket_id,
worktree_name, pane_id, pid, state, started_at`. There is **no command, no
args, no env, no cwd**. The reason: in the current model the daemon spawns the
`claude` process itself (in a tmux pane via `spawn.ts`) and the bridge only
*observes* the resulting registry record through the 1500ms poll diff. The
spawn command/flags/role-prompt/mcp-config are assembled daemon-side and never
serialized to the bridge.

Consequence for Phase 4: `on_agent_spawned` fires with a record that has no
command, so there is nothing to pass to `create_terminal_task`. The fork's
intended end state -- daemon does NOT spawn claude in tmux, instead relays the
spawn spec to the bridge which runs `create_terminal_task` -- requires a
daemon-source change to push the command/env to the bridge. That is the **same
class of deferred work as the `inject_text` push** (bridge spec section 2.3): a
daemon -> bridge relay that does not exist yet.

How T-052 handled it (so the build/gate is honest, not faked):
- `AgentRecord` in `crates/charm` gained forward-compatible optional spawn
  fields (`command: Option<String>`, `args`, `env`, `cwd`), all `#[serde(default)]`
  so they deserialize cleanly as absent from today's daemon.
- `CharmTerminalManager::spawn_agent` (crates/zed/src/charm_terminal.rs) builds
  a `SpawnInTerminal` and spawns a real terminal **only when `command` is
  present**; otherwise it logs and skips. The spawn/attach/liveness/teardown
  path is complete and build-verified -- it is simply dormant until the daemon
  relays the command.

So: do not expect agent terminal tabs to appear at runtime yet. Wiring the
daemon to relay the spawn spec (populate `command`/`args`/`env`/`cwd` in
`status`, or add a spawn push analogous to inject) is the prerequisite, and it
also depends on the worktree/cwd plumbing that `worktree_name` needs (it is
always null today -- no MCP spawn path passes a cwd). Related:
[[charm-session-socket-path-is-in-meta-json-not-run-dir]].
