# Charm documentation

Charm turns one goal into a visible fleet of `claude` processes working a shared git
tree in parallel, with a human approval gate between each stage. For the high-level pitch,
architecture diagram, and tech stack, start with the [top-level README](../README.md).

These docs are organized by what you are trying to do.

## Operating charm (you run it on your projects)

- [Getting started](operating/getting-started.md) — install, then drive your first session end to end.
- [Running a session](operating/running-a-session.md) — the five-stage pipeline, the approval gates, and what you do at each one.
- [Modes and models](operating/modes-and-models.md) — research vs. development, the per-fleet model pin, and swapping mid-session.
- [CLI reference](operating/cli.md) — every `charm` subcommand and flag.
- [Console keybindings](operating/keybindings.md) — every keystroke the console TUI responds to.
- [Troubleshooting](operating/troubleshooting.md) — wedged sessions, the panic button, recovery, common failure modes.

## Developing charm (you hack on it)

- [Architecture](developing/architecture.md) — the four binaries, the daemon, the socket protocol, the ticket store, and how a session is wired together.
- [MCP tools](developing/mcp-tools.md) — the full tool surface charm exposes to agents, who may call each, and what it does.
- [Build](developing/build.md) — the build matrix: host-arch builds, cross-compiling, universal binaries, packaging, Gatekeeper.
- [Knowledge base design](developing/knowledge-base.md) — the durable, git-tracked `.charm/kb/` cross-session memory: layout and schema.
- [Preflight](developing/preflight.md) — a repeatable smoke test that exercises every built-in feature of the harness.

## Design notes (the thinking behind the harness)

- [Parallelization strategies](design/parallelization.md) — how to decide what fans out vs. runs serially.
- [Phasing and sequencing](design/phasing-sequencing.md) — defining phases and gates in an orchestration skill.

## A note on these docs

The top-level [README](../README.md) is the canonical overview and is kept current with the
shipping behavior. Where a doc here and the README disagree about how something works, the
code at `HEAD` wins — verify against `src/` before trusting any prose. The `design/` notes
are research and rationale, not a spec of current behavior; they may describe paths not taken.
