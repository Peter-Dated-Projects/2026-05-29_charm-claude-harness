# PROP-go-rewrite

**Status:** draft

---

## Problem

The current harness is TypeScript + Bun. This is a ground-up rewrite in Go as an
exploratory branch. Go is the natural language for this kind of tool: CLI programs,
long-running daemons, concurrent servers, and TUI apps are all first-class citizens in
the Go ecosystem. The Charm team (charm.land) built the exact suite of TUI libraries
that maps to what this harness needs. The goal is to understand what the system would
look like if it spoke the same language as its TUI framework.

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
- `src/daemon/tmux.ts` - tmux subprocess wrapper
- `src/daemon/solver.ts` - dependency/touches conflict resolution
- `src/daemon/coord.ts` - COORDINATION.md writer
- `src/schema.ts` - Zod schemas for every RPC input and domain type

### Why Go fits this project especially well

Three things line up:

1. **Goroutines are exactly the right concurrency model for the daemon.** The daemon
   handles concurrent RPC connections, a ping coalescing timer, file watchers, and
   tmux subprocess calls. In TypeScript this runs on a single async event loop (fine
   but awkward for blocking calls). In Go each RPC connection is a goroutine, channels
   handle coalescing, and the whole thing reads like sequential code.

2. **Bubble Tea (bubbletea) is built for exactly the console.** The charm.land TUI
   suite (Bubble Tea + Lip Gloss + Bubbles + Glamour) is the canonical way to write
   a rich, composable terminal UI in Go. The console's tab model, file browser, and
   markdown viewer map directly to Bubble Tea's component architecture.

3. **The Go ecosystem has everything this project needs, mature.** `cobra` for CLI,
   `modernc.org/sqlite` for SQLite without CGO, `gopkg.in/yaml.v3` for frontmatter,
   `fsnotify` for file watching, `mcp-go` for the MCP protocol, `gonum/graph` or
   plain adjacency lists for the KB graph. None of these are experimental.

---

## Proposal

### Language version and module structure

Go 1.22+. One Go module at the repo root (`go.mod`), multiple `cmd/` directories for
the five binaries, shared packages under `internal/`.

```
charm-rewrite-go/
  go.mod
  go.sum
  cmd/
    charm/          (charm-claude binary: main.go)
    charmd/         (daemon binary: main.go)
    charm-mcp/      (MCP server binary: main.go)
    charm-console/  (TUI binary: main.go)
    charm-graph/    (graph viewer binary: main.go)
  internal/
    types/          (domain types: Ticket, Agent, ApprovalGate, RpcRequest/Response)
    store/          (SQLite ticket store)
    tmux/           (tmux subprocess wrapper)
    rpc/            (Unix socket JSON-RPC client and server)
    paths/          (path resolution, session UUID layout)
    solver/         (dependency + touches conflict resolver)
    coord/          (COORDINATION.md writer)
    frontmatter/    (gray-matter-compatible YAML frontmatter parser/writer)
```

### Component mapping

#### internal/types

Go structs with `encoding/json` tags replace Zod schemas. No runtime validation;
the compiler enforces struct fields. Custom validators (e.g. ticket ID format
`T-\d{3,}`) live as constructor functions that return errors.

```go
type TicketStatus string
const (
    StatusPending  TicketStatus = "pending"
    StatusReady    TicketStatus = "ready"
    StatusRunning  TicketStatus = "running"
    StatusBlocked  TicketStatus = "blocked"
    StatusComplete TicketStatus = "complete"
    StatusFailed   TicketStatus = "failed"
    StatusCancelled TicketStatus = "cancelled"
)

type TicketFrontmatter struct {
    ID        string       `yaml:"id" json:"id"`
    Title     string       `yaml:"title" json:"title"`
    Status    TicketStatus `yaml:"status" json:"status"`
    Stage     TicketStage  `yaml:"stage" json:"stage"`
    DependsOn []string     `yaml:"depends_on" json:"depends_on"`
    Touches   []string     `yaml:"touches" json:"touches"`
}
```

The `RpcRequest` and `RpcResponse` types use `json.RawMessage` for the `params`/
`result` fields, same as the TS version's `z.unknown()`.

#### internal/frontmatter

The key shared utility. `gray-matter` handles YAML-fenced frontmatter
(`--- ... ---`) and round-trips it cleanly. Go's `gopkg.in/yaml.v3` does the YAML
part; frontmatter splitting and re-joining is a small custom parser (split on `---`
lines, unmarshal the middle section, return body string separately). The activity log
append (`appendToLogRegion`) is a direct string port.

This needs a table-driven test suite covering: empty body, existing log region,
malformed frontmatter, Unicode in titles, and multi-line bodies.

#### internal/store

`modernc.org/sqlite` (pure Go, no CGO required) for SQLite. Same schema and upsert
logic as the TS version. `sync.Mutex` for thread safety.

The `TicketStore` in Go is nearly a line-for-line port of the TS class:
`Create`, `Read`, `Update`, `AppendLog`, `QueryIndex`, `List`, `ReindexAll`.

One Go-specific detail: `database/sql` with the modernc driver, or use the
`modernc.org/sqlite` package directly. The `database/sql` path is more idiomatic
Go but adds a small abstraction layer. Either works.

#### internal/tmux

Direct port of `src/daemon/tmux.ts`. All methods call `exec.Command("tmux", ...)`.
The TS version is sync (`spawnSync`); Go's `exec.Cmd.Output()` is also sync. No
goroutines needed here.

```go
type Tmux struct { session string }
func (t *Tmux) SplitPane(cmd, cwd, direction, target string) (string, error)
func (t *Tmux) SendText(paneID, text string) error
func (t *Tmux) KillPane(paneID string) error
func (t *Tmux) ApplyLayout(window, layout string) error
func (t *Tmux) PaneIndex(paneID string) (int, error)
func (t *Tmux) PaneWidth(paneID string) (int, error)
func (t *Tmux) WindowSize(window string) (w, h int, err error)
```

#### internal/rpc

Newline-delimited JSON-RPC over Unix socket.

Server: `net.Listen("unix", socketPath)`, one goroutine per connection, read lines
with `bufio.Scanner`, dispatch to handler, write response.

Client: `net.Dial("unix", socketPath)`, write request line, read response line.

The server handler signature mirrors the TS version:
```go
type Handler func(ctx context.Context, method string, params json.RawMessage) (interface{}, error)
```

#### cmd/charmd (daemon)

Go's concurrency model is a better fit for the daemon than either TS or Rust.

The daemon's shared state is protected by a `sync.Mutex` (or broken into finer-
grained locks). Each RPC connection runs in its own goroutine; handlers lock, act,
unlock.

The `await_approval` blocking call is cleanly handled with channels:
```go
type pendingApproval struct {
    gate ApprovalGate
    ch   chan ApprovalDecision
}
```
`AwaitApproval` registers a `pendingApproval`, then blocks on `<-ch` outside the
lock. `ApproveGate` sends on the channel. No lock held during the wait.

Orchestrator ping coalescing (1200ms debounce): a goroutine with a `time.AfterFunc`
that resets on each ping event. Events are sent over a buffered channel; the goroutine
drains the channel after the timer fires and sends one message.

Agent registry (`src/daemon/registry.ts`): a Go `map[string]*Agent` protected by
`sync.RWMutex`. `RLock` for reads, `Lock` for mutations. More granular than a single
daemon-wide mutex.

Solver (`src/daemon/solver.ts`): pure logic, no goroutines. Direct port using
`path.Match` (stdlib) for glob matching.

#### cmd/charm-mcp (MCP server)

`github.com/mark3labs/mcp-go` is a community Go MCP library that covers tool
registration and stdio transport. It's reasonably mature (used in production Go MCP
servers as of mid-2025).

Alternative: implement from scratch as with the Rust proposal. The MCP stdio
protocol is newline-delimited JSON-RPC, the same as the daemon's internal RPC.
~200 lines of Go. Given Go's straightforward JSON and io handling, from-scratch is
a realistic fallback if `mcp-go`'s API is inconvenient.

The MCP server's job is simple: define 20 tools, fold `CHARM_AGENT_ID` into the
params, forward to the daemon socket. The tool definitions are boilerplate; the
actual logic is one forwarding function.

#### cmd/charm-console (TUI)

This is where Go's ecosystem advantage is most visible. Bubble Tea is exactly right
for this console:

| Ink / React (current) | Bubble Tea equivalent |
| --- | --- |
| `App` component, `useState` | `Model` struct, `Update(msg) (Model, tea.Cmd)` |
| `useStatus` polling hook | `tickMsg` command on a timer, dispatched via `tea.Every` |
| `Tab` state | field on `Model`, switch in `View()` |
| `useInput` | `KeyMsg` in `Update` |
| `ArtifactsTab`, `ApprovalsTab`, `AgentsTab` | separate sub-models, composed in `View()` |
| File watcher (`chokidar`) | `fsnotify.Watcher` in a goroutine, sends `fileChangedMsg` |
| Markdown viewer | `glamour.Render()` - Glamour is the charm.land markdown renderer |
| Terminal resize | `tea.WindowSizeMsg` built into Bubble Tea |
| Mouse wheel | `tea.MouseMsg` built into Bubble Tea |
| `ink-box` borders | `lipgloss.NewStyle().Border(...)` |
| Tab bar styling | `lipgloss.NewStyle().Foreground(...).Background(...)` |

Bubble Tea's Elm-style architecture (Model/Update/View) is more explicit than React
hooks but equally composable. Each tab is its own sub-model with its own Update
function; the root model delegates to the active tab.

The current console's layout math (panel heights, viewer rows, files panel resize)
maps to Bubble Tea's `lipgloss` layout:
```go
lipgloss.JoinVertical(lipgloss.Left, filesPanel, viewerPanel)
```
Height allocation uses `lipgloss.Height()` for measurement and explicit
`Style.Height(n)` constraints instead of the manual `rowHeight - chrome` arithmetic.

Glamour handles the markdown rendering that `src/console/markdown.tsx` currently
implements by hand (parsing marked tokens and rendering colored spans). Glamour
renders to a styled ANSI string; Bubble Tea displays it in a `viewport.Model`
(a Bubbles component that handles scroll natively).

The result is noticeably less code than the current console. The current `app.tsx`
is 460 lines of careful layout math and manual scroll state. The Bubble Tea version
would be roughly the same line count but most of it is application logic, not
rendering plumbing.

#### cmd/charm-graph (graph viewer)

The graph viewer does not use any TUI framework (not even Ink currently). It owns
stdout directly for frame-rate reasons. The Go port keeps the same approach.

The 3D force-directed physics (`step` function), braille canvas (`Frame`, `dot`,
`line`, `stamp`), 3D-to-2D projection, and ANSI string building are pure computation.
Direct line-for-line port to Go structs and methods. No goroutines needed; the render
loop is a single goroutine doing everything sequentially (physics steps, render,
write), same as the TS version.

`golang.org/x/term` or `os/signal` for raw terminal mode.
`fsnotify` for live KB directory watching with debounce, replacing the TS `fs.watch`.
`gopkg.in/yaml.v3` + the `internal/frontmatter` package for KB note parsing.

---

## The hard parts

### 1. Bubble Tea's Elm architecture requires structural rethinking

Bubble Tea's `Update(msg) (Model, tea.Cmd)` is a pure function -- the model is
immutable and you return a new one. The current console's Ink components are mutable
React state with hooks. This is a different mental model: instead of `setScroll(n)`
you return a new model with the scroll field updated. It's clean and testable but
requires rethinking, not just translating.

The trickiest part is async operations (RPC calls). In Ink these are `useEffect`
hooks with `async` callbacks. In Bubble Tea they are `tea.Cmd` functions that return
a `tea.Msg` when complete. The pattern is:
```go
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
    switch msg := msg.(type) {
    case tickMsg:
        return m, fetchStatus(paths) // returns a tea.Cmd that fires an rpcResultMsg
    case rpcResultMsg:
        m.status = msg.status
        return m, nil
    }
}
```
Once you internalize this, it's straightforward. But it's a learning curve if you're
coming from React.

### 2. Frontmatter round-trip

Same concern as the Rust proposal. `gopkg.in/yaml.v3` preserves field ordering and
comments when marshaling if you use the `yaml.Node` API (lower-level). For this use
case the simpler `yaml.Marshal`/`yaml.Unmarshal` with struct tags is sufficient, since
the frontmatter only contains known typed fields (no freeform YAML). But needs testing.

### 3. No `bun:sqlite` convenience

The TS version uses `bun:sqlite` which is built into Bun -- no dependency, no CGO,
instant startup. `modernc.org/sqlite` is pure Go (no CGO) but is a third-party
dependency with a larger binary. The alternative, `mattn/go-sqlite3`, requires CGO
which complicates cross-compilation. Recommendation: `modernc.org/sqlite` and accept
the larger binary.

### 4. MCP tool registration verbosity

The current `charm-mcp` defines 20 tools, each with a JSON schema for its input. In
TS with the MCP SDK this is relatively terse. In Go with `mcp-go` the tool
definitions are more explicit (struct-per-tool with explicit field descriptors).
It's more code but also more readable. Not a blocker, just overhead.

---

## What you'd gain

- **Bubble Tea console.** The biggest UX win. A proper Glamour-rendered markdown viewer,
  `viewport.Model` for scroll with no manual math, `list.Model` for the file browser
  and agent list with built-in selection and filtering, `huh` forms for a settings UI.
  The console becomes much less code and much more capable.
- **Goroutine concurrency.** The daemon's concurrent structure (RPC connections,
  timers, file watchers) reads naturally as goroutines + channels. No async/await
  gymnastics; just `go func()` and `<-ch`.
- **Static binaries.** `go build -ldflags="-s -w"` produces lean static binaries with
  no runtime dependency. Smaller than Rust (no LLVM backend overhead on binary size)
  but not as tiny as Rust.
- **Fast compile times.** Go's compiler is famously fast. Incremental builds for a
  project this size are under 2 seconds. Faster iteration than Rust by a significant
  margin.
- **Readable concurrent code.** The daemon's approval queue, ping coalescing, and
  agent registry in Go are all idiomatic, readable patterns. A new contributor
  understands them faster than the equivalent TS async code.

## What you'd lose or trade

- **TypeScript's type inference.** Go's type system is explicit and verbose compared
  to TypeScript. Generic functions exist in Go 1.18+ but the ecosystem hasn't fully
  adopted them; helper utilities that are one-liners in TS (`.map`, `.filter`,
  `Object.entries`) are longer in Go.
- **npm ecosystem breadth.** `gray-matter`, `chokidar`, `commander` are extremely
  polished. The Go equivalents (`fsnotify`, `gopkg.in/yaml.v3`, `cobra`) are mature
  but have rougher edges.
- **Ink's React model for the console.** Bubble Tea is the right replacement but it
  is a different paradigm. The current Ink console is familiar to anyone who knows
  React. The Bubble Tea console will need to be learned.
- **Zod runtime validation.** Go structs with JSON tags give you compile-time type
  checking but no runtime validation of e.g. regex patterns on ticket IDs. Custom
  validator functions fill the gap but add boilerplate.

---

## Alternatives Considered

- Rewrite only the console in Go (Bubble Tea), keep the daemon in TS: the console
  connects to the daemon via the same socket RPC. This is actually a viable partial
  migration -- the protocol is already a clean interface. But it defeats the point of
  a clean rewrite.
- Use `wails` (Go + Web frontend) instead of Bubble Tea: different direction, more
  like the Electron path. Out of scope for a terminal-native rewrite.

---

## Effort Estimate

| Package | Effort | Notes |
| --- | --- | --- |
| `internal/` shared packages | Medium | Types, store, tmux, rpc, paths, frontmatter |
| `cmd/charmd` (daemon) | Medium | Goroutines make this cleaner than TS; approval queue needs care |
| `cmd/charm-mcp` | Small | mcp-go or 200-line from-scratch; mostly boilerplate |
| `cmd/charm` (CLI) | Small | cobra is fast; mostly porting subcommand logic |
| `cmd/charm-console` (TUI) | Medium | Bubble Tea learning curve; Glamour saves the markdown work |
| `cmd/charm-graph` | Small | Pure computation; direct port |
| Tests + CI | Small | Go's testing package is excellent; table-driven tests for frontmatter |

Total: **medium-large** (1-2 weeks of focused work). Faster than the Rust rewrite
because the language is simpler and the ecosystem gaps are smaller.

---

## Branch Strategy

```
git checkout -b rewrite/go
```

Go source lives in `go/` at the repo root (keeping `src/` for the TS version).
Same `.charm/` file formats -- the Go rewrite reads and writes the same ticket
files, KB, and coordination board. Both implementations can run against the same
`.charm/` directory for side-by-side comparison.

---

## Open Questions

- `modernc.org/sqlite` vs `mattn/go-sqlite3`: pure-Go vs CGO. Recommendation:
  `modernc.org/sqlite` for ease of cross-compilation.
- `mcp-go` vs from-scratch MCP: check whether `mcp-go`'s API is stable enough as of
  the branch start date. If it's changed significantly in the last 6 months, go
  from-scratch.
- Bubble Tea v2 (currently in beta) vs v1: v2 has a cleaner API but is not stable.
  Recommendation: v1 for the rewrite; v2 migration is a separate step.
- Does the graph viewer adopt `tcell` or `termbox-go` for raw mode, or keep manual
  ANSI escape codes? Manual ANSI is simpler and already proven in the TS version.

---

## Status

draft
