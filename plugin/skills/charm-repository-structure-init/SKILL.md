---
name: charm-repository-structure-init
description: Initialize a repo's structure — run charm init, scaffold docs/planning/ (PLAN.md, projects/, tdds/) with the PLAN → PRJ → TDD linking system, and set up commit conventions. Use when starting a new project repo, bootstrapping planning docs, adding the TDD/project planning structure to an existing repo, or establishing a commit message convention.
---

# Charm repository structure init

Bootstraps a repo so design work has a home: charm for the agent fleet, a
`docs/planning/` tree where a product plan, scoped projects, and subsystem TDDs
cross-link into one navigable system, and a commit convention that keeps the log
navigable by asset.

Run this **once per repo**. On a repo that already has `docs/planning/`, it fills
gaps and never overwrites — see [Idempotency](#idempotency).

## The linking system

Three document kinds, each owning a different altitude. The value is that every
document can be reached from every other one, so no doc is a dead end.

```text
PLAN.md            product intent, feature scope, long-term vision
   ↕
projects/PRJ-NNN   a scoped, deliverable slice of PLAN — what is being built NOW
   ↕
tdds/TDD-NNN       subsystem contracts and acceptance tests for one PRJ
```

| Document | Owns | Must link to |
| --- | --- | --- |
| `PLAN.md` | Product intent, goals, non-goals, architecture, feature scope, delivery order | `tdds/README.md`, the active `projects/PRJ-NNN` |
| `projects/README.md` | Numbering rules, the Active table | `PLAN.md`, `tdds/README.md`, every project |
| `projects/PRJ-NNN-*.md` | Scope in/out, why this shape, open decisions, first milestone | `PLAN.md`, every TDD it draws on |
| `tdds/README.md` | Current scope, build order, deferred set, platform baseline, shared rules | `PLAN.md`, the active project, every TDD |
| `tdds/TDD-NNN-*.md` | One subsystem's contracts, acceptance tests, decision-ready risks | `PLAN.md`, `TDD-000`, its dependency TDDs |

Rules that make it hold together:

- **`PLAN.md` is vision; a project is the delivery plan.** When a project narrows
  scope, it says so explicitly (`**Supersedes:** the full-product scope in PLAN.md`)
  rather than editing the vision down.
- **Numbers are permanent.** `PRJ-NNN` and `TDD-NNN` are assigned in creation order,
  never reused, renumbered, or reordered — not on completion, cancellation, split, or
  supersession. Titles change freely; numbers do not.
- **Status lives inside the document, never in the filename.** A doc changing state
  must not churn its path or break inbound links.
- **Supersede rather than rewrite** for a materially different bet: new number, and
  mark the old one `Superseded by PRJ-NNN`.
- **Deferred TDDs are not live contracts.** No active document may take a dependency
  on one, and no deferred schema is part of the contract bundle.
- **`TDD-000` is the contract authority.** A dependent TDD may add domain behavior but
  must not define a competing wire shape.

## Preflight

**1. Check the `charm` binary is on PATH.**

```sh
command -v charm
```

This skill ships inside the charm plugin, so its presence means the *plugin* was
installed — not necessarily that the binaries are reachable. `frieren.sh install`
writes the plugin to `~/.claude/skills/charm/` and the binaries to `~/.local/bin`;
those succeed and fail independently, and a stale plugin copy can outlive an
uninstalled binary. Check rather than assume.

If it resolves, continue. If not, stop. Do not install it yourself, and do not skip
`charm init` and scaffold the docs alone unless the user says to.

The usual cause is `~/.local/bin` missing from PATH — check that before suggesting a
reinstall:

```sh
echo "$PATH" | tr ':' '\n' | grep -c "$HOME/.local/bin"
ls ~/.local/bin/charm
```

If the binary is there, it's a PATH problem: add `~/.local/bin` and reopen the shell.
If it isn't, reinstall from the charm repo checkout:

```sh
./frieren.sh setup     # checks deps, runs bun install
./frieren.sh install   # binaries + templates → ~/.local/bin, plugin → ~/.claude/skills/charm/
```

Source: [Peter-Dated-Projects/2026-05-29_charm-claude-harness](https://github.com/Peter-Dated-Projects/2026-05-29_charm-claude-harness).
Requires the Claude Code CLI (`claude`), `tmux`, and Bun ≥ 1.1 on PATH. The sibling
binaries (`charmd`, `charm-mcp`, `charm-console`, `charm-graph`) must stay
co-located — `charm start` execs them by name.

Re-check `command -v charm` after they confirm, then continue.

**2. Confirm the repo root.** Run the rest from the git root
(`git rev-parse --show-toplevel`), not a subdirectory.

**3. Check what already exists** so you know what you're adding versus filling in:

```sh
ls -d .charm docs/planning docs/planning/projects docs/planning/tdds 2>/dev/null
```

## Steps

### 1. Run charm init

```sh
charm init
```

Additive or update only — it re-copies template tooling (`prompts/`, `CHARM.md`,
`charm.json`) and ensures the root `CLAUDE.md` imports it. It never deletes, and it
preserves `kb/`, `COORDINATION.md`, and `settings.json`. Safe to re-run.

If `charm init` fails, report the actual error and stop; don't hand-scaffold `.charm/`.

### 2. Create the directory tree

```sh
mkdir -p docs/planning/projects docs/planning/tdds docs/conventions
```

### 3. Copy the templates

Templates live in [templates/](templates/) next to this file. Copy each to its
destination **only if the destination does not exist**:

| Template | Destination |
| --- | --- |
| `templates/PLAN.md` | `docs/planning/PLAN.md` |
| `templates/projects-README.md` | `docs/planning/projects/README.md` |
| `templates/tdds-README.md` | `docs/planning/tdds/README.md` |
| `templates/PRJ-NNN-template.md` | `docs/planning/projects/_TEMPLATE.md` |
| `templates/TDD-NNN-template.md` | `docs/planning/tdds/_TEMPLATE.md` |
| `templates/commit-conventions.md` | `docs/conventions/commit-conventions.md` |

The two `_TEMPLATE.md` files stay in place as the source for new documents. They are
not numbered documents and never appear in an index table.

**The commit conventions need a decision, not just a copy.** The template ships an
`<area>(<scope>): <subject>` format with a starter area table. Before writing it:

- Check what the repo already does — `git log --oneline -30`. If it already follows a
  convention (Conventional Commits, ticket prefixes, anything consistent), say so and
  ask before imposing a different one. An existing convention beats a better one.
- Trim the area table to the kinds of asset this repo actually has. Rows nobody uses
  train people to ignore the whole file.
- If the repo is mostly application code on a conventional release process, say so and
  recommend standard Conventional Commits instead — the template says this itself, and
  the two formats do not mix.

Then link it from the root `README.md` or `CONTRIBUTING.md` if one exists. A convention
nobody can find is not a convention.

### 4. Fill the placeholders

Every template uses `{{DOUBLE_BRACE}}` placeholders. Resolve them from the repo and
from the user — never leave a `{{...}}` in a written file, and never invent a fact to
fill one.

| Placeholder | Resolve from |
| --- | --- |
| `{{PROJECT_NAME}}` | Repo name, or ask |
| `{{ONE_LINE_PREMISE}}` | Ask — one sentence on what the product does |
| `{{PLATFORM_BASELINE}}` | Ask — OS, hardware, and the constraint that actually binds |
| `{{TODAY}}` | Today's date, `YYYY-MM-DD` |

If the user can't answer one yet, write `TBD — <what decides it>` rather than a guess.
A placeholder filled with a plausible invention is worse than an honest TBD; the
planning docs are load-bearing for later design review.

The index templates ship with example rows pointing at `TDD-000-contracts.md` and
`PRJ-001-kebab-title.md`, which do not exist yet. Leave them as the row format if no
documents exist, or replace them with real links the moment the first one does — a
scaffolded index with dangling links is fine on day one and misleading on day two.

### 5. Report

Print the tree that now exists, name any file you skipped because it already existed,
and list every `TBD` you wrote so the user knows what's outstanding.

Do not commit. Leave the working tree for the user to review.

## Creating documents afterward

This skill scaffolds the system; it does not author content. Afterward:

- **New project:** next free `PRJ-NNN`, copy `projects/_TEMPLATE.md` to
  `projects/PRJ-NNN-kebab-case-title.md`, add a row to the Active table in
  `projects/README.md`, and link its TDDs both ways.
- **New TDD:** next free `TDD-NNN`, copy `tdds/_TEMPLATE.md` to
  `tdds/TDD-NNN-kebab-case-title.md`, add a row to the Build order table in
  `tdds/README.md`, and add it to the owning project's Related TDDs table.
- **Deferring a TDD:** move its row from Build order to Deferred with a stated reason,
  and confirm nothing active still depends on it.

Two sibling skills in this plugin, both separate from this one:
`charm:charm-feature-tdd` drafts an evidence-backed TDD;
`charm:charm-tdd-design-review` reviews one. This skill only builds the empty
structure — it deliberately does not author a document, because a scaffolded doc
full of invented content is harder to fix than an empty one.

## Idempotency

Re-running on an initialized repo must be safe:

- `charm init` is additive by design — just re-run it.
- Never overwrite an existing `PLAN.md`, `README.md`, or numbered document. Check
  first, copy only what's missing, and say what you skipped.
- If `docs/planning/` exists but a README is missing an index table the system needs
  (Active, Build order, Deferred), add the table without touching surrounding prose.
