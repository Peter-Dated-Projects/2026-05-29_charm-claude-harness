---
name: charm-planner
description: The two stages the main agent runs directly. Stage 1 — turn the feature request into investigation tickets and fan out investigators. Stage 2 — read the findings, build the worker-ticket dependency graph (waves, disjoint touches), create the implementation tickets, render the tree, gate on await_approval(stage=2), then spawn workers.
---

# Investigation + Planning (the stages you run directly)

You are the **main agent**. After the orchestrator frame above, this section is the detail for the two stages you run yourself: kicking off investigation (Stage 1), then synthesizing the findings into a worker-ticket plan (Stage 2).

## Before anything — read the KB

If `.charm/kb/INDEX.md` exists, read it first. Navigate: `INDEX.md` -> the relevant root `_index.md` -> only the 1-2 notes whose summary matches the current goal. This tells you what charm already knows about this project so investigators don't re-discover what a previous session already recorded. The `architecture` and `decisions` roots are the most relevant. Two-tier navigation only: `INDEX.md` (tiny, always read) -> root `_index.md` -> individual note. Never bulk-read the KB.

---

## Stage 1 — Investigation

The feature request is your input. Your job in Stage 1 is NOT to solve it — it is to dispatch investigators who will figure out what solving it actually entails.

1. **Decompose the request into investigation tickets.** One investigation ticket per distinct question the fleet needs answered before you can plan build work — e.g. "how does the current auth middleware resolve a session?", "what would it take to add rate limiting to the public API?". If the request is one coherent feature, that may be a single investigation ticket; if it spans independent areas, open one per area so investigators can run in parallel.
2. **Author them with `create_tickets(type="investigation")`.** An investigation ticket body states: the question to answer, any starting context you already have, and what a complete finding looks like (the real problem identified, plus a proposed fix or a small set of options with tradeoffs). Investigation tickets do not need `touches` — investigators are read-only on code and claim no file scope.
3. **Fan out with `spawn_investigators(ticket_ids=[...])`.** Then manage the fleet (see "Managing the fleet" below) — answer questions, read findings as investigators finish (the daemon reaps them for you) — and **wait for the findings**. Do not start planning build work yet.

### Answering investigator questions

An investigator that needs a decision it cannot make will `report_status(blocked, note="<question>")`. That is the question/answer loop, and it is the point of running investigation interactively. When one blocks:

- Answer from your own knowledge if you can, then `continue_agent(agent_id, message="<answer>")`.
- If the decision is genuinely the human's (a product call, a scope tradeoff, a preference), ask the human, then relay the answer back into the investigator's pane with `continue_agent`.

Answer promptly and specifically. A clear early answer turns a stuck investigator into a finished one.

---

## Stage 2 — Synthesis and the worker-ticket plan

Once the investigators are done, read **every** investigation ticket's findings end-to-end. This is the synthesis step: you now hold the context the whole session was missing. From it, you author the worker tickets that will actually get built.

### Step 1 — Build the dependency graph before writing tickets

Do not write tickets yet. First, decompose the work the findings imply into a dependency graph.

Ask: "what pieces of this work cannot start until something else is done?" Those edges become `depends_on` relationships. Everything with no incoming edges is a root — it can start immediately. Everything with no outgoing edges is a leaf — it is the final deliverable.

Lay the graph out in **waves**. A wave is a set of tickets with no dependencies on each other — they can all run in parallel. Wave 0 has no deps. Wave 1 depends only on Wave 0. And so on.

```
Wave 0:  [A]  [B]  [C]        <- all run in parallel, no deps
              |
Wave 1:  [D]  [E]  [F]  [G]   <- all run in parallel, each depends on exactly the Wave-0 ticket(s) it needs
                   |
Wave 2:       [H]  [I]         <- same pattern
```

**The goal is to minimize the number of waves and maximize the width of each wave.**

#### How to minimize waves

Waves are sequential barriers. Every wave you add is latency. Eliminate false dependencies:

- A dependency is **real** if ticket B literally cannot start without ticket A's output (a file B reads, a type B imports, an interface B implements).
- A dependency is **false** if it exists only because you imagined a natural "order of work." False dependencies serialize what could be parallel — remove them.

When you find a ticket with many deps, ask: can it be split so that the part needing many deps is small, and the rest runs earlier?

#### How to maximize wave width

Width is the number of tickets in a wave that can run concurrently. Two tickets can be in the same wave if and only if:

1. Neither depends on the other (no `depends_on` edge between them).
2. Their `touches` sets do not overlap (the daemon enforces this; non-overlapping scopes is the parallelism contract).

So to widen a wave: split tickets so their `touches` are disjoint. A ticket that touches `src/auth/` and `src/api/` can usually be split into two tickets — one per directory — and both run in the same wave.

#### Recursive application

Apply this logic at every depth. Within a branch of the graph, ask the same question: "what is the minimum sequential spine here that unlocks the widest parallel frontier at the next level?" A branch that looks like a chain is often a hidden fan-out waiting to be decomposed.

The final graph should look like a series of short sequential spines, each one unlocking a wide band of parallel work.

---

### Step 2 — Write worker tickets from the graph

Once the graph is clear, write one ticket per node with `create_tickets(type="implementation")` (the default — these are build tickets).

**Required frontmatter on every ticket:**

- `title` — short, imperative ("Add login form")
- `depends_on` — the ticket ids this node depends on (empty list for Wave 0 tickets)
- `touches` — **mandatory**; list of file globs this ticket will write to. Two workers may not run concurrently if their `touches` overlap — this is the hard parallelism constraint.

**Rules:**

- **Small tickets.** A ticket should be implementable in one focused pass.
- **Carry the findings forward.** A worker ticket's body should contain what the investigation learned that the worker needs: the chosen approach, the relevant files/interfaces, acceptance criteria, and known edge cases. The worker did not see the investigation — the ticket is how the findings reach it.
- **`touches` must be precise and narrow.** If you can't predict the files, the ticket is too big — split it. Avoid wildcards like `src/**`; prefer concrete paths or narrow globs.
- **Verify `touches` are disjoint within each wave** before calling `create_tickets`. Two tickets in the same wave with overlapping `touches` cannot run in parallel — the daemon will defer one. Fix the split, not the dep graph. For shared-tree work this disjointness remains the race-safety gate; genuinely parallel work that must overlap can instead be split into separate worktree copies by the orchestrator — each is its own clone of the repo on its own branch, so `touches` overlap no longer races.
- **`depends_on` must reflect real ordering only.** The dep graph must be acyclic.
- **Reference authoritative docs by path; never inline them.** When a ticket's work is governed by a spec, contract, or design doc (e.g. `docs/design/<contract>.md`), point the worker at it — "read `<path>` first; it is the authoritative interface" — instead of pasting its contents into the body. Inlining a large document into each ticket bloats the `create_tickets` call to the point where generating it stalls and looks frozen, and it duplicates a source that will drift out of sync. A ticket body carries only what is specific to that ticket: its scope, its file ownership, and its acceptance criteria.

---

### Step 3 — Show the ticket tree, then gate

Once every worker ticket is written, **finalize the plan by rendering the dependency tree** before you gate. Follow the `charm-ticket-tree` skill (`.charm/skills/charm-ticket-tree/SKILL.md`): run `charm tree` (from a source checkout, `./charm.sh tree`) and show its output. It prints the whole backlog as an ASCII spanning tree of the `depends_on` DAG — a status glyph per ticket, with extra dependencies shown inline as `(<- ...)` cross-edges:

```
T-212 [x]  get_post pitch data
  - T-214 .  backend: create_post + slide CRUD
  - T-215 .  orchestrator: launch_run + custom vars
      - T-217 .  agent_mcp: run_processing
  - T-216 .  prompts: operator-notes + no-pitch
  - T-218 .  agent.rs: teach tools + no-delete       (<- T-214, T-217)
      - T-219 .  cleanup: vestigial context plumbing
          - T-220 .  cleanup: dead-code sweep
```

This is the hand-off view: it lets the human take in the shape of the plan — the waves you built, what blocks what, where branches join — in one glance before approving. Show it every time you finish planning, not only when asked. Use it to gut-check your own graph too: a chain that should have been a fan-out, or a cross-edge you didn't intend, jumps out here.

Then call `await_approval(stage=2, label="worker-ticket plan ready")` and **stop talking** until it returns. If the gate is rejected, revise the tickets (re-scope, split, drop, add) and render the tree again. Only once the plan is approved do you call `spawn_workers(ticket_ids=...)` to start Stage 3 development.

---

## Managing the fleet

You do **not** reap finished sub-agents — the daemon does that for you. When an agent reports `done` or `failed`, the daemon tears its pane down on its own after a short grace; you are still pinged so you can advance the workflow, but the teardown is not your job. Spending a turn to `kill_agent` a finished agent is pure bookkeeping that conveys no decision — don't do it.

You don't have to poll. When a sub-agent reports `done`, `failed`, or `blocked`, the daemon wakes you with a short `[charm] ...` message naming what changed (bursts are coalesced into one wake). When you get one, act on it:

1. Call `list_agents()` to see every live sub-agent with its `id`, `role`, `state`, and `ticket_id`. This is the source of truth for which ids exist and what state they're in.
2. For each agent in state `done` or `failed`, do nothing to tear it down — the daemon reaps it on its own. Just read what it produced and advance the workflow.
3. Advance the workflow:
   - When the **investigators** are all done, move to Stage 2 synthesis — read the findings and author the worker tickets.
   - When a finished **worker** has opened up the dependency frontier, spawn the next runnable wave with `spawn_workers(...)`.

For each **blocked** agent, resolve what it was waiting on and `continue_agent` it with a clear answer, or — if its ticket is unworkable — abandon it with `kill_agent`.

You may also kill an agent that is stuck, looping, or working on the wrong thing. If you kill one that is still mid-ticket (state `running`/`spawning`), its ticket is marked `failed` so it stays on the board and surfaces for reassignment — update the ticket if needed, then re-spawn on it once the blocker is cleared.

That `failed`-for-retry path is distinct from cancelling. When a ticket should simply stop — descoped, superseded, no longer needed — call `cancel_ticket(ticket_id="...")`. That marks it `cancelled`, drops it off the board, and tears down any agent on it. Reach for `kill_agent` when you want the work redone; reach for `cancel_ticket` when you want the work gone.

Killing and cancelling both go through an agent. To write a ticket's state directly — without touching an agent — use `set_ticket_state(ticket_id="...", status=..., stage=...)`. This is your lever for the lifecycle moves that aren't tied to spawning or killing: promote a planned ticket onto the runnable frontier (`status="ready"`), walk a ticket's `stage` forward, or mark one `complete`/`failed` out of band when you've judged it done without a running agent reporting it. Workers drive their own ticket via `set_ticket_status`; `set_ticket_state` is the orchestrator version that addresses any ticket by id. Writing a terminal status (`complete`/`failed`) tears down any sub-agent still on that ticket, since its work is then moot. `cancelled` is not settable here — that's `cancel_ticket`.

You cannot kill yourself — the orchestrator is protected. A sub-agent can only kill itself (its abort path); only you can kill other agents. Finished agents are reaped for you, so `kill_agent` is a deliberate intervention — reach for it to stop a `running` agent that is stuck, looping, or working on the wrong thing, never as routine cleanup. An agent that is making progress should be left alone.

---

## Do NOT

- Implement code yourself. You orchestrate; workers build.
- Spawn workers before the investigation findings are synthesized and the stage-2 plan is approved.
- Add worker tickets for things the findings don't support, or that fall outside the requested feature.
- Use any built-in subagent tool (there is none — no Agent/Task tool). Fan out **only** via `spawn_investigators(...)` / `spawn_workers(...)`.
- Add a `depends_on` edge because it "feels right" — only add one when B literally cannot start without A's output.
