---
name: persistent-memory
description: Terminal harness that runs a goal as a visible fleet of real `claude` processes on one shared git tree, gated by human approvals; recently gained per-project briefs.
---

## What this project is

Charm turns one goal into a **visible fleet of real `claude` processes** working a shared
git tree in parallel, with a human approval gate between staged phases. Unlike Claude
Code's built-in subagent tool (which hides subagents inside the parent process), every
charm agent is a first-class `claude` in its own tmux pane you can watch, drop into, and
reason about independently. Boundary: the whole repo is the project.

## Architecture / layout

One repo compiling to co-located binaries via `bun build --compile` (they must sit
together on PATH — `charm start` execs its siblings; every `claude` resolves `charm-mcp`
by name):

- `charm` (CLI) — [src/cli.ts](src/cli.ts): `init`/`start`/`stop`/`attach`/`resume`/`status`/`approve`/`restart`/`reset-kb`.
- `charmd` (daemon) — [src/daemon/](src/daemon/): the brain. Ticket store (`.md` files + a derived `bun:sqlite` index), agent registry, dep/file-scope solver, `COORDINATION.md` writer, tmux layout. Per-session Unix socket, JSON-line RPC.
- `charm-mcp` — [src/mcp/server.ts](src/mcp/server.ts): thin stdio MCP shim spawned by **every** `claude` via `.charm/charm.json`; forwards tool calls to the daemon.
- `charm-console` — [src/console/](src/console/): Ink (React-for-terminal) TUI pinned left; fs-watched viewer for `COORDINATION.md`/tickets + the approval gates.
- `charm-graph` (graph viewer) and a Rust `charm-watch` ([rust/](rust/)).

State split by lifetime: the shared workspace under `.charm/` (`kb/`, `proposals/`,
`project-briefs/`, `scratchpad/`, `tickets/`, `prompts/`) vs per-session run state under
`.charm/run/<uuid>/` (socket, pidfile, meta, assembled system prompts). Agent system
prompts are assembled in `buildClaudeCommand` ([src/daemon/spawn.ts](src/daemon/spawn.ts))
and **replace** Claude Code's default prompt outright.

## Constraints and conventions

- **The four-stage pipeline is mandatory:** investigate → synthesize/plan (human gate) →
  develop → test (human gate). No worker fan-out before the worker-ticket plan is approved.
- **"subagent" always means a charm subagent** spawned via the MCP spawn tools; the native
  `Agent`/`Task` tools are stripped from every agent (`Workflow` is left enabled fleet-wide
  by default; a Workflow-spawned agent is never a "subagent" in the charm sense).
- **No emoji or wide Unicode** in any agent output — it breaks the Ink layout.
- **Tickets are run state**, never hand-edited; `.charm/db.sqlite` is a rebuilt index over
  them. `kb/`, `proposals/`, `project-briefs/` are durable, git-tracked surfaces (see
  `.charm/.gitignore`).
- **Stack:** Bun + TypeScript; tests are `bun:test` `*.test.ts` colocated with source.
- Charm plugin skills are canonical in [plugin/](plugin/); `frieren install` copies them to
  `~/.claude/skills/charm/`.

## Links

- [README.md](README.md) — overview and the "why".
- [docs/developing/architecture.md](docs/developing/architecture.md) — binaries + session wiring.
- [templates/prompts/orchestrator.md](templates/prompts/orchestrator.md) — orchestrator system prompt.
- [.charm/CHARM.md](.charm/CHARM.md) — workspace guardrails; [.charm/proposals/INDEX.md](.charm/proposals/INDEX.md) — proposals.

## Current objective

Just shipped **per-project briefs** end-to-end: `charm start --project` (Ink picker with
create/delete), brief injection into the orchestrator's system prompt (survives compaction
+ `charm resume`), and the `charm-write-project-brief` / `charm-update-project-brief`
plugin skills. Near-term: install + smoke-test the two new skills (`frieren install` +
fresh session); decide whether to add a `.charm/`-exists precondition gate to them; and
wire the orchestrator's post-merge brief-refresh loop.
