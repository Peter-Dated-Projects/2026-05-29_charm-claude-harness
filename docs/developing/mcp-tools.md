# MCP tools

`charm-mcp` (`src/mcp/server.ts`) is a thin stdio MCP server spawned by every `claude`
process via `.charm/charm.json`. It exposes the charm tool surface and forwards each call to
the daemon over the per-session Unix socket. The daemon — not the prompt — enforces the hard
constraints (caller role, dep/scope conflicts, the agent cap), so a tool used by the wrong
caller is rejected server-side rather than just discouraged.

Each agent's own id is injected automatically as `caller_id` / `agent_id`; tools that act "on
yourself" never take an explicit agent id. The parameter tables below list only what the agent
itself passes — the injected id is omitted.

## Caller roles

- **orchestrator** — the single main agent. Owns ticket authoring and all fan-out. (A human
  operator driving the Console/CLI counts as orchestrator-equivalent for caller gating: an
  absent `caller_id` is treated as the operator.)
- **worker** — an interactive sub-agent spawned on one implementation ticket.
- **any** — callable by any agent.

The fan-out, ticket-authoring, and worktree tools are orchestrator-only by daemon enforcement:
a sub-agent calling them is rejected.

## A note on stages and statuses

Two enums recur across the lifecycle tools:

- **status** — where a ticket sits in its lifecycle: `pending`, `ready`, `running`, `blocked`,
  `complete`, `failed`, `cancelled`. `cancelled` is never settable through a status write —
  it flows only from `cancel_ticket` / a kill.
- **stage** — how far the work has progressed: `generated`, `investigating`, `approved`,
  `in_progress`, `testing`, `done`, `failed`.

The tool tables note which subset each tool accepts.

---

## Ticket authoring and the backlog

### `create_tickets`

**Caller:** orchestrator. **Effect:** create one to three tickets in `.charm/tickets/` and the
sqlite index. To create more than three, make multiple calls (the cap keeps a single call from
ballooning).

| Param | Type | Required | Notes |
|---|---|---|---|
| `tickets` | array (1–3) | yes | Each element is a ticket object (below). |
| `tickets[].title` | string | yes | One-line ticket title. |
| `tickets[].body` | string | yes | Full ticket body (markdown). |
| `tickets[].type` | `"investigation"` \| `"implementation"` | no (default `implementation`) | `investigation` = a Phase-A context-gathering ticket worked by an investigator; `implementation` = a Phase-B build ticket worked by a worker. |
| `tickets[].depends_on` | string[] | no (default `[]`) | Ticket ids this one depends on. |
| `tickets[].touches` | string[] | no (default `[]`) | File globs this ticket will edit — the daemon uses these to serialize scope conflicts. |

### `promote`

**Caller:** orchestrator. **Effect:** promote hand-authored ticket drafts from
`.charm/scratchpad/<name>.md` into real, spawnable tickets — the daemon moves each draft into
`.charm/tickets/` and indexes it in sqlite (the move + index is why this must be an MCP call,
not a raw file move: it keeps the board and db in sync). The draft's own id (or filename) is
preserved, so cross-draft `depends_on` references survive.

| Param | Type | Required | Notes |
|---|---|---|---|
| `tickets` | string[] | no | Draft names (with or without `.md`) to promote. Omit to promote every draft in the scratchpad. |

### `set_ticket_state`

**Caller:** orchestrator. **Effect:** write any ticket's lifecycle directly, addressed by
`ticket_id` (unlike `set_ticket_status`, which only drives a worker's own ticket). Use it to
schedule the backlog (flip a `generated` ticket to `ready`), walk a stage forward, or mark a
ticket `complete`/`failed` out of band. Writing a terminal status (`complete`/`failed`) tears
down any sub-agent still on the ticket. At least one of `status`/`stage` must be present.

| Param | Type | Required | Notes |
|---|---|---|---|
| `ticket_id` | string | yes | The ticket to write. |
| `status` | `pending` \| `ready` \| `running` \| `blocked` \| `complete` \| `failed` | no | `cancelled` is not settable here — use `cancel_ticket`. |
| `stage` | `generated` \| `investigating` \| `approved` \| `in_progress` \| `testing` \| `done` \| `failed` | no | |
| `note` | string | no | Recorded in the ticket's activity log. |

### `set_ticket_status`

**Caller:** worker. **Effect:** drive your **own** ticket's lifecycle (`running` while you
work, `complete`/`failed` when terminal, `blocked` while waiting) and/or its `stage`. Always
self-scoped — never another agent's ticket. At least one of `status`/`stage` must be present.

| Param | Type | Required | Notes |
|---|---|---|---|
| `status` | `pending` \| `ready` \| `running` \| `blocked` \| `complete` \| `failed` | no | `cancelled` is not settable here. |
| `stage` | `generated` \| `investigating` \| `approved` \| `in_progress` \| `testing` \| `done` \| `failed` | no | |
| `note` | string | no | Recorded in the ticket's activity log. |

---

## Fan-out

Each spawn tool runs its agent on a model chosen by the work type: coding (`spawn_workers`) =
Opus 4.8 / 1M ctx, investigation (`spawn_investigators`) = Opus 4.8, review (`request_review`)
= Sonnet 4.6, research (`spawn_researchers`) = Sonnet 4.6 / 1M ctx. Override per role with the
`CHARM_MODEL_<ROLE>` env var, or the whole fleet with `charm start -m`. See
[Models](../operating/models.md).

### `spawn_investigators`

**Caller:** orchestrator. **Effect:** spawn one interactive investigator agent per
investigation-ticket id. An investigator gathers context, identifies the real problem, proposes
a fix (or several options), and writes its findings into the ticket body. Investigators are
read-only on code and resumable: a blocked investigator waits in its pane for `continue_agent`.

| Param | Type | Required | Notes |
|---|---|---|---|
| `ticket_ids` | string[] | yes | One investigation ticket per agent. |
| `worktree` | string | no | Plain name of an already-open worktree (from `create_worktree`) to run the agents in. Omit for the default shared tree. |

### `spawn_workers`

**Caller:** orchestrator. **Effect:** spawn interactive worker agents on implementation
tickets. The daemon enforces dep + file-scope conflicts; conflicting tickets come back as
`deferred` (retry on a later tick). Tickets in `blocked_by_cancelled_dependency` depend on a
cancelled ticket and can **never** run — re-plan (drop the dependency, re-scope, or cancel
them) rather than retry.

| Param | Type | Required | Notes |
|---|---|---|---|
| `ticket_ids` | string[] | yes | One implementation ticket per agent. |
| `worktree` | string | no | Plain name of an already-open worktree (from `create_worktree`) to run every worker in this batch in. Omit for the default shared tree. |

### `spawn_researchers`

**Caller:** orchestrator. **Effect:** spawn one interactive researcher agent per free-text
prompt — an ad-hoc, ticket-less context-gathering agent. It reads broadly (code, in-repo docs,
the KB, the web), writes its findings to a scratchpad file, and reports back the path. Not
gated by the pipeline; usable in any stage. Resumable like investigators.

| Param | Type | Required | Notes |
|---|---|---|---|
| `prompts` | string[] (min 1, each non-empty) | yes | One research question per agent. |
| `worktree` | string | no | Plain name of an already-open worktree (from `create_worktree`) to run every researcher in this batch in. Omit for the default shared tree. |

### `request_review`

**Caller:** worker. **Effect:** spawn a tester agent on a finished ticket.

| Param | Type | Required | Notes |
|---|---|---|---|
| `ticket_id` | string | yes | The finished ticket to review. |
| `worktree` | string | no | Plain name of an already-open worktree to run the tester in — a tester validating a worker that ran in a worktree needs the same checkout to see its commit. Omit for the default shared tree. |

---

## Approvals and coordination

### `await_approval`

**Caller:** orchestrator. **Effect:** block until a human approves or rejects this gate in the
Console pane. No timeout — it waits until a human resolves the gate (which can legitimately take
minutes).

| Param | Type | Required | Notes |
|---|---|---|---|
| `stage` | `2` \| `4` | yes | Stage 2 = the worker-ticket plan; stage 4 = the merge diff. (There is no stage-0/discovery gate.) |
| `label` | string | yes | Human-readable label shown on the gate. |
| `ticket_id` | string \| null | no (default `null`) | The ticket this gate is about, if any. |
| `payload_path` | string \| null | no (default `null`) | Path to the artifact under review (e.g. a diff), if any. |

### `update_plan`

**Caller:** worker. **Effect:** record your current plan before editing files. The daemon
appends it to your ticket's activity log (`.charm/tickets/<id>.md`), **not** to
`COORDINATION.md`.

| Param | Type | Required | Notes |
|---|---|---|---|
| `plan` | string | yes | Your plan for the ticket. |

### `read_coordination`

**Caller:** any. **Effect:** return the live coordination board (the rendered
`COORDINATION.md`): one row per ticket not yet in a terminal state — open, in-flight, or failed
— with its stage, status, and the sub-agent on it (or `-` if unassigned). Completed tickets
drop off. For a structured, filterable query use `list_tickets`; for a ticket's full history
read `.charm/tickets/<id>.md`. No parameters.

### `list_tickets`

**Caller:** any. **Effect:** query the sqlite ticket index. Returns id, title, status, stage,
`depends_on`, and `touches` per ticket.

| Param | Type | Required | Notes |
|---|---|---|---|
| `statuses` | array of (`pending` \| `ready` \| `running` \| `blocked` \| `complete` \| `failed` \| `cancelled`) | no | Filter (e.g. `["ready"]` for the runnable backlog, `["failed"]` for tickets needing attention). Omit for every ticket. |

---

## Fleet state and self-reporting

### `report_status`

**Caller:** any. **Effect:** report **this** agent's state and an optional note. Every
sub-agent must end with a terminal `report_status` (`done`/`failed`) — that report drives
teardown. `running`/`spawning` are daemon-managed and not self-reportable.

| Param | Type | Required | Notes |
|---|---|---|---|
| `state` | `blocked` \| `done` \| `failed` | yes | |
| `note` | string | no | |

### `list_agents`

**Caller:** any. **Effect:** list every live sub-agent the daemon is tracking (id, role, state,
`ticket_id`). The orchestrator (main agent) is not listed and cannot be killed. Call this
before `kill_agent`/`continue_agent` to get valid ids. No parameters.

### `set_session_description`

**Caller:** orchestrator. **Effect:** set or update a one-sentence human-readable description
of this session, shown by `charm list`. Call once early (once the feature request and scope are
clear) and again on a material reframing (e.g. scope pivot).

| Param | Type | Required | Notes |
|---|---|---|---|
| `description` | string (1–80 chars) | yes | The 80-char cap is enforced server-side so a chatty agent can't blow up the listing layout. |

---

## Managing the fleet

> **Finished agents are reaped automatically.** When a sub-agent reports `done` or `failed`, the
> daemon tears its pane down on its own after a short grace (default 5s; set `CHARM_AUTO_REAP_MS`,
> `0` disables). The orchestrator is still pinged so it can advance the workflow, but it does
> **not** need to `kill_agent` finished agents — that tool is for deliberate intervention
> (killing a stuck/looping/wrong agent), not routine cleanup. `blocked` agents are never
> auto-reaped (they're alive, waiting on `continue_agent`).

### `kill_agent`

**Caller:** orchestrator (any sub-agent) or a sub-agent killing **itself**. **Effect:**
terminate an agent — kill its tmux pane and drop it from the registry. If it was mid-ticket, a
**self-kill** marks the ticket `failed` (it couldn't finish); the **orchestrator/operator**
killing another agent marks it `cancelled` (a deliberate call-off). The orchestrator can never
be killed by anyone.

| Param | Type | Required | Notes |
|---|---|---|---|
| `agent_id` | string \| null | no (default `null`) | The agent to kill. `null`/omitted = kill myself (only meaningful for a sub-agent caller). A sub-agent may only target itself; the orchestrator may target any sub-agent. |

### `continue_agent`

**Caller:** orchestrator. **Effect:** resume a blocked sub-agent — send `message` (your guidance
/ the unblock info) into the agent's pane to wake it and flip it back to running, instead of
killing and respawning. The target must be a live sub-agent currently in the `blocked` state
(read its ticket file for the blocked note first). To abandon a stuck agent instead, use
`kill_agent`.

| Param | Type | Required | Notes |
|---|---|---|---|
| `agent_id` | string | yes | The blocked sub-agent to resume. |
| `message` | string (non-empty) | yes | Sent into the agent's pane. |

### `cancel_ticket`

**Caller:** orchestrator. **Effect:** call off a ticket that is no longer wanted — marks it
`cancelled`, drops it from the coordination board, and tears down any agent working it. This is
**not** how you retry a stuck agent (for that, `kill_agent` marks the ticket `failed` so it
stays on the board for reassignment). Use `cancel_ticket` only when the work itself should stop
(descoped, superseded, no longer needed).

| Param | Type | Required | Notes |
|---|---|---|---|
| `ticket_id` | string | yes | The ticket to call off. |
| `note` | string | no | Recorded in the ticket's activity log. |

---

## Proposals

A lightweight design-doc surface under `.charm/proposals/`, separate from the ticket backlog. A
proposal describes WHAT to build and its impact; it does not dictate the ticket breakdown — you
decide that later when you decompose it.

### `create_proposal`

**Caller:** any. **Effect:** scaffold a new design-proposal / feature-request doc in
`.charm/proposals/`. The daemon auto-derives the canonical `PROP-<slug>.md` filename, writes a
draft template (Problem / Context / Proposal / Alternatives / Open Questions), and returns the
file path. Errors if a proposal with that slug already exists (never clobbers).

| Param | Type | Required | Notes |
|---|---|---|---|
| `name` | string (non-empty) | yes | Free-text title; the slug is derived from it. |

### `list_proposals`

**Caller:** any. **Effect:** list the proposals in `.charm/proposals/` (`PROP-*.md`), each with
its title and self-declared status, including ones already moved to `proposals/finished/`. No
parameters.

### `finish_proposal`

**Caller:** any. **Effect:** mark a proposal finished by moving `.charm/proposals/<name>.md`
into `proposals/finished/`, keeping the active listing clean once a feature request has been
fully decomposed into tickets (or superseded).

| Param | Type | Required | Notes |
|---|---|---|---|
| `name` | string (non-empty) | yes | The proposal filename, with or without `.md`. |

---

## Worktrees

Worktrees let the orchestrator run parallel, non-overlapping lines of work in isolated
**`git worktree` checkouts** under `~/.charm-worktrees/<repo>/<name>/`. Each is a real
`git worktree` (`git worktree add`) — its own working tree, index, and branch, sharing the main
repo's object store via a `.git` pointer file, not a separate clone with its own `origin`. An
agent spawned into one sees only that working tree (including its own `.charm` and KB), so
nothing it does races with or touches the main checkout. Because the branch lives in the same
repo, work is merged back deliberately with a plain branch merge. All three tools are
orchestrator-only — the daemon rejects calls from investigators and workers.

Use worktrees when two tickets touch the same files (scope conflict), when you want to stack
Graphite PRs in parallel, or when a line of work must be sealed off from the main checkout
entirely. The default shared-tree model is simpler and covers most cases; reach for a worktree
only when full isolation or separate branches are genuinely needed. See
[Worktrees](../operating/worktrees.md).

**Spawning agents into a worktree.** Once a worktree is open, pass its name as the optional
`worktree` arg to `spawn_workers`, `spawn_investigators`, `spawn_researchers`, or
`request_review` to run those agents in it (cwd = the worktree checkout). The control-plane
surfaces an agent needs still resolve to the **main repo**, not the worktree copy, because the
worktree only checks out tracked files and `.charm/`'s control-plane state (`tickets/`,
`COORDINATION.md`, `CHARM.md`, `db.sqlite`) is gitignored and therefore absent in it:

- The spawn prompt points the agent at the ticket via an **absolute** main-repo path
  (`<root>/.charm/tickets/<id>.md`), not a relative one, so it reads the canonical ticket.
- Every ticket mutation already goes through the daemon (`update_plan`, `set_ticket_status`,
  `report_status`, `read_coordination`), which operates on the main-repo store regardless of cwd.
- The shared `.charm/CHARM.md` guardrails — normally reached via the root `CLAUDE.md`
  `@`-import, which only fires when cwd is the repo root — are injected directly into a worktree
  agent's system prompt instead, since that import goes dark in a worktree checkout.

### `create_worktree`

**Caller:** orchestrator. **Effect:** run `git worktree add` to create an isolated worktree
under `~/.charm-worktrees/<repo>/<name>/`. By default it cuts a fresh `charm/<name>` branch off
`base` (default HEAD); pass `branch` to check out an existing branch instead (the Graphite-stack
case). The new tree has the committed state (including tracked `.charm/kb`, `proposals`,
`scratchpad`) but not gitignored run state; gitignored `.env` files are symlinked back. **Every
opened worktree must be closed before session end.**

| Param | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Plain segment (no path separators); guarded daemon-side before being joined into a path. |
| `branch` | string | no | Existing branch to check out. Omit to cut a fresh `charm/<name>` branch. |
| `base` | string | no (default HEAD) | The ref the fresh `charm/<name>` branch is cut from. Ignored when `branch` is given. |

### `list_worktrees`

**Caller:** orchestrator. **Effect:** list the open worktrees in this repo, each with its path,
branch, and the live agent (if any) occupying it. Use it to see which lines of work are in
flight vs. closeable. No parameters.

### `close_worktree`

**Caller:** orchestrator. **Effect:** run `git worktree remove` to delete a worktree by `name`,
removing its working tree. Commits on its `charm/<name>` branch stay reachable in the repo (charm
does no merge-back — merge the branch first to land the work) unless you pass `delete_branch`.

| Param | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | The worktree to close. |
| `delete_branch` | boolean | no | Also `git branch -D charm/<name>` in the main repo (best-effort), orphaning its commits to eventual GC. Do this only once the work is merged back. |

---

## Viewers

### `open_graph`

**Caller:** any. **Effect:** open the charm graph viewer — a standalone, animated force-directed
view of the project graph (Obsidian-style nodes and edges) in a brand-new terminal window,
separate from the charm tmux session. Each call opens an independent window; closing it
(`q`/`Esc`) or `charm stop` shuts it down. Call this when the user asks to see, open, or
visualize the graph / map / dependency view. No parameters.

---

## Where the rules live

The authoritative contract for each tool's inputs and the daemon-side checks is `src/schema.ts`
(zod schemas for RPC envelopes, tool I/O, and frontmatter) and `src/mcp/server.ts` (the tool
registrations). The parameter tables above describe the **MCP surface** — exactly what an agent
passes — which is the `inputSchema` in `src/mcp/server.ts`. The daemon-side schema may carry a
few fields the shim injects automatically (e.g. `caller_id` / `agent_id`), which is why those
don't appear in the tables. When this page and the code disagree, the code wins — these
descriptions are derived from it, not the other way around.
