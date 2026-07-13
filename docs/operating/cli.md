# CLI reference

The `charm` binary (built from `src/cli.ts`) is the operator entry point. When running from
source instead of an installed binary, substitute `./charm.sh` for `charm` — it forwards to
the same code.

```
charm <command> [options]
```

Every command that targets a running session accepts the same three selectors for picking
*which* session, when more than one is running in the same directory:

| Selector | Meaning |
|---|---|
| `-r, --root <path>` | project root (defaults to the current working directory) |
| `-s, --session <name>` | tmux session name |
| `-u, --uuid <id>` | session UUID |

If only one charm session is running in the directory, you can omit all three.

## Commands

### `init`

Scaffold or refresh `.charm/` in the current directory. Re-copies the template tooling
(prompts, `CHARM.md`, `charm.json`). It is **additive / update-only and never
deletes**: your `kb/`, `COORDINATION.md`, and `settings.json` are preserved across an `init`.

```
charm init [-r <path>]
```

### `start`

Start the daemon, open the tmux layout, and spawn the main agent. Pass `--project` to
anchor the session on a project brief and run the staged pipeline; without it, opens a
plain Claude window.

```
charm start [options]
```

| Option | Effect |
|---|---|
| `-p, --project [slug]` | anchor to a project brief under `.charm/project-briefs/`; bare `--project` opens a picker, `--project <slug>` selects one directly |
| `-m, --model <model>` | override the model for the **whole** fleet (main agent + every sub-agent), replacing the per-type defaults. Accepts `sonnet-5`, `sonnet-5-1m`, `haiku-4.5`, `opus-4.7`, `opus-4.7-1m`, `opus-4.8`, `opus-4.8-1m`, `fable-5`, or a raw `claude-*` id |
| `--max-agents <n>` | max concurrent agent sessions **including** the orchestrator (so `n=10` allows the orchestrator plus 9 sub-agents). Default `10` |
| `--no-attach` | do not auto-attach to the tmux session |
| `-s, --session <name>` | name the tmux session (default: derived from the project dir) |

See [Models](models.md) for the per-type model each agent runs on and the override precedence.

### `resume`

Relaunch the orchestrator pane on its saved conversation (`claude --resume`).

```
charm resume [session] [--continue]
```

`--continue` resumes the orchestrator's most-recent conversation instead of its saved session
id. Use this after a daemon restart or a crashed orchestrator pane — it brings the main agent
back on its prior context rather than starting cold.

### `status`

Print the current agents, tickets, and pending approvals for a session.

```
charm status
```

### `approve`

Resolve a pending approval gate from the command line (the same thing you would otherwise do
in the Console pane).

```
charm approve <gate_id> [--reject]
```

`--reject` rejects instead of approving.

### `attach`

Attach to a charm's tmux session.

```
charm attach
```

### `stop`

Stop a charm: close its graph viewers, kill its daemon, and tear down its tmux session.

```
charm stop [--all]
```

`--all` stops every charm session in the current directory.

### `restart`

Reset the ticket backlog without tearing down the session: kill ticketed agents, wipe the
ticket files and the sqlite index, and reset `COORDINATION.md`. The daemon, the knowledge
base, and the session itself stay up. Use this to re-plan from scratch without losing the
running infrastructure.

```
charm restart
```

### `reset-kb`

**Destructive.** Wipe `.charm/kb/` and restore the pristine template scaffold. This erases the
durable, cross-session knowledge base — only run it when you genuinely want to start that
memory over.

```
charm reset-kb [-r <path>]
```

## Internal commands

These exist for charm's own plumbing and are not part of the normal operator workflow:

- `ctl <cmd>` — handles a vim-style command (`:q`, `:a`, `:so`) sent from a
  tmux key binding. You trigger these through the keybindings, not by typing `ctl`.
- `session-name` — prints a session's tmux name for a root; used by `charm.sh`.
