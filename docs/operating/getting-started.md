# Getting started

This walks you from a clean checkout to a charm session fanning workers out on a real goal.

## Requirements

- **Claude Code CLI** (`claude`) on PATH — charm launches `claude` processes as its agents.
  Install with `npm install -g @anthropic-ai/claude-code`.
- **tmux** on PATH at runtime — charm uses it as the pane substrate.
- **Bun** >= 1.1 to build or run from source (not needed once binaries are installed).

## Run from source (no install)

This is the fastest way to try charm without putting binaries on your PATH.

```sh
./frieren.sh setup                                 # checks deps, runs bun install
./charm.sh start "build a markdown to-do CLI"      # prompts research vs development mode
```

`charm.sh` is a thin wrapper that forwards to `src/cli.ts` through Bun, so every CLI command
in the [CLI reference](cli.md) works as `./charm.sh <command>`.

## Install globally

Build the standalone binaries and place them (plus the templates) on your PATH at
`~/.local/bin`:

```sh
./frieren.sh install
charm start "your goal"
```

After this, `charm` is a native binary with the Bun runtime embedded — no Bun, Node, or
toolchain needed at runtime, just `claude` and `tmux` on PATH. See [Build](../developing/build.md)
for the full build matrix.

## Your first session

`charm start "<goal>"` opens a tmux session with the console on the left and the main agent on
the right. From there:

1. **Discovery (Stage 0)** — the main agent interviews you and drafts `.charm/PROJECT.md`.
   Read it in the console's Artifacts tab and approve it when the brief is right.
2. **Planning (Stage 1)** — the main agent decomposes the goal into tickets. This flows
   automatically into review.
3. **Ticket review (Stage 2)** — reviewer agents enrich the tickets (scope, dependencies,
   file globs). Approve the enriched tickets when they look right.
4. **Development (Stage 3)** — worker agents fan out, each in its own pane, coordinating
   through `.charm/COORDINATION.md`.
5. **Test and review (Stage 4)** — tester agents check each finished ticket's diff. Approve
   the diff before it merges.

The full mechanics of each stage and gate are in [Running a session](running-a-session.md).

## In-session controls

Inside the tmux session, the `:` key opens a command prompt:

- `:q` — quit this charm (tears down only the session you pressed it in).
- `:a` — detach from the tmux session (it keeps running; re-`attach` later).
- `:dev` / `:research` — swap the whole fleet's model mid-session.

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
