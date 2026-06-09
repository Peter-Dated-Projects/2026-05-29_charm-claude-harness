# Charm preflight — full functional sweep

A repeatable smoke test that exercises every built-in charm feature and confirms each
works as designed. The actual code the fleet writes is trivial on purpose — this tests the
**harness**, not model quality.

A single prompt can't trigger everything: roughly half the surface is agent-triggerable
(MCP tools, pipeline stages, coordination, failure/recovery) and half is *operator*-driven
from outside the agent (CLI subcommands, in-session `:` commands, approval gates, hard-
killing a pane to test the liveness sweep). So the preflight is two halves — a goal you
paste in (Part A) and a checklist you drive by hand against the live session (Part B).

Run it with a cheap, fast model — you're testing the harness, not output quality:

```sh
./charm.sh start -m haiku-4.5 --development "<Part A goal below>"
```

---

## Part A — the goal you paste in

```
This is a HARNESS SELF-TEST, not a real product. Your job is to exercise every charm
feature in sequence and narrate what you're doing so I can verify each works. Keep all
actual code trivial. Follow this script:

STAGE 0 — Discovery: Do a short discovery pass and write .charm/PROJECT.md describing a
tiny "string-utils" library smoke test. Then call await_approval and STOP for my gate.

STAGE 1 — Planning: After I approve, use create_tickets to write exactly FOUR tickets
with these scopes (so the solver has real work to do):
  - T-A: implement `upper(s)` in src/upper.js          (no deps)
  - T-B: implement `reverse(s)` in src/reverse.js       (no deps — must run PARALLEL to T-A)
  - T-C: implement cli.js importing both                (DEPENDS on T-A and T-B)
  - T-D: also edits src/upper.js                        (OVERLAPS T-A's scope on purpose)
Declare touches: accurately and set the T-C dependency. T-D's overlap with T-A must force
the solver to SERIALIZE them, not run both at once.

STAGE 2 — Review: Call spawn_review_agents so a headless reviewer enriches each ticket.
Report when they finish, then call await_approval for my ticket-approval gate. STOP.

STAGE 3 — Development: After I approve, call spawn_workers. Confirm in your narration that
T-A and T-B ran concurrently while T-C stayed blocked on its deps and T-D was serialized
behind T-A. Each worker must call update_plan to write its COORDINATION.md entry and
report_status as it goes. Use set_ticket_status from inside workers.

FAILURE/RECOVERY — On ticket T-D ONLY, deliberately have the worker report_status failed
(simulate a stuck task). Then, as orchestrator, demonstrate recovery: use kill_agent on a
running agent, continue_agent to resume one, set_ticket_state to force a ticket's
status/stage by id, and cancel_ticket on T-D. Narrate each.

STAGE 4 — Test: Call request_review on a completed ticket to spawn a tester, let it
validate against acceptance criteria, then await_approval for the diff-merge gate. STOP.

THROUGHOUT — Also call these so I can confirm they work, and report their output:
list_tickets, list_agents, read_coordination, set_session_description ("preflight sweep"),
and open_graph (open the graph viewer window).

Announce each tool call before you make it. If any tool errors, say so verbatim — do not
paper over it. Do not advance past an await_approval until I approve.
```

### What Part A covers

| Feature | Proven by |
|---|---|
| Stage 0 discovery + `PROJECT.md` authoring | discovery pass writes the brief |
| `await_approval` (×3 gates) | blocking stops at stages 0, 2, 4 |
| `create_tickets` + ticket store + sqlite index | four `.md` tickets written |
| `spawn_review_agents` (headless) | Stage 2 reviewer enrichment |
| `spawn_workers` + dep/scope solver | T-A‖T-B parallel, T-C dep-gated, **T-D serialized behind T-A** |
| `update_plan` / `read_coordination` | workers populate `COORDINATION.md` |
| `report_status` / `set_ticket_status` | worker-driven state transitions |
| Failure path | T-D `report_status failed` |
| `kill_agent` / `continue_agent` / `cancel_ticket` / `set_ticket_state` | recovery section |
| `request_review` (tester) | Stage 4 validation |
| `list_tickets` / `list_agents` | board + fleet inspection |
| `set_session_description` | session relabel |
| `open_graph` | standalone graph viewer window |

> The four-ticket shape is the heart of the test. **If you watch only one thing, watch
> whether T-D ever runs simultaneously with T-A — it must not.** Scope-overlap
> serialization is the subtlest part of the solver and the easiest to silently regress.

---

## Part B — operator checklist (driven by hand)

These cannot be triggered by the agent. Run them against the live session.

- **Approval gates** — approve each of the three gates: at least once from the Console pane
  UI, and at least once via `charm approve <gate_id>`, to prove both paths.
- **Liveness sweep** — while a worker runs, `tmux kill-pane` on its pane by hand. The
  daemon's liveness sweep should detect the dead pane and reap the agent from the registry
  within the sweep interval. Only a hard external kill exercises this path — a graceful
  `report_status failed` does not.
- **MCP-stays-alive** — let an agent go idle, then confirm `list_agents` still shows it and
  its `charm-mcp` shim is still connected over the socket (it must not die on inactivity).
- **CLI subcommands** — run each against the session: `charm status`, `charm attach`,
  `charm session-name`, `charm ctl <cmd>`, `charm restart`, `charm stop`. Test `init` and
  `reset-kb` only in a scratch dir — **`reset-kb` wipes the durable `.charm/kb/`**.
- **In-session `:` commands** — `:dev` / `:research` to swap the fleet model mid-session
  (new spawns should pick up the new model), `:a` to detach, `:q` to tear down. After `:q`,
  confirm it killed **only** this UUID's panes and `run/<uuid>/` dir, leaving other
  charm/claude sessions untouched.
- **Durable KB** — confirm `.charm/kb/` survives a full `:q` + fresh `start` in the same
  dir. It is the one part of `.charm/` that is not ephemeral run state.

---

## Notes

- Failure/recovery is tested twice on purpose: the agent's self-inflicted
  `report_status failed` (Part A) exercises the soft path; your hand-kill of a pane
  (Part B liveness sweep) exercises the hard path. They are different code — keep both.
- Out of scope: anything under the proposal/feasibility docs (harness notes, UI revamp).
  Those are research for unbuilt features and would test nothing.
