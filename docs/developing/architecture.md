# Architecture

Charm is one repo that compiles to several co-located binaries. They cooperate over a
per-session Unix socket to run a fleet of real `claude` processes on a single shared git tree.

## The binaries

Each entrypoint in `src/` compiles to its own native binary via `bun build --compile`, and
they must be co-located on PATH — `charm start` execs its siblings, and every `claude`
resolves `charm-mcp` by name.

| Binary | Source | Role |
|---|---|---|
| `charm` (CLI) | `src/cli.ts` | operator entry point: `init`, `start`, `stop`, `attach`, `resume`, `status`, `approve`, `restart`, `reset-kb`. `start` spawns the daemon and console, opens the tmux layout, and launches the main agent |
| `charmd` (daemon) | `src/daemon/` | the long-running brain: ticket store, agent registry, dep/scope solver, coordination file, tmux layout. Talks to agents over a per-session Unix socket with a JSON line protocol |
| `charm-mcp` (MCP shim) | `src/mcp/server.ts` | a thin stdio MCP server spawned by **every** `claude` process via `.charm/charm.json`. Exposes the charm tools and forwards each call to the daemon over the socket |
| `charm-console` (TUI) | `src/console/` | an Ink (React-for-the-terminal) app pinned to the left pane: live, fs-watched viewer for `PROJECT.md`, `COORDINATION.md`, and tickets, plus the approval gates |
| `charm-graph` | `src/console/graph.ts`, `src/graph-viewers.ts` | a standalone animated force-directed view of the ticket/dependency graph, opened in its own window via the `open_graph` tool |

## How a session is wired

```
  charmd  (Bun + TypeScript daemon)
    - ticket store (.md files + bun:sqlite index)
    - agent registry + dep/file-scope solver
    - .charm/COORDINATION.md writer
    - tmux pane/layout manager
    - Unix-socket JSON-RPC
        |
        |  one charm-mcp shim per claude process, over the socket
        |
   +----+--------------------------------+
   | charm-mcp (stdio MCP server)         |  exposes charm tools, forwards to daemon
   +----+--------------------------------+
        |
   +--------+-------------+-------------+
 [main]  [reviewer-1]  [worker-A]   [worker-B]    <- real `claude` processes,
                                                     each in its own tmux pane

  tmux window:  console pane (left)  +  agent grid (right)

  charm-graph  <- standalone animated force-directed graph viewer,
                  opened in its own terminal window via the `open_graph` tool
```

Every `claude` process is a real, first-class agent you can watch stream in its own pane and
drop into by hand. This is the deliberate opposite of Claude Code's built-in subagent tool,
which hides subagents inside the parent process.

## The daemon

`charmd` owns all shared state. Its modules under `src/daemon/`:

- `index.ts` — the daemon process and its lifecycle.
- `rpc.ts` — the Unix-socket JSON line protocol the MCP shims talk.
- `registry.ts` — the live agent registry (who is running, in what role, on which ticket).
- `solver.ts` — the dependency + file-scope solver (`graphology` + `graphology-dag`) that
  decides which tickets may run concurrently. Two workers whose `touches` globs overlap are
  serialized; `depends_on` edges are honored the same way.
- `coord.ts` — the `.charm/COORDINATION.md` reader/writer (the soft coordination layer).
- `tmux.ts` / `layout.ts` — pane and layout management.
- `spawn.ts` — spawning `claude` and the sibling binaries, with claim handling so two ticks
  can't double-spawn the same ticket.
- `approvals.ts` — the blocking human gates (stages 0, 2, 4).

Test files sit next to the modules they cover (`*.test.ts`).

## Coordination on one tree

All agents work on one shared tree by default. Safety comes from two layers, described in
full in [Running a session](../operating/running-a-session.md):

1. **Hard layer** — the solver refuses overlapping `touches` scopes and unmet `depends_on`.
2. **Soft layer** — every worker reads and writes `COORDINATION.md` before touching anything.

### Worktrees (optional, orchestrator-managed)

Git worktrees are an opt-in side tool for non-overlapping parallel branches that need full
checkout isolation — for example, separate feature branches or Graphite stacked PRs. The
orchestrator creates and tears them down via `create_worktree` / `list_worktrees` /
`close_worktree`; they live under `.charm/worktrees/<name>/` on their own branch. Worktrees
are not the default execution model: the shared-tree approach covers the common case, and
worktrees are added only when the orchestrator explicitly decides a line of work needs its
own isolated checkout. See [docs/operating/worktrees.md](../operating/worktrees.md).

## The ticket store

Tickets live as markdown files in `.charm/tickets/` with `gray-matter` frontmatter. The
`bun:sqlite` database is **only an index** over those files — the `.md` files are the source
of truth. Frontmatter is validated with `zod` (`src/schema.ts`): `id` (`T-###`), `title`,
`status`, `stage`, `depends_on`, and `touches`. See `src/store/tickets.ts`.

Statuses and stages, and how they map onto the pipeline, are documented in
[Running a session](../operating/running-a-session.md#ticket-lifecycle).

## Per-session isolation

Each session is keyed by a fresh UUID. Its socket, pidfile, daemon log, and metadata live
under `.charm/run/<uuid>/`, and the tmux session name carries the UUID. Multiple sessions
never collide, and tearing one down (`:q` / `charm stop`) affects only that session.

## The durable knowledge base

`.charm/kb/` is a git-tracked, cross-session knowledge base (architecture, decisions,
conventions, gotchas, domain glossary) that survives between runs. It is the one part of
`.charm/` the optional `.gitignore` setup keeps tracked — everything else under `.charm/` is
ephemeral run state. Its layout and schema are specified in [Knowledge base design](knowledge-base.md).

## Tech stack

| Layer | Choice |
|---|---|
| Runtime / language | Bun + TypeScript, several entrypoints via `bun build --compile` |
| CLI parsing | `commander` |
| MCP server | `@modelcontextprotocol/sdk` (official TS SDK), stdio transport |
| Pane substrate | tmux (shell-out), required at runtime |
| Daemon RPC | Unix socket + JSON line protocol, per session |
| Process spawn | Bun / `node:child_process` |
| Ticket index | `bun:sqlite` (built-in); `.md` files are the source of truth |
| Dep + scope solver | `graphology` + `graphology-dag` |
| Frontmatter | `gray-matter` |
| File watching | `chokidar` (console auto-refresh) |
| Console / graph TUI | Ink + React, `marked` |
| Schema validation | `zod` (RPC envelopes, MCP tool I/O, frontmatter) |

Bun was chosen over the original Rust plan because `bun build --compile` produces single-file
native binaries with the runtime embedded (no Node/Bun needed at runtime), the MCP TypeScript
SDK is the canonical reference implementation, and `bun:sqlite` is built in.
