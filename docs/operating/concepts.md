# Concepts

A reference for every term charm uses in its pipeline and tooling. Each entry is short: what the thing is, and what it means in practice.

---

**Session** — a UUID-keyed charm run, encompassing a tmux layout, a Unix socket, a pidfile, and all the agents spawned within it. Everything that charm creates — panes, tickets, agent processes — is scoped to one session. When you run `charm start`, you open a new session; `charm stop` tears it down.

**Ticket** — the unit of work in the pipeline. Each ticket is a markdown file under `.charm/tickets/<id>.md` with a YAML frontmatter block (id, title, status, stage, depends_on, touches) followed by free-form context and an `## Activity` log. The `.md` file is the source of truth; the SQLite index (`db.sqlite`) is rebuilt from the files and should never be edited directly.

**Stage** — where a ticket sits in the pipeline: `generated` (just created), `in_progress` (a worker is on it), `review` or `testing` (in verification), or `done`. Stage describes the phase of work, not its outcome. It is separate from status — a ticket that is `in_progress` in stage can simultaneously have a status of `running`, `blocked`, or `failed`.

**Status** — the current lifecycle state of a ticket: `pending`, `ready`, `running`, `blocked`, `reviewed`, `complete`, `failed`, or `cancelled`. Status is what the coordination board reflects. Workers update status through MCP tools (`set_ticket_status`, `report_status`), not by editing ticket files directly.

**Gate** — a human approval checkpoint that blocks the pipeline from advancing to the next stage. There are three gates: after Discovery (Stage 0, approving the project brief), after Ticket Review (Stage 2, approving enriched tickets), and after Testing (Stage 4, approving each ticket's diff). Gates are intentionally blocking — the orchestrator pauses and waits for your approval before work continues.

**Fleet** — the full set of live `claude` processes running inside a session at any given moment. The fleet includes the orchestrator (main), plus any reviewer, worker, and tester agents that have been spawned. Fleet composition changes as tickets progress: workers are spawned at Stage 3, testers at Stage 4, and each exits when its ticket is done.

**Worker** — a `claude` agent assigned to execute one ticket. Workers run in their own tmux pane, read the coordination board before editing anything, and use `report_status(state="done")` to signal completion. Workers are scoped strictly to the files listed in their ticket's `touches` field.

**Reviewer** — a `claude` agent that enriches a generated ticket before workers run. A reviewer reads the raw ticket produced by the orchestrator and adds concrete file scope (`touches` globs), dependency edges (`depends_on`), and any missing implementation detail. Reviewers run at Stage 2 and produce the enriched ticket the human approves at the Stage 2 gate.

**Tester** — a `claude` agent that checks a finished worker's diff against the ticket's intent. Testers run at Stage 4, after a worker calls `request_review`. They verify that the diff is internally consistent, complete, and does not regress other parts of the codebase — then report a pass or fail before the Stage 4 gate.

**Orchestrator (main agent)** — the primary `claude` process that drives the entire pipeline. The orchestrator conducts the Discovery interview, writes `PROJECT.md`, generates and decomposes tickets, spawns reviewers and workers, monitors progress on the coordination board, and manages the gates. It runs in the main tmux pane for the duration of the session.

**COORDINATION.md** — the soft coordination layer shared by all agents. Located at `.charm/COORDINATION.md`, it is a live table showing every in-play ticket's stage, status, and current agent. Workers read it before editing files to detect scope conflicts with other in-flight tickets. The daemon rewrites the file under a lock; agents must never edit it directly.

**KB (knowledge base)** — the directory `.charm/kb/`, a git-tracked, cross-session store of architecture notes, decisions, gotchas, and domain conventions. Workers append to the KB after completing a ticket when they discover something durable and non-obvious. The KB persists across charm restarts and is designed to accumulate institutional knowledge about the project.

**touches** — the list of file globs in a ticket's frontmatter that declares that ticket's scope. The daemon reads `touches` to serialize tickets whose scopes overlap, preventing two workers from editing the same file simultaneously. Workers are required to stay within their declared `touches`; editing out-of-scope files is a protocol violation that should be reported as a blocker.
