# CHARM workspace

This is a charm workspace: agents here run a staged, human-gated multi-agent
pipeline on one shared git tree. Your role behavior is set by the prompt injected
at spawn (`.charm/prompts/*.md`) — that is authoritative. This file only adds the
workspace facts and guardrails every agent shares.

## Guardrails

- **Respect your file scope.** By default all agents share one tree: each ticket
  declares `touches:`, the daemon serializes overlapping scopes, and agents
  coordinate through `.charm/COORDINATION.md`. Read it before editing, and stay
  inside your declared scope. Separately, the orchestrator may open worktrees
  under `~/.charm-worktrees/<repo>/<name>/` (a side tool) to run parallel or
  non-overlapping lines of work — each is a real `git worktree` on its own branch
  (its own working tree, sharing the main repo's object store). If your cwd is one
  of those, you're in an isolated working tree, not the shared tree: everything you
  edit (including this `.charm`) stays on that branch and is merged back
  deliberately, never touching the main checkout.
- **Never hand-edit or delete tickets.** `.charm/tickets/*.md` are canonical and
  `.charm/db.sqlite` is a rebuilt index over them — touching either by hand
  desyncs them. Ticket changes go through charm's MCP tools; to wipe the backlog,
  use the `charm-restart` skill.
- **Never clobber `.charm/kb/`.** It's the durable knowledge base the fleet
  accumulates — real work product. Only the `charm-reset-kb` skill replaces it,
  and only after explicit confirmation.

## Agent lifecycle (auto-reap)

Every sub-agent ends by reporting a terminal state with `report_status`. That
report is what drives teardown, and the daemon — not the orchestrator — owns it:

- **`done` / `failed` are auto-reaped.** A short grace after a sub-agent reports
  `done` or `failed`, the daemon tears its pane down on its own (grace tunable via
  `CHARM_AUTO_REAP_MS`; `0` disables). The orchestrator is still pinged so it can
  advance the workflow, but it does **not** need to `kill_agent` a finished agent —
  that's routine bookkeeping the daemon already does. `kill_agent` is reserved for
  deliberate intervention: stopping an agent that is stuck, looping, or working on
  the wrong thing.
- **`blocked` is never auto-reaped.** That agent's process is alive, waiting on the
  orchestrator's `continue_agent`.

Two consequences: a sub-agent must **always** end with a terminal `report_status`
(a pane that finishes silently lingers until the liveness sweep notices the dead
process); and the orchestrator reacts to finish pings but leaves teardown of
`done`/`failed` agents to the daemon.

## Operator skills

These ship in the `charm` Claude Code plugin. When the user asks for one of
these, invoke that skill via the Skill tool and follow it exactly — don't
improvise the operation.

| User asks to… | Invoke |
| --- | --- |
| restart charm / reset the tickets / clear the ticket log / wipe the backlog | `charm:charm-restart` — kills ticketed agents, wipes tickets + db index, resets `COORDINATION.md`; daemon, KB, and session stay up |
| reset / wipe the knowledge base / start the kb fresh | `charm:charm-reset-kb` — **destructive**; wipes `.charm/kb/` and restores the template scaffold; double-confirm first |
