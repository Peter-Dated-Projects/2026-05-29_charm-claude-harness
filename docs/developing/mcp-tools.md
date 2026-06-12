# MCP tools

`charm-mcp` (`src/mcp/server.ts`) is a thin stdio MCP server spawned by every `claude`
process via `.charm/charm.json`. It exposes the charm tool surface and forwards each call to
the daemon over the per-session Unix socket. The daemon — not the prompt — enforces the hard
constraints (caller role, dep/scope conflicts, the agent cap), so a tool used by the wrong
caller is rejected server-side rather than just discouraged.

Each agent's own id is injected automatically as `caller_id` / `agent_id`; tools that act "on
yourself" never take an explicit agent id.

## Caller roles

- **orchestrator** — the single main agent. Owns ticket authoring and all fan-out.
- **worker** — an interactive sub-agent spawned on one ticket.
- **any** — callable by any agent.

The fan-out and ticket-authoring tools are orchestrator-only by daemon enforcement: a
sub-agent calling them is rejected.

## Ticket authoring and the backlog

| Tool | Caller | Effect |
|---|---|---|
| `create_tickets` | orchestrator | Create one to three tickets per call (each: `title`, `body`, `depends_on`, `touches` file globs). To create more than three, make multiple calls. |
| `promote` | orchestrator | Promote hand-authored ticket drafts from `.charm/scratchpad/<name>.md` into real, spawnable tickets. Pass `tickets` (draft names) to promote specific drafts, or omit to promote all. |
| `set_ticket_state` | orchestrator | Write any ticket's lifecycle directly, addressed by `ticket_id`: set `status` and/or `stage`. Use it to schedule the backlog (flip a `generated` ticket to `ready`), walk a stage forward, or mark a ticket. A terminal status reaps the ticket's agent. |
| `set_ticket_status` | worker | Drive your **own** ticket's lifecycle (`running` while you work, `complete`/`failed` when terminal) and/or its `stage`. Always self-scoped — never another agent's ticket. `cancelled` is not settable here. |

## Fan-out

| Tool | Caller | Effect |
|---|---|---|
| `spawn_review_agents` | orchestrator | Spawn one interactive reviewer agent per ticket id (resumable; a blocked reviewer waits in its pane for `continue_agent`). |
| `spawn_workers` | orchestrator | Spawn interactive worker agents. The daemon enforces dep + file-scope conflicts; conflicting tickets come back as `deferred` (retry on a later tick). Tickets marked `blocked_by_cancelled_dependency` can never run — re-plan rather than retry them. |
| `request_review` | worker | Spawn a tester agent on a finished ticket. |

## Approvals and coordination

| Tool | Caller | Effect |
|---|---|---|
| `await_approval` | orchestrator | Block until a human approves or rejects this gate (stage 0, 2, or 4) in the Console pane. |
| `update_plan` | worker | Record your current plan before editing files. The daemon appends it to your ticket's activity log (`.charm/tickets/<id>.md`), **not** to `COORDINATION.md`. |
| `read_coordination` | any | Return the live coordination board (the rendered `COORDINATION.md`): one row per ticket not yet in a terminal state. |
| `list_tickets` | any | Query the sqlite ticket index. Returns id, title, status, and stage; takes an optional status filter. |

## Fleet state and self-reporting

| Tool | Caller | Effect |
|---|---|---|
| `report_status` | any | Report **this** agent's state (`blocked`, `done`, or `failed`) with an optional note. `running`/`spawning` are daemon-managed and not self-reportable. |
| `list_agents` | any | List every live sub-agent (id, role, state, ticket_id). The orchestrator is not listed and cannot be killed. Call this before `kill_agent` to get valid ids. |
| `set_session_description` | orchestrator | Set or update a one-sentence (<= 80 char) human-readable description of the session, shown in the session picker. |

## Managing the fleet

| Tool | Caller | Effect |
|---|---|---|
| `kill_agent` | orchestrator (or self) | Terminate an agent: kill its tmux pane and drop it from the registry. A self-kill marks the ticket `failed`; the orchestrator/operator killing another marks it `cancelled`. The orchestrator can never be killed by anyone. |
| `continue_agent` | orchestrator | Resume a blocked sub-agent by sending it a `message` (your guidance / the unblock info) and flipping it back to running — instead of killing and respawning. |
| `cancel_ticket` | orchestrator | Call off a ticket that is no longer wanted: marks it `cancelled`, drops it from the coordination board, and tears down any agent on it. Not a retry mechanism — use `kill_agent` for that. |

## Proposals

A lightweight design-doc surface under `.charm/proposals/`, separate from the ticket backlog:

| Tool | Caller | Effect |
|---|---|---|
| `create_proposal` | any | Scaffold a new design-proposal / feature-request doc (`PROP-*.md`) in `.charm/proposals/`. |
| `list_proposals` | any | List the proposals in `.charm/proposals/`, each with its metadata. |
| `finish_proposal` | any | Mark a proposal finished by moving it into `.charm/proposals/finished/`. |

## Viewers

| Tool | Caller | Effect |
|---|---|---|
| `open_graph` | any | Open the standalone animated force-directed graph viewer (`charm-graph`) in its own window. |

## Where the rules live

The authoritative contract for each tool's inputs and the daemon-side checks is `src/schema.ts`
(zod schemas for RPC envelopes, tool I/O, and frontmatter) and `src/mcp/server.ts` (the tool
registrations). When this table and the code disagree, the code wins — these descriptions are
derived from it, not the other way around.
