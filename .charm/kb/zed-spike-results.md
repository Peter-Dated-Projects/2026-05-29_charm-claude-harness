# Zed-fork de-risk spikes -- results

Resolves the three cross-cutting prototype risks from the build-plan README
("Cross-cutting open questions") and HANDOFF ("de-risk these THREE prototype
risks"). All three were run against a real Zed checkout.

## Setup

- Forked `zed-industries/zed` (shallow) into a sibling checkout `zed-charm`.
- `rust-toolchain.toml` pins Rust **1.95.0**; rustup auto-fetched it (host had
  1.96.0). No version conflict in practice.
- Build prereqs present and working on this macOS host: cmake 4.3.4, Metal
  toolchain. A clean `gpui` example build + Metal shader compile succeeds, which
  itself de-risks the native build path.

## Spike 1 -- multi-line text injection (was: "does bare input() handle newlines?")

RESOLVED at source; the plan's worry is already handled by an existing API.

- `Terminal::input(impl Into<Cow<'static,[u8]>>)` (crates/terminal/src/terminal.rs)
  is RAW -- writes straight to the PTY, no newline handling.
- `Terminal::paste(&str)` is the smart path. When the terminal is in
  bracketed-paste mode it wraps the text:
  `format!("{}{}{}", "\x1b[200~", text.replace('\x1b',""), "\x1b[201~")`,
  otherwise it converts `\n`/`\r\n` to `\r`.

Conclusion: the bridge should call `terminal.paste(text)` for multi-line agent
injection, NOT raw `input()`. This is exactly the bracketed-paste wrapping the
old tmux path needed -- Zed already implements it. The phase-4 note to "wrap
bytes in ESC[200~ .. ESC[201~" is correct but reinvents `paste()`.

Remaining runtime confirmation (needs a full editor build, not done in this
spike): verify claude's REPL actually enables `TermMode::BRACKETED_PASTE` so the
wrapping branch is taken. `paste()` degrades gracefully either way.

## Spike 2 -- create_terminal signature (custom command, not default shell)

RESOLVED at source. The plan named two candidates; both are stale for this
pinned version.

- The plan's `project.create_terminal(TerminalKind::Shell(..), ..)` does NOT
  exist. `create_terminal` was split into:
  - `Project::create_terminal_task(spawn_task: SpawnInTerminal, cx) -> Task<Result<Entity<Terminal>>>`
    (crates/project/src/terminals.rs:64) -- the right call: carries a full
    command spec.
  - `Project::create_terminal_shell(cwd, cx)` -- default shell only, no command.
- `SpawnInTerminal` lives in crates/task/src/task.rs:42 and derives `Default`.
  Relevant fields: `command: Option<String>`, `args: Vec<String>`,
  `env: HashMap<String,String>`, `cwd: Option<PathBuf>`, `shell: Shell`, plus
  label/strategy fields covered by `..Default::default()`.
- The plan's other candidate, `terminal_panel.spawn_task(&SpawnInTerminal)`, is
  not the project-level entry point; `create_terminal_task` is.

This also answers the plan's open sub-question "does the spawn return a handle
suitable for terminal.input() injection?" -- YES, `create_terminal_task` yields
`Entity<Terminal>` directly, which is what the bridge registers in its
`agent_id -> Entity<Terminal>` map.

Note: `create_terminal_task` returns the `Entity<Terminal>` but does not add it
to a pane / wrap it in a `TerminalView`; the workspace/terminal_panel side still
owns placing it in the agents pane.

## Spike 3 -- canvas performance at 15+ agents

RESOLVED by benchmark. PASS with large margin.

Wrote `crates/gpui/examples/charm_canvas_bench.rs`: a charm-realistic scene --
1 orchestrator card + 15 agent cards in 3 worktree-group outlines, 15 straight
connectors via `PathBuilder::stroke`, and 15 traveling flow dots animated every
frame (`window.request_animation_frame()` loop). It self-measures per-frame time
and exits after 360 frames.

Result (UNOPTIMIZED debug build):

```
scene: 16 cards, 15 connectors, 15 traveling dots
avg: 8.44 ms  (~118 fps)   p50: 8.33   p95: 9.33   max: 22.57
frames over 16.7ms (60fps budget): 2 / 299 (0.7%)
```

~118fps in debug, not vsync-capped (so real headroom, not a 60fps ceiling). The
2 over-budget frames are startup. Release will be faster. The card-flow canvas
comfortably clears 60fps at the v1 fleet size; the perf risk is closed. The
`fill()`/`outline()`/`quad()` free fns + `paint_path(PathBuilder)` are the
confirmed primitives for Phase 3.

## API primitives confirmed for the phases (this Zed version)

- Terminal injection: `Terminal::paste(&str)` (multi-line), `Terminal::input(bytes)` (raw).
- Terminal spawn: `Project::create_terminal_task(SpawnInTerminal, cx)` -> `Task<Result<Entity<Terminal>>>`.
- Canvas: `PathBuilder::stroke(px)` / `PathBuilder::fill()`, `window.paint_path(path, color)`,
  `window.paint_quad(quad)`, and the `fill`/`outline`/`quad`/`hsla` free fns
  (re-exported at the gpui crate root).
