# Troubleshooting

Recovery paths, from least to most drastic. Reach for the panic button last, not first.

## A single agent is stuck

Use the orchestrator's fleet-management tools rather than tearing the session down:

- The orchestrator can `kill_agent` a wedged sub-agent (it is marked `failed` and stays for
  reassignment) and re-spawn work on the ticket.
- A blocked agent waiting on a decision can be unblocked with `continue_agent` once you have
  resolved what it was waiting on.
- A ticket that is no longer wanted can be called off with `cancel_ticket` — this drops it
  from the board and tears down any agent on it. Do not use `cancel_ticket` to retry a stuck
  agent; that is what `kill_agent` is for.

See [MCP tools](../developing/mcp-tools.md) for the full semantics of each.

## The orchestrator pane died, or you restarted the daemon

Bring the main agent back on its prior context instead of starting cold:

```sh
charm resume              # relaunch the orchestrator on its saved conversation
charm resume --continue   # resume its most-recent conversation instead
```

## The plan is wrong but the session is healthy

Reset the backlog without losing the running infrastructure:

```sh
charm restart
```

This kills the ticketed agents, wipes the ticket files and the sqlite index, and resets
`COORDINATION.md`. The daemon, the knowledge base, and the session itself stay up, so you can
re-plan from scratch without paying the startup cost again.

## You want to stop one session cleanly

```sh
charm stop              # close graph viewers, kill the daemon, tear down the tmux session
charm stop --all        # do that for every charm session in this directory
```

When multiple sessions run in one directory, target one with `-s`, `-u`, or `-r` (see the
[CLI reference](cli.md)).

## The whole thing is wedged — the panic button

Kills every charm process on the machine while sparing your other (non-charm) `claude`
sessions:

```sh
./frieren.sh kill
./frieren.sh kill --dry-run   # show what it would kill without killing anything
```

It tears down charm tmux sessions, then SIGTERMs charm processes, waits, SIGKILLs survivors,
and re-scans until clean. Use `--dry-run` first if you want to confirm it is only targeting
charm processes.

## Things to check when a session won't start

- **`claude` and `tmux` on PATH** — charm launches `claude` processes and uses tmux as the
  pane substrate; both must resolve at runtime.
- **Co-located binaries** — `charm`, `charmd`, `charm-mcp`, `charm-console`, and `charm-graph`
  must all be on PATH together. `charm start` execs its siblings by name, and every `claude`
  resolves `charm-mcp` by name, so a partial install fails in confusing ways. `frieren.sh
  install` places them together; if you moved one by hand, that is the likely cause.
- **A stale `.charm/`** — if the template tooling drifted, `charm init` re-copies prompts,
  skills, `CLAUDE.md`, and `charm.json` additively. It never deletes your `kb/`,
  `COORDINATION.md`, or `settings.json`, so it is safe to re-run.

## Verifying the harness itself

If you suspect a regression in charm rather than in a specific run, the
[preflight](../developing/preflight.md) is a repeatable smoke test that exercises every
built-in feature — MCP tools, pipeline stages, coordination, and failure/recovery paths.
