# Commit conventions

Every commit message in this repo starts with a typed scope:

```text
<area>(<scope>): <subject>
```

The point is that `git log --oneline` should let you find the commit that touched a given
asset without opening any of them. `plugin(charm): ...` and `skill(charm-restart): ...` are
answering different questions — the first changed how the plugin is assembled or registered,
the second changed what one skill actually does.

## Areas

| Area | Covers | `<scope>` is |
| --- | --- | --- |
| `skill` | One skill under `plugin/skills/` — its `SKILL.md`, references, agents, assets | The skill's directory name, `charm-*` |
| `plugin` | The plugin as a whole — `plugin/.claude-plugin/plugin.json`, registration, install wiring, docs that enumerate skills | `charm` |
| `template` | Files under `templates/` that `charm init` copies into a project | The template file or group: `CHARM.md`, `prompts`, `kb`, `settings` |
| `script` | Shell and build entry points — `frieren.sh`, `charm.sh` | The script filename |
| `cli` | `src/cli.ts` — subcommands and flags | The subcommand: `init`, `start`, `tree` |
| `daemon` | `src/daemon/` — index, rpc, registry, solver, coord, tmux, layout, spawn, approvals | The module |
| `mcp` | `src/mcp/` — the tool surface exposed to agents | The tool or `server` |
| `console` | `src/console/` — the Ink TUI and graph viewers | The surface: `graph`, `app`, `mouse` |
| `docs` | `docs/` and the top-level `README.md` when not enumerating skills | The doc area: `operating`, `developing`, `design` |
| `kb` | `.charm/kb/` knowledge-base content | The KB section |
| `chore` | Dependencies, config, ignores, and anything with no user-visible behavior | The subsystem, or omit |

Add an area when a genuinely new kind of asset appears — the list is descriptive, not fixed.
Do not stretch an existing area to cover something it does not describe.

## Rules

- **One area per commit.** If a change spans a skill and the plugin manifest, that is two
  commits. Shared registration files (`plugin.json`, `README.md`, `templates/charm/CHARM.md`)
  belong to the `plugin(charm)` commit, not to each skill's.
- **One scope per commit** within an area. Five skills added at once is five `skill(...)`
  commits, not one `skill(several)`.
- **Subject is imperative and lowercase**, no trailing period: `add`, `move`, `remove`,
  `rename`, `fix` — not `added` or `Adds`.
- **Say what changed, not that something changed.** `skill(charm-restart): stop killing
  unticketed agents` beats `skill(charm-restart): update skill`.
- **Body explains why**, when the subject cannot carry it. Wrap at 72 columns. A commit that
  removes something should say what superseded it.

## Examples

```text
skill(charm-repository-structure-init): add repo and planning-docs scaffolding
skill(charm-tdd-design-review): move into the charm plugin
plugin(charm): register the repository-authoring skills
plugin(charm): remove the superseded .charm/skills copies
template(CHARM.md): split operator and repository-authoring skill tables
script(frieren.sh): enumerate installed skills instead of a hardcoded list
cli(tree): drop dangling depends_on edges instead of erroring
docs(developing): document the commit conventions
```

## Why not plain Conventional Commits

Conventional Commits types (`feat`, `fix`, `chore`, …) describe the *nature* of a change.
This repo's assets are heterogeneous — compiled TypeScript binaries, shell scripts, agent
prompts, Claude Code skills, and templates copied into other people's repos — and the useful
question when reading the log is almost always "which asset moved?", not "was it a feature or
a fix". Naming the asset in the area, and its identity in the scope, answers that directly.

`fix` and `feat` are recoverable from the subject line when they matter. `which skill changed`
is not recoverable from a `feat:` prefix.
