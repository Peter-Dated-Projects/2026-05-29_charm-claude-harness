# Running a session

Every charm session runs the same fixed, gated pipeline. The main ("orchestrator") agent
drives it in a single interactive session, joining two decoupled phases: investigators
gather context and propose fixes, then the orchestrator synthesizes their findings into a
worker-ticket plan that gets built. Worker fan-out only happens after the findings are
synthesized and the plan is approved. This is the hard rule baked into the orchestrator
prompt — no workers spawn before you have approved the plan.

## The four-stage pipeline

| Stage | Who runs it | Mode | Gate before advancing |
|---|---|---|---|
| 1 — Investigation | main agent opens investigation tickets + N investigator agents | interactive | none -> investigators close their own tickets |
| 2 — Planning / synthesis | main agent reads findings, authors worker tickets | interactive | you approve the worker-ticket plan |
| 3 — Development | M worker agents | interactive, coordinated | none -> each ticket advances on its own |
| 4 — Test and review | tester agents, one per ticket | interactive | you approve the diff before merge |

A ticket's `type` decides who works it: `investigation` tickets go to investigators,
`implementation` tickets to workers.

Gates are **blocking**: the daemon halts the pipeline until you approve, either in the
console's Approvals tab or with `charm approve <gate_id>` from another terminal. The gated
stages are 2 and 4.

### Stage 1 — Investigation

The main agent turns your request into one or more investigation tickets and fans out
investigator agents on them. Investigators are read-only on code: they gather context, find
the real problem, and propose a fix (sometimes a few options with tradeoffs), writing their
findings into the ticket body before closing. When an investigator hits a decision it can't
make, it surfaces a question and the orchestrator answers — from its own knowledge or by
asking you. This stage has no human gate; it ends when the findings are in.

### Stage 2 — Planning / synthesis

The main agent reads every investigation finding, then authors fresh worker (implementation)
tickets from what was learned — there's no fixed 1:1 mapping; N investigations inform M
worker tickets. Each worker ticket is a markdown file in `.charm/tickets/` with frontmatter
declaring its `depends_on` and `touches` (file globs). The agent lays the tickets out in
dependency waves, renders the plan (`charm tree`), and gates. You approve the worker-ticket
plan. This is your last checkpoint before parallel work starts, so it is worth reading: the
`touches` globs are what the daemon uses to keep workers out of each other's way.

### Stage 3 — Development

Worker agents fan out, each a real `claude` process in its own tmux pane. Two layers keep
them safe on the single shared tree:

- **Hard layer** — the daemon refuses to run two workers whose `touches` scopes overlap;
  overlapping tickets are serialized automatically. Dependencies (`depends_on`) are honored
  the same way.
- **Soft layer** — every worker reads and writes `.charm/COORDINATION.md` so it knows what
  other in-flight agents are doing, and why, before it touches anything.

Each ticket advances on its own as its worker finishes — there is no single gate for the
whole stage.

### Stage 4 — Test and review

A tester agent runs per finished ticket and checks the diff. You approve the diff before it
merges. This is the final human gate.

## Concurrency

A concurrent-agent cap bounds how many `claude` processes run at once, set by `--max-agents`
(default 10) and **counting the orchestrator** — so the default leaves room for the
orchestrator plus 9 sub-agents. When the daemon can't spawn a requested agent because the cap
is reached, or because of a dep/scope conflict, the ticket is deferred and retried on a later
tick rather than failing.

## Ticket lifecycle

Tickets carry two orthogonal fields in their frontmatter:

- **stage**: `generated` -> `investigating` -> `approved` -> `in_progress` -> `testing` ->
  `done` (or `failed`). This tracks where the ticket is in the pipeline.
- **status**: `pending`, `ready`, `running`, `blocked`, `complete`, `failed`, `cancelled`.
  This tracks the ticket's current run state.

`COORDINATION.md` shows every ticket except the two terminal states (`complete`, `cancelled`)
— one row per still-relevant ticket so the fleet (and you) can see the live board at a glance.

## Sessions are isolated

Each session is keyed by a fresh UUID. Its socket, pidfile, daemon log, and metadata live
under `.charm/run/<uuid>/`, and its tmux session name carries the UUID. Multiple charm
sessions — in the same directory or different ones — never collide, and `:q` tears down only
the session it was pressed in. When several run in one directory, target a specific one with
`-s`, `-u`, or `-r` on any CLI command (see the [CLI reference](cli.md)).

## Driving from the keyboard vs. the CLI

You can resolve gates either in the console (Approvals tab) or from a separate shell with
`charm approve <gate_id>` / `charm approve <gate_id> --reject`. `charm status` prints the
current agents, tickets, and pending approvals if you want the state without attaching.
