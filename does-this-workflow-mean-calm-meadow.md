# Plan — Claude Code Multi-Agent Harness ("Calm Meadow")

## Context

We're building a terminal-based orchestration harness that wraps standalone `claude` CLI processes into a visible, staged, multi-agent workflow. The motivating problem: Claude Code's built-in subagent tool hides subagents inside the parent process, so the user can't watch them work or intervene. We want the opposite — every agent runs as a real `claude` process in its own terminal pane, the human approves transitions between stages, and agents coordinate through a shared planning file rather than git worktrees.

All agents work on **one shared git tree** (no worktrees). Parallelism safety comes from two layers:
1. **Hard layer** — each ticket declares its file scope (`touches:`), and the daemon refuses to run two workers whose scopes overlap.
2. **Soft layer** — every worker reads/writes a shared `COORDINATION.md` so it knows what other in-flight agents are doing and why.

Rust was the original pick, but rustup-init downloads are blocked on this machine (both bare `rustup` and `asdf-rust` failed — asdf-rust uses rustup-init internally and silently produced empty install dirs). We pivoted to **Bun + TypeScript**: `bun build --compile` produces a single-binary MCP shim (spawned by every `claude` process), the MCP TypeScript SDK is the canonical reference implementation, and `bun:sqlite` is built in. Bun is installed via the `asdf-bun` plugin, which pulls from GitHub Releases rather than rust-lang.org and is unblocked.

## Five-stage workflow

| Stage | Who | Mode | Gate |
|---|---|---|---|
| 0 — Discovery | main agent + human | interactive | human approves `PROJECT.md` |
| 1 — Ticket generation | main agent | interactive | none (auto → stage 2) |
| 2 — Ticket review/enrichment | N review agents | headless | human approves each ticket |
| 3 — Development | M worker agents | interactive, coordinated | none (auto → stage 4 per ticket) |
| 4 — Test & review | test agents per ticket | headless | human approves diff before merge |

Stage gates are blocking — the daemon halts the pipeline until the human types `y` in the approval pane.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  harnessd  (Bun + TypeScript)                        │
│    ticket store (.md + bun:sqlite index)             │
│    agent registry, dep + file-scope solver           │
│    COORDINATION.md writer (file-locked)              │
│    tmux pane manager                                 │
│    Unix-socket RPC (Bun.listen)                      │
└──────────────────┬───────────────────────────────────┘
                   │
       ┌───────────┴───────────┐
       │  harness-mcp (Bun TS) │  stdio, one instance per claude
       │  thin RPC shim        │  process; exposes harness tools
       └───────────┬───────────┘
                   │
  ┌────────┬───────┴────────┬─────────────┐
  │        │                │             │
[main]  [reviewer-1]    [worker-A]    [worker-B]      ← real `claude`
                                                        processes,
                                                        each in its own
                                                        tmux pane

  ┌──────────────────────────────────┬──────────────────────┐
  │  main agent (claude)             │                      │
  │                                  │   Console pane       │
  ├──────────────┬───────────────────┤   [Artifacts]        │
  │              │                   │   [Approvals]        │
  │  worker A    │  worker B         │                      │
  │              │                   │   PROJECT.md         │
  │              │                   │   COORDINATION.md    │
  │              │                   │   tickets/...        │
  └──────────────┴───────────────────┴──────────────────────┘
  Console pane is a Ratatui binary spawned by the daemon into a reserved
  tmux pane; auto-refreshes file contents via `notify`; stage-aware default
  selection (Stage 0 → PROJECT.md, Stage 2 → ticket-under-review,
  Stage 3 → COORDINATION.md).
```

## Tech stack

| Layer | Pick | Notes |
|---|---|---|
| Runtime / language | **Bun + TypeScript** | One repo, multiple entrypoints compiled via `bun build --compile` |
| CLI parsing | `commander` | |
| MCP server | `@modelcontextprotocol/sdk` (official TS SDK) | stdio transport; canonical reference implementation |
| Pane substrate | **tmux shell-out** for MVP | Graduate to a richer in-app viewer in v2 if needed |
| Daemon RPC | Unix socket + JSON line protocol (`Bun.listen` / `Bun.connect`) | `zod` for envelope validation |
| Process spawn | `Bun.spawn` | |
| Ticket index | **`bun:sqlite`** (built-in) | Source of truth is `.md` files; SQLite is just an index |
| Dep + scope solver | `graphology` + `graphology-dag` | |
| Frontmatter | `gray-matter` | |
| File watching | `chokidar` (or `Bun.watch`) | |
| Console pane | **Ink** (React-based TUI) + `chokidar` | Tabbed TUI in one reserved tmux pane: **Artifacts** (live file viewer for `PROJECT.md`, `COORDINATION.md`, `tickets/*.md` with fs-watch auto-refresh and stage-aware default selection) and **Approvals** (pending human gates). Same TUI stack Claude Code itself uses. |
| Schema validation | `zod` | RPC envelopes, MCP tool inputs, frontmatter |

Distribution: `bun build src/cli.ts --compile --outfile harness` produces a standalone binary. The MCP shim is a separate compiled entrypoint (`bun build src/mcp/server.ts --compile --outfile harness-mcp`) so each `claude` process spawns it cleanly with no runtime dependency.

## Artifacts the harness owns

- `PROJECT.md` — human-approved project brief (Stage 0 output)
- `tickets/T-NNN.md` — one ticket per file, YAML frontmatter (`title, status, stage, depends_on, touches`)
- `COORDINATION.md` — daemon-maintained registry of in-flight agents and their declared plans
- `.harness/db.sqlite` — fast index
- `.harness/sock` — daemon Unix socket
- `.harness/prompts/*.md` — system prompts for each role (first-class deliverables)
- `harness.json` — MCP server config consumed by every `claude` process

## Spawning a `claude` process — concrete invocations

```bash
# Interactive worker (visible streaming, human can intervene)
claude \
  --append-system-prompt "$(cat .harness/prompts/worker.md)" \
  --mcp-config harness.json \
  "Implement ticket T-007. First read tickets/T-007.md and COORDINATION.md, \
   then call update_plan() with your plan, then implement."

# Headless review pass (one-shot, exits when done)
claude -p \
  --append-system-prompt "$(cat .harness/prompts/reviewer.md)" \
  --mcp-config harness.json \
  "Review and enrich tickets/T-007.md in place."
```

The daemon wraps each with `tmux split-window -h -P -F '#{pane_id}'` to capture the pane id, then maintains a `pane_id → agent_id` map for kill/focus/status.

## MCP tools exposed to every `claude` process

| Tool | Caller | Effect |
|---|---|---|
| `create_tickets(list)` | main | write `tickets/*.md` + index |
| `spawn_review_agents(ids)` | main | daemon spawns one headless reviewer per id |
| `spawn_workers(ids)` | main | daemon enforces dep+scope, spawns interactive workers |
| `await_approval(stage, payload)` | main | block on human approval in TUI pane |
| `update_plan(plan_text)` | worker | append/update entry in `COORDINATION.md` |
| `read_coordination()` | any | fetch current `COORDINATION.md` |
| `report_status(state)` | any | mark agent done/blocked/failed |
| `request_review(ticket_id)` | worker | spawn tester on finished ticket |

## Prompts — call out as a real deliverable

Quality of prompts will make or break the user-perceived behavior. Write each as a small `.md` file under `.harness/prompts/`:

- `discovery.md` — main, Stage 0: drive the structured Q&A that produces `PROJECT.md`; ask one focused question at a time; produce explicit non-goals.
- `planner.md` — main, Stage 1: turn `PROJECT.md` into tickets; **must** populate `touches` and `depends_on`; small tickets preferred.
- `reviewer.md` — Stage 2: enrich a single ticket with context, edge cases, acceptance criteria, refined file scope; never expand scope beyond the ticket.
- `worker.md` — Stage 3: read `COORDINATION.md` first; call `update_plan` before any edit; stop and report if scope expands.
- `tester.md` — Stage 4: validate acceptance criteria; produce a checklist result; no code edits.

## MVP build order

1. `bun init`, `tsconfig.json`, repo layout. Single `package.json`, multiple bin entrypoints.
2. `harness` CLI skeleton (`commander`) — `init`, `start`, `attach`, `status`.
3. `harnessd` daemon (long-running Bun process) — Unix-socket RPC, in-memory agent registry.
4. tmux integration — spawn pane, capture pane id, kill pane.
5. `harness-mcp` stdio MCP server (`@modelcontextprotocol/sdk`), wired to daemon RPC.
6. Five prompt files under `.harness/prompts/`.
7. Ticket store — `gray-matter` parse/write + `bun:sqlite` index.
8. Dep + file-scope solver using `graphology` + `graphology-dag`.
9. `COORDINATION.md` writer with file-locked atomic rewrites + JSON-shaped section per agent.
10. Console pane (Ink, one reserved tmux pane): **Artifacts** tab (file tree + live markdown viewer, fs-watch via `chokidar`, stage-aware default file) and **Approvals** tab (pending gates, accept/reject inline).
11. End-to-end smoke test (see Verification).
12. `bun build --compile` recipes for `harness` and `harness-mcp`.

### Out of scope for MVP
- Custom in-app window manager replacing tmux (v2)
- Cost / token tracking
- Resume across daemon restarts
- Cross-machine orchestration
- Git worktrees (explicitly rejected — shared tree by design)

## Critical files to create

- `package.json`, `tsconfig.json`, `bun.lockb` at repo root
- `src/cli.ts` — `harness` CLI entrypoint (`init`, `start`, `attach`, `status`)
- `src/daemon/{index.ts, registry.ts, tmux.ts, solver.ts, coord.ts, rpc.ts}`
- `src/mcp/{server.ts, tools.ts}` — compiled to `harness-mcp` binary
- `src/console/{app.tsx, artifacts.tsx, approvals.tsx}` — Ink-based Console pane
- `src/schema.ts` — `zod` schemas for ticket frontmatter, RPC envelopes, MCP tool I/O
- `.harness/prompts/{discovery,planner,reviewer,worker,tester}.md` (templates)
- `harness.json` (MCP config template consumed by every `claude` process)

No existing code to reuse — this is greenfield (repo only has the initial commit).

## Verification

End-to-end smoke test:

1. `harness init` in an empty directory → confirms `tickets/`, `harness.json`, `.harness/` created.
2. `harness start "build a markdown to-do CLI in Rust"` → tmux session opens, main agent in pane 0, Console pane reserved on the right showing the Artifacts tab (initially empty).
3. Discovery chat works → `PROJECT.md` written and **appears live in the Console pane's Artifacts tab** as the main agent writes it; approval gate fires in the Approvals tab; human approves.
4. Main generates tickets → `ls tickets/` shows N files with valid `touches` and `depends_on`.
5. Review agents spawn → headless panes appear and exit; each ticket's body has been enriched.
6. Approval pane prompts per ticket → user approves T-001…T-00N.
7. Workers spawn → interactive panes appear; `COORDINATION.md` shows live entries **in the Artifacts tab as workers call `update_plan`**.
8. Force a collision case: two tickets with overlapping `touches` → confirm daemon serializes them (visible in logs and tmux: second pane appears only after first finishes).
9. Workers finish → test agents spawn → diffs surface for human merge approval.
10. Inspect `git log` (single tree, sequential commits from workers) and `.harness/db.sqlite` for audit trail.

Targeted unit tests (small, valuable):
- Scope solver: given a ticket set + in-flight workers, returns the correct next-runnable batch.
- Frontmatter round-trip: parse → mutate → write preserves field order and comments.
- COORDINATION.md concurrent writes under `flock` produce no interleaved garbage.
- MCP tool dispatch table covers every documented tool.
