# Windows Port Plan

Status: **Phases 1 & 2 landed and runtime-verified** (branch `charm-windows-port`).
charm runs natively on Windows end to end — headless core plus a native pane UI
via a pluggable multiplexer with a **psmux** backend. The full
`charm start → status → stop` lifecycle, pane execution on attach, and `send-keys`
delivery were all verified on native Windows (see "Runtime verification"). The
only thing not exercised here is a live attached run with a real `claude` agent
(token-spending user-acceptance test), but every mechanism it relies on is proven.

## Implementation status

| Phase | State | Notes |
|-------|-------|-------|
| Spikes | **done** | Named pipes work via Bun's `unix:` option on Windows; all 5 entrypoints `bun build --compile --target=bun-windows-x64` to runnable `.exe`. |
| Phase 0 — WSL stopgap | not started | Optional; superseded in practice by Phase 1+2. |
| Phase 1 — headless core | **done, verified** | Transport, spawn abstraction, signals/shutdown, binary resolution, PowerShell launchers — all landed and smoke-tested on native Windows. |
| Phase 2 — native pane UI | **done, runtime-verified** | `Multiplexer` abstraction with `TmuxBackend` + `PsmuxBackend`; CLI + daemon wired; typechecks, compiles to `.exe`. Backend: **psmux** (not WezTerm — see below). `charm start→status→stop`, pane execution on attach, and send-keys all verified on native Windows (see "Runtime verification"). Live `claude`-agent run is the only remaining user-acceptance step. |

**What landed in Phase 2:**

- **`src/daemon/multiplexer.ts`** — a `Multiplexer` interface (newSession,
  splitPane→paneId, spawnInWindow, killPane, sendText, paneAlive, relayout,
  attach, …) with two backends. The old `src/daemon/tmux.ts` `Tmux` class was
  refactored into `TmuxBackend` (verbatim behavior) and removed.
- **`PsmuxBackend`** (native Windows) — drives psmux, which ships a
  tmux-compatible CLI (also as `tmux`/`pmux`). Adaptations: panes run
  `-- pwsh -NoProfile -Command <serialized>` (via the new `serializeLaunchForPwsh`)
  instead of `sh -c`; `select-layout` uses the `main-vertical` preset (psmux has
  no custom layout strings); `paneAlive` checks `list-panes` membership (psmux's
  `display-message -t <bad id>` falls back to the active pane, so it can't detect
  a dead pane); `bindCommandPrompt` is a no-op (no command-prompt); `-l <size>`
  maps to `-p <percent>`.
- **Backend selection** — `createMultiplexer()` picks tmux on POSIX, psmux on
  Windows (probing `psmux`/`pmux`/`tmux`); `CHARM_MUX=tmux|psmux` overrides.
- **Pane spawns now carry a `LaunchSpec`** (`{argv, env, cwd}`) end to end — the
  Phase 1 spawn abstraction paying off: cli.ts and the daemon build argv+env and
  the backend serializes for its own shell. The console pane and main/sub agents
  all go through this.
- **Decision: psmux over WezTerm.** psmux is already installed
  (`cargo install psmux`) and its CLI is near-identical to tmux, so the backend
  reuses charm's existing verbs with minimal change. WezTerm remains a viable
  future backend behind the same interface. **Known limitation:** psmux runs pane
  processes only while a client is attached (it's a ConPTY renderer), so charm
  must be used attached; detaching pauses agents. Documented; acceptable for MVP.
- Verification: `scripts/spike-psmux-backend.ts` drives the real backend
  (session create, split→`%N`, paneAlive live-vs-dead, relayout, kill) — all
  accepted by psmux.

## Runtime verification (native Windows)

Runtime behavior — not just compilation — was exercised on native Windows.
psmux runs pane processes only while a client is attached, so the attach was
driven with `Start-Process psmux attach` (a real console window) and results
checked via filesystem side-effects:

- **`charm start → status → stop` lifecycle** (`charm.ps1 start --no-attach`):
  daemon spawns, mode resolves, the psmux session is created with both panes
  (console `%1`, main agent `%4`), `charm status` reaches the daemon **over the
  named pipe**, and `charm stop` gracefully shuts the daemon down and kills the
  session. End to end, no errors.
- **Pane executes on attach** (`scripts/spike-psmux-runtime.ts`, through the real
  `createMultiplexer`→`splitPane(LaunchSpec)` path): the launched command runs and
  writes its marker once a client attaches.
- **`send-keys` delivery**: a command typed into a pane via the backend's
  `sendText` executes — the wake/continue-agent mechanism works.
- **Bug caught and fixed by runtime testing:** the first attempt launched panes as
  `-- pwsh -NoProfile -Command <script>`. psmux joins the post-`--` tail into one
  string and runs it through its default shell as `powershell.exe -Command
  "<joined>"`, dropping per-arg quoting (and `pwsh` isn't installed — it falls
  back to Windows PowerShell). The agent command never ran. Fix: pass the launch
  as a **single self-contained PowerShell command string** after `--` and pin
  `default-shell` to `powershell`. Confirmed working after the fix. This is the
  kind of failure structural/compile checks miss — it only showed up on a live
  attach.

Not exercised here: a live attached run where a real `claude` agent works a
ticket (spends tokens; a user-acceptance step). Every mechanism it depends on —
daemon RPC, pane spawn, command execution on attach, send-keys, layout, teardown
— is verified above.

**What landed in Phase 1 (all verified on native Windows):**

- **Transport** — `paths.socket` is a named pipe (`\\.\pipe\charm-<hash>`) on
  Windows, a Unix socket elsewhere; both go through Bun's `unix:` option, so
  `rpc.ts` only had to guard stale-file cleanup (`isPipe()`). A new `ready`
  marker file replaces stat-ing the endpoint for readiness/liveness (a named
  pipe has no filesystem entry to stat). Verified: daemon ping / `create_tickets`
  (sqlite + gray-matter store) / `status` round-trip over the pipe.
- **Spawn** — `buildClaudeLaunch()` returns a structured `{ argv, env }`
  (`ClaudeLaunch`) as the backend-agnostic source of truth; `buildClaudeCommand()`
  is now a thin POSIX-shell serializer of it (`serializeLaunchForShell`) used only
  by the tmux backend. Removes the bash-only `export … && exec` assembly from the
  core.
- **Signals/shutdown** — `charm stop` prefers the graceful `shutdown` RPC (runs
  the daemon's cleanup: removes socket/ready/pidfile), required on Windows where
  `process.kill` terminates without running handlers. The daemon's startup guard
  is now liveness-aware: a stale pidfile naming a dead pid is cleared and the
  daemon starts (also fixes a latent `Number(Bun.file().text())` → NaN bug).
  Verified: graceful shutdown removes state; restart after a simulated hard kill
  recovers.
- **Binary resolution** — `Tmux.available()` probes `tmux -V` instead of `which`;
  sibling-binary resolvers (`resolveChild`, `graphBinArgs`) append `.exe` on
  Windows so compiled binaries find each other.
- **Launchers** — `charm.ps1` (forwards subcommands to `bun run src/cli.ts`) and
  `frieren.ps1` (setup/dev/build/typecheck/test/clean, plus **install/uninstall**).
  `frieren.ps1 install` builds the `.exe` set, places `charm` + siblings in
  `%LOCALAPPDATA%\charm\bin`, copies templates to `..\share\charm\templates`
  (matching the runtime `dirname(execPath)\..\share\charm` lookup), and adds the
  bin dir to the User PATH; `uninstall` reverses it. The MCP-shim command is
  written as `charm-mcp.exe` on Windows so an installed shim resolves when
  `claude` spawns it. The existing `package.json` build recipes already run on
  Windows via Bun's script shell and emit `.exe`. Both `.ps1` files are kept
  ASCII-only (Windows PowerShell 5.1 reads scripts in the ANSI codepage and
  garbles UTF-8 punctuation like em-dashes — a real parse-break, now avoided).
  Verified: `charm.ps1 init` scaffolds the full `.charm` tree; `status`,
  `frieren.ps1 typecheck`, and `install`→(compiled `charm.exe init` resolves
  templates)→`uninstall` all work.
- Verification scripts kept under `scripts/spike-*.ts`.

The original full design follows.

## TL;DR

charm runs today on macOS/Linux only. The blockers are all POSIX assumptions,
not anything fundamental:

1. **tmux** is the pane substrate (the big one).
2. **`sh -c` + POSIX shell command strings** are how every agent process is launched.
3. **Unix-domain sockets** are the daemon RPC transport.
4. **bash launcher/installer scripts** (`charm.sh`, `frieren.sh`).
5. A handful of smaller things: `which`, signal semantics, the macOS-only
   "open a new terminal window" used by the graph viewer.

The plan splits the work into a **headless core** (items 2–5: make the daemon,
CLI, MCP shim, and console run on native Windows) and the **pane UI** (item 1:
the expensive part). The recommended native answer for the pane UI is a
**pluggable multiplexer abstraction** with a **WezTerm backend** — WezTerm runs
natively on Windows and its `wezterm cli` gives us addressable panes,
`send-text`, `kill-pane`, and `list`, which is everything the tmux integration
needs. WSL2 is the zero-effort day-one stopgap.

---

## 1. Inventory of platform couplings

Every place the codebase assumes POSIX, with the file and what it does.

| # | Coupling | Files | What breaks on native Windows |
|---|----------|-------|-------------------------------|
| 1 | **tmux** session/pane/layout/send-keys | `src/daemon/tmux.ts` (all of it), `src/daemon/layout.ts` (tmux custom-layout checksum strings), callers in `src/cli.ts` and `src/daemon/index.ts` | No native tmux on Windows. The entire visible multi-pane UX. |
| 2 | **`sh -c` + POSIX command strings** | `src/daemon/spawn.ts` `buildClaudeCommand` (emits `export VAR=… && exec claude …`, single-quote `shellQuote`); `Tmux.splitPane/newWindow/spawnInWindow` pass `"sh", "-c", cmd` | No `sh` on Windows; `export`/`exec`/`&&` chaining and single-quote quoting are bash-isms. |
| 3 | **Unix-domain socket RPC** | `src/daemon/rpc.ts` (`Bun.listen({unix})`, `Bun.connect({unix})`); consumed by `src/cli.ts`, `src/console/app.tsx`, `src/mcp/server.ts`; path `paths.socket = .charm/sock` | Bun's `unix:` socket support on Windows is unreliable; `.charm/sock` is a filesystem path. |
| 4 | **`which tmux`** | `src/daemon/tmux.ts` `Tmux.available()` | `which` isn't a Windows command. |
| 5 | **macOS-only "new terminal window"** for the graph viewer | `src/daemon/index.ts` `graphLaunchSpec` (osascript/AppleScript; throws on non-darwin without `CHARM_GRAPH_TERMINAL_CMD`) | No osascript; no Windows path at all. |
| 6 | **bash launcher + installer** | `charm.sh`, `frieren.sh` | `set -euo pipefail`, `readlink`, `find`, `xargs`, `install`, `cp -R`, `~/.local/bin`. None run in PowerShell/cmd. |
| 7 | **signals / `process.kill`** | `src/daemon/index.ts` (`SIGINT`/`SIGTERM`), `src/graph-viewers.ts` (`process.kill(pid)`, `process.kill(pid,0)` liveness), `src/cli.ts stop` | `SIGTERM` is emulated on Windows and doesn't run graceful handlers the same way; otherwise mostly OK. |
| 8 | **build scripts** | `package.json` (`mkdir -p && cd dist && bun build …`) | `mkdir -p`/`cd` chaining — but Bun's built-in script shell handles these cross-platform, so likely fine. `--target=bun-windows-x64` exists. |

### What is already cross-platform (no work needed)

- **`bun:sqlite`** (`src/store/tickets.ts`) — works on Windows.
- **`chokidar`** file-watching (`src/console/app.tsx`) — cross-platform.
- **Ink** TUI rendering — cross-platform; runs in Windows Terminal/WezTerm.
- **ANSI mouse escapes** (`src/console/mouse.ts`, SGR `?1006h`) — supported by
  Windows Terminal and WezTerm.
- **`isCompiled()`** in `src/cli.ts` and `graphBinArgs()` in the daemon
  **already** check for the Windows bunfs marker `B:/~BUN/` — someone
  anticipated this. Path joins use `node:path`, which is separator-aware.

---

## 2. Architecture of the port

Two independent workstreams. The headless core is required for *any* native
path and is where most of the durable value is. The pane UI is the part with a
real design fork.

```
                    ┌─────────────────────────────────────────┐
                    │  Headless core (Phase 1)                  │
                    │  • Transport abstraction (socket→pipe/TCP)│
                    │  • Spawn abstraction (sh -c → argv)        │
                    │  • which→cross-platform lookup, signals   │
                    └───────────────────┬───────────────────────┘
                                        │ enables
                    ┌───────────────────┴───────────────────────┐
                    │  Multiplexer abstraction (Phase 2)         │
                    │  interface Multiplexer { newSession,        │
                    │    splitPane→paneId, killPane, sendText,    │
                    │    listPanes, focus, layout, attach … }     │
                    ├──────────────┬──────────────┬──────────────┤
                    │  TmuxBackend │ WezTermBackend│ ConPtyBackend│
                    │  (mac/linux) │  (native Win, │  (native Win,│
                    │   existing)  │  RECOMMENDED) │   fallback)  │
                    └──────────────┴──────────────┴──────────────┘
```

---

## 3. Phase 0 — WSL2 stopgap (ship in an afternoon)

Goal: charm runs on a Windows machine *today*, with effectively no code change,
by running the existing Linux build inside WSL2.

- Inside a WSL2 distro: install `bun`, `tmux`, and `claude`; run
  `./frieren.sh setup` / `./frieren.sh start "goal"` exactly as on Linux.
- Add `scripts/charm.ps1` — a thin PowerShell launcher that shells into WSL:
  `wsl.exe -d <distro> -- bash -lc "cd <wsl-path>; ./charm.sh $args"`.
- Document the caveats: agents run in the *Linux* userland (so `claude` and the
  project toolchain must be installed in WSL), and the project must live on a
  path WSL can see (ideally the WSL filesystem, not `/mnt/c`, for fs-watch and
  speed). `wsl.exe` is already present on this machine.

Deliverables: `scripts/charm.ps1`, a "Run on Windows (WSL)" README section.
Effort: ~0.5 day. Risk: low. This unblocks users immediately while the native
port lands.

---

## 4. Phase 1 — Native headless core

Make `charmd`, `charm`, `charm-mcp`, and `charm-console` run as native Windows
processes. After this phase everything works on native Windows **except** the
visible pane layout (covered in Phase 2). This is the foundation and is backend-
agnostic.

### 4.1 Transport: replace the Unix-domain socket

`src/daemon/rpc.ts` is the single chokepoint — every other file goes through
`startRpcServer` / `rpcCall`. Options:

- **TCP on `127.0.0.1:<port>`** (simplest, fully cross-platform). Write the
  chosen port to `.charm/port` (next to where `paths.socket` is today) so the
  CLI/console/MCP shim discover it. `CHARM_SOCKET` env (read by the MCP shim)
  becomes `CHARM_ENDPOINT` carrying `tcp://127.0.0.1:<port>` or the pipe name.
- **Windows named pipe** (`\\.\pipe\charm-<hash>`) on Windows, Unix socket
  elsewhere. Bun supports both `Bun.listen({unix})` and Windows named pipes via
  the same `unix:` option pointing at a `\\.\pipe\…` path on Windows — verify
  this against the installed Bun version before committing.

Recommendation: **named pipe on Windows, Unix socket on POSIX**, selected by
`process.platform`, behind a tiny `endpoint(paths)` helper in `src/paths.ts`.
Keeps the "no TCP port to leak / firewall-prompt" property. Fall back to TCP
loopback if Bun's Windows pipe support proves flaky. The newline-delimited
JSON-RPC framing on top is unchanged.

Touch: `src/paths.ts` (add `endpoint`/`port` resolution), `src/daemon/rpc.ts`
(branch on endpoint kind), `src/daemon/spawn.ts` (`CHARM_SOCKET`→`CHARM_ENDPOINT`),
`src/mcp/server.ts`, `src/cli.ts` `waitForSocket` (wait for the port file or
pipe), `src/console/app.tsx`.

### 4.2 Spawn: replace `sh -c` + POSIX command strings

Today `buildClaudeCommand` returns a single bash string
(`export A=… && export B=… && exec claude '<arg>' …`) that tmux runs via
`sh -c`. On Windows there is no `sh`, and the env-export + quoting is bash-only.

Refactor to **structured spawn specs** instead of a shell string:

```ts
type LaunchSpec = {
  argv: string[];                 // ["claude", "-p", "--model", "…", …]
  env: Record<string,string>;     // CHARM_AGENT_ID, CHARM_ENDPOINT, MAX_THINKING_TOKENS, …
  cwd: string;
};
```

The multiplexer backend is then responsible for turning a `LaunchSpec` into a
running pane in a platform-correct way:

- tmux backend: `tmux split-window … <argv…>` (tmux execs argv directly; no
  `sh -c` needed) and sets env via `-e KEY=VAL` flags.
- WezTerm backend: `wezterm cli spawn --cwd … -- <argv…>`, env via the spawned
  process environment.

This removes `shellQuote` and the `export … && exec` assembly entirely, which is
cleaner on *every* platform (no quoting bugs). `claude` resolves as `claude.cmd`/
`claude.ps1` on Windows — see 4.4.

Touch: `src/daemon/spawn.ts` (return `LaunchSpec`, drop shell-string assembly),
`src/daemon/tmux.ts` and the new backends (consume `LaunchSpec`).

### 4.3 Signals & process lifecycle

- `src/daemon/index.ts`: keep `SIGINT`; add Windows-safe shutdown. On Windows,
  `SIGTERM` from `charm stop`/`process.kill` won't run the graceful handler the
  same way — rely on the `shutdown` RPC (already implemented) as the primary
  clean-exit path, and treat signal handlers as best-effort.
- `src/graph-viewers.ts`: `process.kill(pid, 0)` liveness check and
  `process.kill(pid)` both work on Windows under Bun/Node; verify. Consider
  `taskkill /PID` as a hard fallback.
- `src/cli.ts stop`: same — prefer the `shutdown` RPC over raw signals.

### 4.4 Misc fixes

- `Tmux.available()` `which tmux` → cross-platform binary lookup (`where` on
  Windows, or just attempt the version command and catch ENOENT). Generalize to
  `multiplexer.available()`.
- `claude` resolution: on Windows the CLI is `claude.ps1`/`claude.cmd`
  (`%APPDATA%\npm\claude.ps1` on this machine). `Bun.spawn`/argv launches need
  the `.cmd`/`.ps1`, or invocation via the shell. Add a `resolveClaudeBin()`
  helper.
- Graph viewer "new OS window" (`graphLaunchSpec`): add a Windows branch that
  uses `wt.exe` (Windows Terminal) or `wezterm start --`, alongside the existing
  macOS osascript. The `CHARM_GRAPH_TERMINAL_CMD` escape hatch already exists.

### 4.5 Build & scripts

- Port `frieren.sh` / `charm.sh` to **`frieren.ps1` / `charm.ps1`** (or a small
  cross-platform Node/Bun script `scripts/charm.mjs` invoked by both a `.sh` and
  a `.ps1` shim, to avoid maintaining two copies of the logic). The installer's
  PATH target on Windows becomes e.g. `%LOCALAPPDATA%\charm\bin` plus a
  `share\charm\templates` sibling, matching the existing `../share/charm`
  runtime lookup.
- `package.json` build scripts: confirm `mkdir -p && cd dist && bun build` runs
  under Bun's script shell on Windows (it should); otherwise replace with a
  Bun build script. Add `--target=bun-windows-x64` recipes producing `.exe`
  outputs (`charm.exe`, `charmd.exe`, `charm-mcp.exe`, `charm-console.exe`,
  `charm-graph.exe`).

Effort: ~3–5 days. Risk: medium (transport choice is the main unknown — pin it
with a Bun named-pipe spike first). Exit criterion: `charm status`,
`create_tickets`, the full RPC surface, and the console TUI all work natively on
Windows when driven headless (no panes), proven by a smoke test that starts the
daemon, registers a fake pane, and exercises every RPC method.

---

## 5. Phase 2 — Native pane UI (the multiplexer)

### 5.1 The abstraction

Extract a `Multiplexer` interface from today's `Tmux` class. The method set the
codebase actually uses (from `tmux.ts` callers in `cli.ts` and `index.ts`):

```ts
interface Multiplexer {
  available(): boolean;
  newSession(window: string, cwd: string): void;
  hasSession(): boolean;
  killSession(): void;
  splitPane(spec: { launch: LaunchSpec; direction?: "h"|"v"; target?: string; size?: string }): string; // → paneId
  spawnInWindow(window: string, launch: LaunchSpec): string;   // main agent
  killPane(paneId: string): void;
  sendText(paneId: string, text: string): void;               // wake/continue agents
  selectPane(paneId: string): void;
  listPanes(): { pane_id: string; pid: number; cmd: string }[];
  attach(): void;
  relayout(panes: PaneLayout): void;                          // replaces buildLayoutString
  windowSize(window: string): { w: number; h: number };
  bindCommandPrompt?(cmdTemplate: string): void;              // optional (the `:` quit binding)
}
```

`TmuxBackend` = today's class, near-verbatim. The daemon and CLI select a
backend at startup (`CHARM_MUX=tmux|wezterm|conpty`, default by platform).

The one piece that does **not** port directly is `src/daemon/layout.ts` — those
are tmux-specific custom-layout *checksum strings*. `relayout` becomes a backend
method: tmux keeps emitting layout strings; WezTerm builds the layout
imperatively by computing split percentages and issuing `split-pane` calls.

### 5.2 Recommended backend: **WezTerm** (native, full fidelity)

WezTerm runs natively on Windows and ships `wezterm cli`, which maps cleanly
onto the interface:

| charm op | WezTerm CLI |
|----------|-------------|
| split a pane, get its id | `wezterm cli split-pane --pane-id <parent> --horizontal --percent N -- <argv…>` → prints new pane id |
| spawn main pane | `wezterm cli spawn --cwd <dir> -- <argv…>` → pane id |
| send text / wake agent | `wezterm cli send-text --pane-id <id> --no-paste <text>` (append `\r` to submit) |
| kill a pane | `wezterm cli kill-pane --pane-id <id>` |
| list panes (id, pid, size, cwd, title) | `wezterm cli list --format json` |
| focus a pane | `wezterm cli activate-pane --pane-id <id>` |
| keep dead panes visible | `exit_behavior = "Hold"` in wezterm config |
| mouse | native |

Why WezTerm over the user-suggested alternatives:

- **WezTerm** ✅ — native Windows, addressable panes, `send-text`/`kill-pane`/
  `list` via `wezterm cli`. Preserves the "type into a pane to wake an agent"
  mechanism (`pingOrchestrator`, `continue_agent`) that the orchestration
  depends on. Bonus: the same backend works on macOS/Linux, so it could
  eventually *replace* the tmux backend rather than just sit beside it.
- **Zellij** ⚠️ — no real native-Windows support today; on Windows it's WSL
  underneath, which is just Phase 0. Set aside.
- **psmux** ⚠️ — a Rust, PowerShell-oriented tmux-like, installed via
  `cargo install psmux` (see setup note below). Worth a fidelity spike as a
  second native backend, but unproven here for the bits charm leans on hardest:
  stable pane ids out of `split`, reliable `send-keys` to a *specific*
  backgrounded pane, and custom multi-pane layouts. Treat as a candidate to
  validate, not the primary, until those are confirmed.

**Installing psmux on Windows** (cargo/Rust required):

1. Open <https://doc.rust-lang.org/cargo/getting-started/installation.html>
2. Download the Windows installer (`rustup-init.exe`) and complete installation.
3. Open a new terminal and run: `cargo install psmux`

(`cargo`/`rustup` downloads were historically blocked on the original build
machine — see the README's "Context" — so this manual installer route is the
reliable path on Windows.)

Caveat: layout control in WezTerm is imperative (sequential percentage splits),
not declarative like tmux's layout strings, so the VS-Code-grid relayout logic
in `src/daemon/index.ts` `relayout()` must be reimplemented as a split plan in
`WezTermBackend.relayout`. The user runs charm *inside* WezTerm (it is both the
emulator and the mux). Requires installing WezTerm — same class of dependency as
requiring tmux today.

Effort: ~4–6 days (the abstraction + a faithful WezTerm backend + relayout).

### 5.3 Fallback backend: in-app ConPTY multiplexer

If depending on an external multiplexer is unacceptable, the console (Ink) app
becomes a mini-multiplexer: it hosts child PTYs via ConPTY (node-pty), renders
each agent's output in a tiled layout itself, routes focus, and the daemon wakes
an agent by writing to its PTY stdin (cleaner than send-keys). This is true
parity with **no external dependency**, but it is by far the most work: PTY
lifecycle, a terminal-emulator render path inside Ink, focus/resize handling.
Risk multiplier: `bun build --compile` embedding a **native** `.node` addon
(node-pty) is fragile — may force shipping the Windows build as `bun run` over
source, or a Node+pkg variant, rather than a single compiled binary.

Recommend only if WezTerm-as-a-dependency is rejected. Effort: ~2–3 weeks.

---

## 6. Recommended sequencing

1. **Phase 0 (WSL stopgap)** — ship now; unblocks Windows users immediately.
2. **Phase 1 (headless core)** — the durable, backend-agnostic foundation; also
   improves the POSIX code (kills the shell-string quoting). Gate on a Bun
   named-pipe-vs-TCP spike.
3. **Phase 2 with the WezTerm backend** — native pane UI, full orchestration
   fidelity, cross-platform bonus.
4. **ConPTY backend** — only if a zero-external-dependency native build is
   required.

## 7. Open questions / spikes

- ~~**Bun named pipes on Windows**~~ — **RESOLVED**: `Bun.listen/connect({ unix:
  "\\\\.\\pipe\\…" })` works on Bun 1.3.9 (Windows x64). Implemented; no TCP
  fallback needed. (`scripts/spike-transport.ts`)
- ~~**`bun build --compile --target=bun-windows-x64`**~~ — **RESOLVED**: all five
  entrypoints compile to runnable `.exe`, including the Ink/React console
  (`--external react-devtools-core`). The compiled CLI runs (`--version`/`--help`).
- **WezTerm `cli` fidelity** (Phase 2): confirm `split-pane` returns a stable pane id,
  `send-text` reaches a backgrounded pane, and `list --format json` gives pid +
  geometry. (half day)
- **`claude` on Windows under a multiplexer**: confirm an interactive
  `claude.cmd`/`claude.ps1` runs correctly inside a WezTerm pane and accepts
  injected `send-text`. (1–2 hr)
