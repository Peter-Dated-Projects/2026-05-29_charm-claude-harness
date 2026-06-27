# charm — a multi-agent orchestration harness for Claude Code

Charm turns one goal into a visible fleet of `claude` processes working a shared git
tree in parallel, with a human approval gate between each stage of the work.

## Why this exists

Claude Code already ships a subagent tool, but it hides every subagent *inside the
parent process*. You can't watch them work, you can't drop into one mid-task, and you
can't tell what they're doing to each other. I wanted the opposite: a way to run **more
Claude in parallel** where every agent is a real, first-class `claude` process I can see
streaming in its own terminal pane, intervene in by hand, and reason about as an
independent worker.

Charm is that harness. The main agent decomposes a goal into tickets, then fans the
tickets out to worker agents — each a separate `claude` running in its own tmux pane on
the same repository. The human stays in the loop at staged approval gates, and the agents
stay out of each other's way through two coordination layers (hard file-scope locking +
a soft shared coordination file) on one shared git tree.

## How it works

### The four-stage pipeline

Every charm session runs the same fixed, gated pipeline. The main ("orchestrator") agent
drives it in a single session, joining two decoupled phases: investigators gather context
and propose fixes (Phase A), then the orchestrator synthesizes their findings into worker
tickets that get built (Phase B). Fan-out to workers only happens after the findings are
synthesized and the worker-ticket plan is approved.

| Stage | Who runs it | Mode | Gate before advancing |
|---|---|---|---|
| 1 — Investigation | main agent opens investigation tickets + N investigator agents | interactive | none → investigators close their own tickets |
| 2 — Planning / synthesis | main agent reads findings, authors worker tickets | interactive | human approves the worker-ticket plan |
| 3 — Development | M worker agents | interactive, coordinated | none → each ticket advances on its own |
| 4 — Test & review | tester agents, one per ticket | interactive | human approves the diff before merge |

Tickets carry a `type` (`investigation` or `implementation`) that decides who works them:
investigation tickets go to investigators, implementation tickets to workers.

Gates are blocking: the daemon halts the pipeline until the human approves in the Console
pane (or via `charm approve <gate_id>`). The two gates are at Stage 2 (the worker-ticket
plan) and Stage 4 (the merge diff). The hard rule baked into the orchestrator prompt is
that no worker fan-out happens before the investigation findings are synthesized and that
plan is approved.

### Parallelism on one shared tree

All agents work on **one git tree** by default. Safety comes from two layers:

1. **Hard layer** — each ticket declares its file scope (`touches:` in frontmatter), and
   the daemon's dependency + scope solver refuses to run two workers whose scopes overlap.
   Overlapping tickets are serialized automatically.
2. **Soft layer** — every worker reads and writes a shared `.charm/COORDINATION.md` so it
   knows what other in-flight agents are doing and why, before it touches anything.

Worktrees are available as an optional orchestrator-side tool for parallel lines of work
that need full isolation (e.g. separate feature branches or Graphite stacked PRs). Each is
a completely separate copy of the repo (a clone with its own `.git`), so an agent's edits
there — including to its own `.charm` and KB — never touch the main checkout; work is merged
back deliberately. The orchestrator manages them via `create_worktree` / `list_worktrees` /
`close_worktree`; they live under `.charm/worktrees/<name>/` and are not the default
execution model. See [docs/operating/worktrees.md](docs/operating/worktrees.md).

A concurrent-agent cap (`--max-agents`, default 10, counting the orchestrator) bounds how
many `claude` processes run at once.

### Architecture

```text
┌──────────────────────────────────────────────────────┐
│  charmd  (Bun + TypeScript daemon)                     │
│    ticket store (.md files + bun:sqlite index)         │
│    agent registry + dep/file-scope solver              │
│    .charm/COORDINATION.md writer                       │
│    tmux pane/layout manager                            │
│    Unix-socket JSON-RPC                                 │
└──────────────────┬─────────────────────────────────────┘
                   │  (one shim per claude process, over the socket)
       ┌───────────┴───────────┐
       │  charm-mcp (Bun, TS)  │  stdio MCP server; exposes charm tools
       └───────────┬───────────┘
                   │
  ┌────────┬───────┴────────┬─────────────┐
 [main]  [investigator-1] [worker-A]    [worker-B]  ← real `claude` processes,
                                                      each in its own tmux pane

  tmux window:  console pane (left)  +  agent grid (right, VS-Code-style)
```

- **`charm` (CLI)** — `init` / `start` / `stop` / `attach` / `status` / `approve` /
  `restart` / `reset-kb`. `start` spawns the daemon and console, opens the tmux layout,
  and launches the main agent.
- **`charmd` (daemon)** — the long-running brain. Owns the ticket store, the agent
  registry, the dependency/scope solver, the coordination file, and the tmux layout. Talks
  to agents over a per-session Unix socket with a JSON line protocol.
- **`charm-mcp` (MCP shim)** — a thin stdio MCP server spawned by *every* `claude` process
  via `.charm/charm.json`. It exposes the charm tools and forwards each call to the daemon
  over the socket.
- **`charm-console` (TUI)** — an Ink (React-for-the-terminal) app pinned to the left pane.
  Live file viewer for `COORDINATION.md` and tickets (fs-watched auto-refresh), plus the
  approval gates.
- **`charm-graph`** — a standalone animated force-directed view of the ticket/dependency
  graph, opened in its own terminal window via the `open_graph` tool.

Each session is keyed by a fresh UUID. Its socket, pidfile, daemon log, and metadata live
under `.charm/run/<uuid>/`, and its tmux session name carries the UUID — so multiple charm
sessions (same dir or different) never collide, and `:q` tears down only the session it
was pressed in.

### MCP tools exposed to agents

| Tool | Typical caller | Effect |
|---|---|---|
| `create_tickets` | main | write `.charm/tickets/*.md` + index (capped at 3/call); each ticket is `type` investigation or implementation |
| `spawn_investigators` | main | spawn one interactive investigator per investigation-ticket id |
| `spawn_workers` | main | enforce dep + scope, spawn interactive workers |
| `request_review` | main/worker | spawn a tester on a finished ticket |
| `await_approval` | main | block on a human gate in the Console |
| `update_plan` | worker | append to the ticket's activity log (`.charm/tickets/<id>.md`); `COORDINATION.md` is refreshed as a side effect |
| `read_coordination` | any | fetch current `COORDINATION.md` |
| `list_tickets` / `list_agents` | any | inspect board / fleet state |
| `report_status` | any | mark self spawning/running/blocked/done/failed |
| `set_ticket_status` | worker | move the caller's OWN ticket's status/stage |
| `set_ticket_state` | main | write any ticket's status/stage by id (terminal status reaps its agent) |
| `kill_agent` / `continue_agent` / `cancel_ticket` | main | manage the fleet |
| `set_session_description` | main | label the session for the picker |
| `open_graph` | any | open the standalone graph viewer window |

### Durable knowledge base

`.charm/kb/` is a git-tracked, cross-session knowledge base (architecture, decisions,
conventions, gotchas, domain glossary) that survives between runs. It's the one part of
`.charm/` that the optional `.gitignore` setup keeps tracked — everything else under
`.charm/` is ephemeral run state.

## Evaluating charm

If you're deciding whether charm fits your workflow, the design notes in
[docs/design/](docs/design/) explain the core tradeoffs — why first-class tmux panes
instead of hidden subagents, how the scope-solver handles parallelism safely, and the
deliberate choices behind the staged pipeline and human gates.

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime / language | **Bun + TypeScript** | one repo, several entrypoints compiled via `bun build --compile` |
| CLI parsing | `commander` | |
| MCP server | `@modelcontextprotocol/sdk` (official TS SDK) | stdio transport |
| Pane substrate | **tmux** (shell-out) | required at runtime |
| Daemon RPC | Unix socket + JSON line protocol | per-session socket |
| Process spawn | Bun / `node:child_process` | spawns `claude` + sibling binaries |
| Ticket index | **`bun:sqlite`** (built-in) | `.md` files are source of truth; SQLite is just an index |
| Dep + scope solver | `graphology` + `graphology-dag` | |
| Frontmatter | `gray-matter` | |
| File watching | `chokidar` | console auto-refresh |
| Console / graph TUI | **Ink** + React, `marked` | same TUI stack Claude Code itself uses |
| Schema validation | `zod` | RPC envelopes, MCP tool I/O, frontmatter |

Bun was the pick over the original Rust plan because `bun build --compile` produces
single-file native binaries with the runtime embedded (no Node/Bun needed at runtime), the
MCP TypeScript SDK is the canonical reference implementation, and `bun:sqlite` is built in.

Each entrypoint compiles to its own binary — `charm` (CLI), `charmd`, `charm-mcp`,
`charm-console`, `charm-graph` — and they must be co-located on PATH, since `charm start`
execs its siblings and every `claude` resolves `charm-mcp` by name.

## Requirements

- **Claude Code CLI** (`claude`) on PATH — charm launches `claude` processes as its agents.
  `npm install -g @anthropic-ai/claude-code`
- **tmux** on PATH at runtime.
- **Bun** ≥ 1.1 to build or run from source (not needed once binaries are installed).

## Documentation

Full docs live in [docs/](docs/README.md), organized by audience — operating charm
(getting started, running a session, modes, the CLI, keybindings, troubleshooting),
developing charm (architecture, MCP tools, build, the knowledge base, preflight), and the
design notes behind the harness.

## Quick start

From source, no install:

```sh
./frieren.sh setup                      # checks deps, runs bun install
./charm.sh start "build a markdown to-do CLI"   # prompts research vs development mode
```

`start` opens a tmux session: the console on the left, the main agent on the right. Watch
investigators gather context, let the orchestrator synthesize their findings into a
worker-ticket plan, approve that plan, and watch workers fan out. Inside the session, the
`:` key opens a command prompt — `:q` quits the charm, `:a` detaches, `:dev` / `:research`
swap the fleet's model mid-session.

Mode and model:

```sh
./charm.sh start --research "..."   # fleet defaults to Sonnet
./charm.sh start --development "..."  # fleet defaults to Opus
./charm.sh start -m opus-4.8 "..."  # pin the whole fleet to a model in any mode
```

Install globally (build + place binaries and templates on PATH at `~/.local/bin`):

```sh
./frieren.sh install
charm start "your goal"
```

Panic button if a session wedges — kills every charm process machine-wide while sparing
your other (non-charm) `claude` sessions:

```sh
./frieren.sh kill
```

## Project layout

```text
src/
  cli.ts              charm CLI (init/start/stop/attach/status/approve/...)
  paths.ts            per-session path resolution
  schema.ts           zod schemas (tickets, RPC, session meta)
  graph-viewers.ts    graph-viewer process management
  daemon/             charmd: index, rpc, registry, solver, coord, tmux, layout,
                      spawn, approvals
  mcp/server.ts       charm-mcp stdio MCP server
  store/tickets.ts    gray-matter + bun:sqlite ticket store
  console/            Ink TUI: app, markdown, graph, mouse
  cli/                interactive mode + confirm prompts
templates/            prompts, kb skeleton, skills, CLAUDE.md, settings — copied
                      into a project's .charm/ on init
frieren.sh            project lifecycle (setup/build/test/install/kill)
charm.sh              run-from-source wrapper (forwards to src/cli.ts)
docs/                 full docs, organized by audience (see docs/README.md)
```

`.charm/` (created in a target project, not this repo) holds `tickets/` (both investigation
and implementation tickets), `COORDINATION.md`, the sqlite index, prompts, the durable
`kb/`, and per-session run state under `run/<uuid>/`.

## Build

See [docs/developing/build.md](docs/developing/build.md) for the full build matrix: host-arch builds, cross-compiling both
Mac architectures, `lipo` universal binaries, packaging, and macOS Gatekeeper handling. The
short version is `./frieren.sh build` (binaries → `dist/`) or `./frieren.sh install`.
