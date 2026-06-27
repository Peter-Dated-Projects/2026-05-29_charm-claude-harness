---
name: charm-ticket-tree
description: Render the ticket backlog as an ASCII dependency tree — a spanning-tree view of the DAG with a status glyph per ticket and inline (← …) cross-edges. Run it when finalizing the worker-ticket plan (the last step of Stage 2, before the await_approval gate) and any time the user asks to see the ticket tree, dependency tree, or board structure.
---

# Ticket dependency tree

Charm tracks tickets as a DAG of `depends_on` edges. This skill prints that DAG
as a readable ASCII tree so a human can take in the whole plan at a glance — the
shape of the work, what blocks what, and where each ticket sits in its lifecycle:

```
T-212 ✓  get_post pitch data
  ├─ T-214 ·  backend: create_post + slide CRUD
  ├─ T-215 ●  orchestrator: launch_run + custom vars  [running]
  │   └─ T-217 ·  agent_mcp: run_processing
  ├─ T-216 ·  prompts: operator-notes + no-pitch
  └─ T-218 ·  agent.rs: teach tools + no-delete       (← T-214, T-217)
      └─ T-219 ·  cleanup: vestigial context plumbing
          └─ T-220 ·  cleanup: dead-code sweep
```

The whole render is one command, `charm tree`. Like the other operator skills it
delegates to a `charm` subcommand, so it works in any project without importing
charm's source. You do not reproduce the layout by hand — running the command is
the skill.

## How it reads

- **Glyph after the id** = the ticket's status: `✓` complete · `✗` failed ·
  `●` running · `⊘` blocked · `○` ready · `·` pending ·
  `⊗` cancelled. A legend prints under the tree.
- **A `[word]` tag** spells out the in-flight or terminal-but-notable statuses
  (running, blocked, ready, failed, cancelled). Freshly-planned tickets
  are all `pending`, so a planning-time tree shows mostly structure — which is
  the point.
- **Tree structure** = the `depends_on` graph laid out as a spanning tree. Each
  ticket hangs under its **primary parent** (the first id in its `depends_on`),
  and any further dependencies show inline as `(← T-x, T-y)` cross-edges. Reorder
  a ticket's `depends_on` to re-parent it; put the root-most dependency first.
- **Tickets with no dependencies** are roots; several roots render as a forest.

## When to use

- **Finalizing the worker-ticket plan (Stage 2).** Run it as the last step before
  `await_approval(stage=2, ...)`, so the human sees the full dependency structure
  of what you just planned and can sanity-check it before approving the plan and
  letting workers fan out. This is the required hand-off view — see the Planner prompt.
- The user asks to "see the ticket tree" / "dependency tree" / "show the board" /
  "what depends on what".
- You want to confirm the graph after re-parenting or adding tickets — a quick
  visual that the waves and cross-edges came out the way you intended.

## Steps

Run from the project root (the dir holding `.charm/`):

```bash
charm tree            # from a source checkout: ./charm.sh tree
```

It reads the ticket `.md` files directly — the source of truth — so it works
with or without a running daemon, and never has to be in sync with anything.
To inspect a board rooted elsewhere, pass `--root <path>`.

Show the output to the human verbatim (it is already formatted); add a one-line
read of the structure if it helps — e.g. "three parallel branches off T-212, with
T-218 the join point." Do not redraw the tree yourself.

## Caveats to flag

- **A dangling dependency is dropped, not drawn.** If a ticket's `depends_on`
  names an id that isn't on the board, that edge is silently ignored and the
  ticket may render as a root. If a ticket surfaces higher than you expected,
  check its `depends_on` for a typo'd or deleted id.
- **A cycle can't be a tree.** The dep graph is supposed to be acyclic (the
  daemon enforces it on spawn), but if a hand-edit introduces a loop the tangled
  tickets are listed flat at the end marked `(cycle)` rather than hanging in the
  tree — a signal to fix the `depends_on` edges.
