# Charm preflight — full functional sweep

A repeatable smoke test that exercises every built-in charm feature and confirms each
works as designed. The actual code the fleet writes is trivial on purpose — this tests the
**harness**, not model quality.

A single prompt can't trigger everything: roughly half the surface is agent-triggerable
(MCP tools, pipeline stages, coordination, failure/recovery) and half is *operator*-driven
from outside the agent (CLI subcommands, in-session `:` commands, approval gates, hard-
killing a pane to test the liveness sweep). So the preflight is two halves — a script you
paste into the orchestrator (Part A) and a checklist you drive by hand against the live
session (Part B).

Run it with a cheap, fast model — you're testing the harness, not output quality:

```sh
./charm.sh start -m haiku-4.5 --project   # pick any brief (or create a throwaway)
# then paste the Part A script into the orchestrator pane as the session ask
```

---

## Part A — the script you paste in

```
This is a HARNESS SELF-TEST, not a real product. Your job is to exercise every charm
feature in sequence and narrate what you're doing so I can verify each works. Keep all
actual code trivial. Follow this script:

STAGE 1 — Investigation: Open ONE investigation ticket with create_tickets(type=
"investigation") asking what a tiny "string-utils" library smoke test would entail, then
call spawn_investigators on it. Let the investigator write its findings into the ticket
body and report_status(done). To exercise the question/answer loop, have the investigator
report_status(blocked) once with a question; answer it with continue_agent. Reap it with
kill_agent when done. There is NO human gate at this stage.

STAGE 2 — Planning / synthesis: Read the investigation findings, then use create_tickets
(type="implementation") to write exactly FOUR worker tickets with these scopes (so the
solver has real work to do):
  - T-A: implement `upper(s)` in src/upper.js          (no deps)
  - T-B: implement `reverse(s)` in src/reverse.js       (no deps — must run PARALLEL to T-A)
  - T-C: implement cli.js importing both                (DEPENDS on T-A and T-B)
  - T-D: also edits src/upper.js                        (OVERLAPS T-A's scope on purpose)
Declare touches: accurately and set the T-C dependency. T-D's overlap with T-A must force
the solver to SERIALIZE them, not run both at once. Render the plan with `charm tree`,
then call await_approval(stage=2) for my worker-ticket-plan gate. STOP.

STAGE 3 — Development: After I approve, call spawn_workers. Confirm in your narration that
T-A and T-B ran concurrently while T-C stayed blocked on its deps and T-D was serialized
behind T-A. Each worker must call update_plan to write its COORDINATION.md entry and
report_status as it goes. Use set_ticket_status from inside workers.

FAILURE/RECOVERY — On ticket T-D ONLY, deliberately have the worker report_status failed
(simulate a stuck task). Then, as orchestrator, demonstrate recovery: use kill_agent on a
running agent, continue_agent to resume one, set_ticket_state to force a ticket's
status/stage by id, and cancel_ticket on T-D. Narrate each.

STAGE 4 — Test: Call request_review on a completed ticket to spawn a tester, let it
validate against acceptance criteria, then await_approval(stage=4) for the diff-merge
gate. STOP.

STAGE 5 — Worktrees, researchers & proposals: After I approve Stage 4, exercise the
parallel-work surface. Keep everything trivial. There is NO human gate at this stage.
  - Proposals: create_proposal(name="preflight-demo") for a throwaway feature note, then
    list_proposals to confirm it shows up, then finish_proposal on it (moves it to
    proposals/finished/). Narrate each.
  - Researcher: spawn_researchers with ONE trivial prompt ("In one sentence, what would a
    string-utils smoke test cover?"). Let it write its scratchpad file, report the path
    back, and report_status(done). Confirm in narration it ran ticket-less and was NOT gated
    like the build tools. (Researchers default to Sonnet-1M, but the fleet `-m` flag overrides
    that — so under the haiku sweep the researcher runs on haiku; the point here is the
    ticket-less, ungated path, not the model.)
  - Worktree isolation: create_worktree(name="preflight-wt") to cut a fresh charm/preflight-wt
    branch. Create ONE trivial implementation ticket (append a single line to
    src/wt-probe.txt) and spawn_workers(ticket_ids=[...], worktree="preflight-wt") so it runs
    in that isolated checkout. Call list_worktrees and confirm it reports the worktree's path,
    branch, and the occupying agent. After the worker reports done, confirm the edit landed on
    the charm/preflight-wt branch and the MAIN working tree is untouched. Then
    close_worktree(name="preflight-wt", delete_branch=true). You MUST leave NO worktree open
    at session end.

THROUGHOUT — Also call these so I can confirm they work, and report their output:
list_tickets, list_agents, read_coordination, set_session_description ("preflight sweep"),
and open_graph (open the graph viewer window).

Announce each tool call before you make it. If any tool errors, say so verbatim — do not
paper over it. Do not advance past an await_approval until I approve.
```

### What Part A covers

| Feature | Proven by |
|---|---|
| Stage 1 investigation + findings into the ticket body | investigator works the investigation ticket |
| `await_approval` (×2 gates) | blocking stops at stages 2 and 4 |
| `create_tickets` (both types) + ticket store + sqlite index | one investigation ticket + four implementation tickets written |
| `spawn_investigators` (interactive) | Stage 1 investigation pass |
| `spawn_workers` + dep/scope solver | T-A‖T-B parallel, T-C dep-gated, **T-D serialized behind T-A** |
| `update_plan` / `read_coordination` | workers populate `COORDINATION.md` |
| `report_status` / `set_ticket_status` | worker-driven state transitions |
| Failure path | T-D `report_status failed` |
| `kill_agent` / `continue_agent` / `cancel_ticket` / `set_ticket_state` | recovery section |
| `request_review` (tester) | Stage 4 validation |
| `create_proposal` / `list_proposals` / `finish_proposal` | Stage 5 proposal created, listed, moved to `proposals/finished/` |
| `spawn_researchers` (ticket-less, **ungated**; Sonnet-1M default, fleet `-m` overrides) | Stage 5 researcher writes a scratchpad and reports its path |
| `create_worktree` / `list_worktrees` / `close_worktree` | Stage 5 worktree opened, occupied, verified isolated, then closed |
| `worktree` param on `spawn_workers` | Stage 5 worker's edit lands on `charm/preflight-wt`, main tree untouched |
| `list_tickets` / `list_agents` | board + fleet inspection |
| `set_session_description` | session relabel |
| `open_graph` | standalone graph viewer window |

> The four-ticket shape is the heart of the test. **If you watch only one thing, watch
> whether T-D ever runs simultaneously with T-A — it must not.** Scope-overlap
> serialization is the subtlest part of the solver and the easiest to silently regress.

---

## Part B — operator checklist (driven by hand)

These cannot be triggered by the agent. Run them against the live session.

- **Approval gates** — approve each of the two gates (stage 2 and stage 4): at least once
  from the Console pane UI, and at least once via `charm approve <gate_id>`, to prove both
  paths.
- **Liveness sweep** — while a worker runs, `tmux kill-pane` on its pane by hand. The
  daemon's liveness sweep should detect the dead pane and reap the agent from the registry
  within the sweep interval. Only a hard external kill exercises this path — a graceful
  `report_status failed` does not.
- **MCP-stays-alive** — let an agent go idle, then confirm `list_agents` still shows it and
  its `charm-mcp` shim is still connected over the socket (it must not die on inactivity).
- **CLI subcommands** — run each against the session: `charm status`, `charm attach`,
  `charm session-name`, `charm ctl <cmd>`, `charm restart`, `charm stop`. Test `init` and
  `reset-kb` only in a scratch dir — **`reset-kb` wipes the durable `.charm/kb/`**.
- **`charm resume`** — recovery path for a dead orchestrator. Kill the orchestrator's Claude
  pane (or its whole daemon) by hand, then run `charm resume` to relaunch it on its saved
  conversation, and once with `charm resume --continue` for the most-recent conversation.
  Confirm the orchestrator pane comes back and re-registers its panes with a fresh daemon.
- **`charm worktree list`** — read-only worktree view. Run it once while the Stage-5 worktree
  is open and a live daemon is up (each copy annotated with the agent occupying it), then again
  after the session is down (dir-scan fallback: name/path/branch, no agent column), to prove
  both paths. Open/close are MCP-only (`create_worktree`/`close_worktree`) — there is no CLI
  mutation, by design.
- **In-session `:` commands** — verify `:so` / `:so c` spawn Claude Sonnet and `:so g`
  spawns GPT Terra; use `:a` to detach and `:q` to tear down. After `:q`,
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
