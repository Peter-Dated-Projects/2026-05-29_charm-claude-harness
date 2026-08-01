# CHARM workspace

This is a charm workspace: agents here run a staged, human-gated multi-agent
pipeline on one shared git tree. Your role behavior is set by the prompt injected
at spawn (`.charm/prompts/*.md`) — that is authoritative. This file only adds the
workspace facts and guardrails every agent shares.

## Terminology

**"subagent" (equivalently "sub-agent") always means a _charm subagent_: a charm
agent spawned through charm's MCP spawn tools** — `spawn_investigators`,
`spawn_workers`, `spawn_researchers`, or `request_review`. There is no other kind.
The native Claude Code `Agent`/`Task` tools are removed from every agent's
schema (orchestrator included); `Workflow` is left enabled fleet-wide by
default (`CHARM_WORKFLOW_ENABLE=0` opts back out), but "subagent" still never
refers to a built-in-tool or Workflow-spawned agent. Whenever the word appears — in a prompt,
in a ticket, from the operator, or between agents — read it as this and only this,
and fan out only through the spawn tools.

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
- **`.charm/project-briefs/` is durable, operator-owned context.** Each
  `<slug>.md` is a per-project operational brief the operator authors and reuses
  across sessions (`charm start --project`); a project-anchored session gets its
  brief as standing context. Git-tracked like the KB — treat briefs as real work
  product, not scratch. Update a brief when the project's standing facts change;
  don't delete one to "clean up".
- **A brief's `## Links` is a curated index into durable surfaces, and only
  durable ones.** It points at material with a stable home — `kb/`, `proposals/`,
  `project-briefs/`, and committed source/docs — so an agent starts from the
  project's own map instead of rediscovering context cold. `.charm/scratchpad/` is
  the opposite: transient, un-indexed working space (drafts move out on promote;
  artifacts accrete against no stable-target contract), so never link it — nor
  `tickets/` or `run/` — from a durable doc or brief. If something in scratchpad is
  worth pointing at, promote a durable version into `kb/` or `proposals/` first,
  then link that.

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
| write / author a project brief for a project | `charm:charm-write-project-brief` — interview + repo scan, then write a new `.charm/project-briefs/<slug>.md` (the standing context `charm start --project` injects) |
| update / refresh the project brief after this session's work | `charm:charm-update-project-brief` — revise the current project's brief file in place (standing facts only; operator-owned, so surface what changed) |

## Repository authoring skills

Also in the plugin, but these act on the **repo's own structure and docs** rather
than on session state, and they work with or without a running charm session. Same
rule: invoke via the Skill tool and follow it, don't improvise.

| User asks to… | Invoke |
| --- | --- |
| initialize a repo / scaffold `docs/planning` / set up the project + TDD planning structure | `charm:charm-repository-structure-init` — runs `charm init`, then scaffolds the PLAN → PRJ-NNN → TDD-NNN tree; structure only, authors no content |
| bootstrap / refresh repository documentation / set up `AGENTS.md` and tool adapters | `charm:charm-repository-documentation-normalizer` |
| design / feasibility-check a feature before coding / draft a feature TDD | `charm:charm-feature-tdd` |
| review a design doc / RFC / ADR / tech spec | `charm:charm-tdd-design-review` — a written proposal, **not** test-driven development |
| create or extend a repo's `frieren.sh` entry point | `charm:charm-frieren-setup` |

These are operator-facing. A worker mid-ticket should not reach for one unless its
ticket says to — scaffolding a repo's docs is not part of implementing a feature.
