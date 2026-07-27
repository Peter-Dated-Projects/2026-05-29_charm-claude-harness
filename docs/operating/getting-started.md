# Getting started

This walks you from a clean checkout to a charm session fanning workers out on a project.

## Requirements

- **Claude Code CLI** (`claude`) on PATH — charm launches `claude` processes as its agents.
  Install with `npm install -g @anthropic-ai/claude-code`.
- **tmux** on PATH at runtime — charm uses it as the pane substrate.
- **Bun** >= 1.1 to build or run from source (not needed once binaries are installed).

## Run from source (no install)

This is the fastest way to try charm without putting binaries on your PATH.

```sh
./frieren.sh setup                                 # checks deps, runs bun install
./charm.sh init
./charm.sh start --project                         # pick (or create) a project brief
```

`charm.sh` is a thin wrapper that forwards to `src/cli.ts` through Bun, so every CLI command
in the [CLI reference](cli.md) works as `./charm.sh <command>`.

## Install globally

Build the standalone binaries and place them (plus the templates) on your PATH at
`~/.local/bin`:

```sh
./frieren.sh install
charm init
charm start --project
```

After this, `charm` is a native binary with the Bun runtime embedded — no Bun, Node, or
toolchain needed at runtime, just `claude` and `tmux` on PATH. See [Build](../developing/build.md)
for the full build matrix.

## Your first session

`charm start --project` opens a tmux session with the console on the left and the main agent on
the right, anchored to a project brief under `.charm/project-briefs/`. From there:

1. **Investigation (Stage 1)** — the main agent opens investigation tickets and fans out
   investigator agents that gather context and propose a fix, writing their findings into
   each ticket. This stage has no human gate.
2. **Planning / synthesis (Stage 2)** — the main agent reads the findings and authors
   worker (implementation) tickets with scope, dependencies, and file globs, then renders
   the plan. Approve the worker-ticket plan when it looks right.
3. **Development (Stage 3)** — worker agents fan out, each in its own pane, coordinating
   through `.charm/COORDINATION.md`.
4. **Test and review (Stage 4)** — tester agents check each finished ticket's diff. Approve
   the diff before it merges.

The full mechanics of each stage and gate are in [Running a session](running-a-session.md).

## In-session controls

Inside the tmux session, the `:` key opens a command prompt:

- `:q` — quit this charm (tears down only the session you pressed it in).
- `:a` — detach from the tmux session (it keeps running; re-`attach` later).
- `:so` / `:so c` — spawn a Claude Sonnet suborchestrator (the default).
- `:so g` — spawn a GPT Terra suborchestrator.
- `:cursor` / `:so u` — spawn an operator-only Cursor specialist pane (a bare
  Cursor CLI session in the project root for fast research/navigation). It joins
  the grid and counts toward `--max-agents`, but it is **not** a fleet subagent:
  no Charm MCP, no tickets, no coordination.

The complete keymap is in [Console keybindings](keybindings.md).

## When something wedges

If a session gets stuck, the panic button kills every charm process on the machine while
sparing your other (non-charm) `claude` sessions:

```sh
./frieren.sh kill
```

See [Troubleshooting](troubleshooting.md) for less drastic recovery paths first.

## What to read next

- [Concepts](concepts.md) — definitions for every term used in the pipeline (session, ticket, gate, fleet, KB, and more).
- [Running a session](running-a-session.md) — the full mechanics of each stage and gate: what happens automatically, what you approve, and what the agents are doing.
- [CLI reference](cli.md) — every `charm` subcommand and flag.
- [Troubleshooting](troubleshooting.md) — common failure modes, wedged sessions, and recovery paths.
