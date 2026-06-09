# PROP-rust-rewrite

**Status:** draft

---

## Problem

The current harness is TypeScript + Bun. This is a ground-up rewrite in Rust as an
exploratory branch, to understand what the system would look like if built for
performance, static safety, and single-binary distribution from the start. The goal
is not to ship this immediately but to learn where Rust helps, where it fights back,
and whether the resulting binary is meaningfully better to use.

---

## Context / Findings

### What the harness actually is (the rewrite target)

Five separate binaries built from one codebase:

| Binary | Role | Key behavior |
| --- | --- | --- |
| `charm-claude` (CLI) | Entry point | `init`, `start`, `stop`, `list`, `attach` subcommands; scaffolds `.charm/`, mints session UUIDs, spawns the daemon, creates the tmux layout |
| `charmd` (daemon) | Core process | Unix socket JSON-RPC server; manages agent registry, ticket store (SQLite), tmux pane layout, approval queue, coordination board, agent spawning, orchestrator pings |
| `charm-mcp` (MCP server) | Claude Code bridge | stdin/stdout MCP protocol; folds `CHARM_AGENT_ID` into every tool call before forwarding to the daemon socket |
| `charm-console` (TUI) | Operator UI | Ink/React terminal app; three tabs (Artifacts / Approvals / Agents); polls daemon via RPC; file browser with live markdown viewer |
| `charm-graph` (graph viewer) | KB visualizer | Standalone process; raw ANSI + braille canvas; force-directed 3D physics sim at 12 FPS; live-watches the KB directory |

Supporting modules:
- `src/store/tickets.ts` - SQLite-backed ticket store; gray-matter frontmatter read/write; activity log append
- `src/daemon/tmux.ts` - tmux subprocess wrapper (split-window, send-keys, display-message, layout apply)
- `src/daemon/solver.ts` - dependency/touches conflict resolution for spawn scheduling
- `src/daemon/coord.ts` - COORDINATION.md writer (derived, rebuilt on every state change)
- `src/schema.ts` - Zod schemas for every RPC input and domain type

---

## Proposal

### Language version and toolchain

Rust stable (1.80+). Cargo workspace with one crate per binary, sharing a `charm-core`
library crate for the types, SQLite store, tmux wrapper, and RPC protocol.

```
charm-rewrite/
  Cargo.toml          (workspace)
  crates/
    charm-core/       (shared: types, store, tmux, rpc protocol)
    charm-cli/        (charm-claude binary)
    charmd/           (daemon binary)
    charm-mcp/        (MCP server binary)
    charm-console/    (TUI binary)
    charm-graph/      (graph viewer binary)
```

### Component mapping

#### charm-core (shared library)

**Types / schema** (`src/schema.ts` -> `charm-core/src/types.rs`)
- Rust enums and structs replace Zod schemas. No runtime validation needed; the type
  system enforces correctness at compile time.
- `serde` + `serde_json` for JSON serialization (the RPC wire format).
- `serde_yaml` for frontmatter parsing (replaces `gray-matter`).
- Custom `parse_frontmatter(raw: &str) -> Result<(Frontmatter, String)>` since
  gray-matter's YAML-fenced format isn't built-in to serde_yaml.

Key types: `TicketFrontmatter`, `Ticket`, `Agent`, `AgentRole`, `AgentState`,
`ApprovalGate`, `RpcRequest`, `RpcResponse`, all the input types.

**Ticket store** (`src/store/tickets.ts` -> `charm-core/src/store.rs`)
- `rusqlite` for SQLite. Same schema, same upsert logic.
- The activity log append (`appendToLogRegion`) is a pure string operation - direct
  port.
- Thread safety: wrap in `Arc<Mutex<TicketStore>>` for sharing across async tasks.

**Tmux wrapper** (`src/daemon/tmux.ts` -> `charm-core/src/tmux.rs`)
- `std::process::Command` for sync subprocess calls. The current TS version is also
  sync (spawnSync), so this is a direct port.
- `Tmux::split_pane`, `Tmux::send_text`, `Tmux::kill_pane`, `Tmux::apply_layout`,
  `Tmux::pane_index`, `Tmux::pane_width`, `Tmux::window_size`.

**RPC protocol** (`src/daemon/rpc.ts` -> `charm-core/src/rpc.rs`)
- Newline-delimited JSON-RPC over Unix domain socket.
- Server side: `tokio::net::UnixListener`, async read loop, newline framing.
- Client side: `tokio::net::UnixStream`, write request, read until newline.

**Paths** (`src/paths.ts` -> `charm-core/src/paths.rs`)
- `std::path::PathBuf` throughout.
- Session UUID keying for run dirs: same logic, direct port.

#### charmd (daemon)

The hardest crate to write. The daemon has significant shared mutable state
(agent registry, approval queue, tmux pane list, coordination writer) that is
mutated inside async RPC handlers.

Pattern: `Arc<Mutex<DaemonState>>` wrapping all mutable state, cloned into each
spawned Tokio task that handles an RPC connection.

```rust
struct DaemonState {
    store: TicketStore,
    registry: AgentRegistry,
    approvals: ApprovalQueue,
    coord: CoordinationWriter,
    tmux: Tmux,
    console_pane_id: Option<String>,
    agent_pane_ids: Vec<String>,
    orchestrator_pane_id: Option<String>,
    max_agents: usize,
}
```

The approval queue (`src/daemon/approvals.ts`) is the trickiest piece because
`await_approval` is a blocking async call that waits for a human decision. In the TS
version this uses a `Map<id, Promise resolve fn>`. In Rust: `tokio::sync::oneshot`
channels, one per pending gate. The queue holds the sender half; the RPC handler for
`approve_gate` sends on it; `await_approval` awaits the receiver half.

Orchestrator ping coalescing (the 1200ms debounce): `tokio::time::sleep` in a
spawned task, coalesced via a `tokio::sync::Notify` or a `tokio::sync::mpsc` channel.

Solver (`src/daemon/solver.ts` -> `charmd/src/solver.rs`): pure logic, no async,
direct port. Glob matching for `touches` conflict detection: `glob` crate.

#### charm-mcp (MCP server)

No mature official Rust MCP SDK exists as of mid-2025. Two options:

A. Use the community `rmcp` crate (github.com/modelcontextprotocol/rust-sdk). It's
   new and the API has been changing, but it covers tool definitions and JSON-RPC
   transport over stdio.

B. Implement the MCP stdio transport from scratch. It's newline-delimited JSON-RPC;
   the schema is stable. ~300 lines of Rust. The current TS MCP server is ~500 lines
   including all 20 tool definitions; most of that is just forwarding to the daemon.
   This is the more robust path.

Recommendation: implement from scratch. The protocol is simple; an external crate
adds a dependency on a moving target.

#### charm-console (TUI)

`ratatui` (formerly `tui-rs`) is the standard Rust TUI crate. It uses a retained-mode
widget model rather than React's virtual DOM, but the structure maps cleanly:

| Ink / React | Ratatui |
| --- | --- |
| `App` component with `useStatus` hook | Main loop; poll RPC on a tick |
| `Tab` state, `useInput` | `crossterm` key events in the event loop |
| `ArtifactsTab`, `ApprovalsTab`, `AgentsTab` | `Widget` impls rendering into `Frame` |
| File watcher with `chokidar` | `notify` crate |
| Markdown viewer (`renderMarkdown`) | `tui-markdown` crate or custom ANSI-stripped renderer |
| Mouse wheel (`useMouseWheel`) | `crossterm` mouse events |
| Terminal resize handling | `crossterm::event::Event::Resize` |

The Ink console's layout math (panel height accounting, viewer height, files panel
resize with +/-) maps to Ratatui layout constraints (`Layout::vertical`,
`Constraint::Length`, `Constraint::Min`). Less arithmetic needed; the layout engine
handles it.

#### charm-graph (graph viewer)

The graph viewer deliberately bypasses Ink for performance (raw ANSI, own stdout
control). The Rust port is the most natural rewrite: the braille canvas math, the
physics sim, and the ANSI string building are all pure computation that Rust handles
well with zero overhead.

The current 3D force-directed physics (`step` function) is a direct port to Rust
structs. The braille canvas (`Frame`, `dot`, `line`, `stamp`) maps to a plain struct
with a `Vec<u8>` for bits. `crossterm` for raw mode and cursor control replaces the
manual ANSI escape strings, though keeping the manual escapes is also fine.

File watching: `notify` crate with the same debounce pattern as the TS version.
Frontmatter parsing: `gray_matter` Rust crate or `serde_yaml`.

---

## The hard parts

### 1. Shared mutable state in async context

The daemon's `Arc<Mutex<DaemonState>>` means every RPC handler holds the lock for its
duration. For most handlers this is fine (fast, synchronous). The problem is
`await_approval`: it blocks for minutes waiting for a human. Holding the mutex that
long would deadlock every other RPC call.

Solution: the approval queue stores `oneshot::Sender<Decision>` values WITHOUT holding
the daemon lock. `await_approval` locks, extracts the receiver, unlocks, then awaits the
receiver outside the lock. `approve_gate` locks, pops the sender, unlocks, then sends.
This is idiomatic Rust for this pattern but requires getting the unlock/await ordering
right.

### 2. No official Rust MCP SDK

The MCP spec is stable but the Rust ecosystem around it is young. Writing the MCP
layer from scratch is ~300 lines and the spec is clear, but it's work that doesn't
exist in the TS version (the `@modelcontextprotocol/sdk` package handles it).

### 3. Frontmatter round-trip fidelity

The TS version uses `gray-matter` which preserves the original YAML block exactly on
parse and rewrites it cleanly on stringify. The Rust equivalent requires careful
handling: parse the `---`-fenced block, deserialize with `serde_yaml`, mutate, re-
serialize, and splice back. The activity log append is a string operation that never
touches the frontmatter, which helps. But the `update` path (status/stage changes)
must round-trip without mangling the existing body text or adding/removing whitespace
that would confuse agents reading the ticket file. Needs a test suite.

### 4. Ratatui's retained-mode vs React's component model

The Ink console is written as React components with hooks. Ratatui renders widgets
from scratch on every frame. The logic is the same but the structure differs: instead
of `useState` there's a plain `AppState` struct; instead of `useEffect` with a watcher
there's a background task that sends events over an `mpsc` channel into the main loop.
This is clean but requires rethinking the console's internal structure, not just
translating code.

---

## What you'd gain

- **Single static binary per tool.** No Bun runtime, no node_modules. `charm-claude` is
  one file you copy anywhere.
- **Genuine performance.** The graph viewer already runs well in TS but the physics sim
  would run 5-10x faster in Rust, allowing more nodes, higher FPS, or more complex
  layouts. For everything else (daemon RPC, SQLite) the difference is academic.
- **Compile-time safety.** The schema.ts Zod runtime checks become compile errors. A
  malformed `TicketFrontmatter` or wrong RPC response shape is caught at build time.
- **Memory footprint.** The daemon would use significantly less memory than a Bun process.
  Not a real constraint today but relevant if charm runs many sessions.

## What you'd lose or trade

- **Iteration speed.** Rust compile cycles (even with incremental builds) are slower than
  `bun run`. Adding a new RPC method in TS is 5 minutes; in Rust it's 15-20.
- **Borrow checker friction on async.** The daemon's shared mutable state is the hardest
  kind of Rust code to write. Expect to fight the compiler on the first pass.
- **Ink's React model.** The console is genuinely nicer to write as React components.
  Ratatui is powerful but more verbose and less compositional.
- **Ecosystem richness.** gray-matter, chokidar, commander, zod -- all mature, well-
  documented. The Rust equivalents are functional but younger and less polished.

---

## Alternatives Considered

- Rewrite only the daemon in Rust, keep the console in TS/Ink: mixed-language repo
  with two build pipelines. More work than either full rewrite.
- Use `wasm-pack` to compile the hot physics loop to WASM and call it from TS: way
  too much complexity for the gain.

---

## Effort Estimate

| Crate | Effort | Notes |
| --- | --- | --- |
| `charm-core` (types, store, tmux, rpc, paths) | Medium | Direct ports; SQLite and frontmatter need care |
| `charmd` (daemon) | Large | Shared async state, approval blocking, solver |
| `charm-mcp` | Medium | Implement MCP stdio from scratch |
| `charm-console` | Medium | Ratatui widget ports; structural rethink |
| `charm-graph` | Small | Most natural Rust port; raw math, direct |
| Tests + CI | Medium | Cargo test is great; set up a test harness for RPC |

Total: **large** (weeks, not days). Achievable as a focused exploration branch.

---

## Branch Strategy

```
git checkout -b rewrite/rust
```

Keep `.charm/` (tickets, KB, coordination) at the repo root as-is -- the rewrite uses
the same file formats. Build targets go in `rust/` at the repo root, keeping `src/`
(the TS source) untouched for comparison. The two implementations can run against the
same `.charm/` directory for side-by-side testing.

---

## Open Questions

- Which SQLite crate: `rusqlite` (CGO, robust) or `rusqlite` with `bundled` feature
  (static link, no system SQLite dependency)? Recommendation: `bundled` for portability.
- MCP: `rmcp` community crate vs. from-scratch implementation? Recommendation: scratch,
  given how much the crate API has been changing.
- Ratatui or `cursive` for the TUI? Ratatui has more momentum and better docs.
- Does the graph viewer keep manual ANSI escapes or adopt `crossterm`? Either works;
  `crossterm` is safer on non-xterm terminals.

---

## Status

draft
