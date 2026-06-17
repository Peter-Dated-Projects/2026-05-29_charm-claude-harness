# Project Knowledge Base — Design Spec

> Status: **current**

## Why this exists

Today every per-project file Charm writes lives under `.charm/` and is **ephemeral run
state**: `PROJECT.md` (this session's brief), `tickets/`, `COORDINATION.md`, `prompts/`,
`db.sqlite`, `logs/`. All of it describes *the current run* and goes stale the moment the
session ends.

There is no layer that **accumulates across sessions** — no place where durable
understanding of the project lives and survives. So every planning session starts cold:
the discovery agent re-interviews the human, re-derives the architecture, and re-learns the
same constraints it learned last time, burning context to rebuild knowledge it already had.

The Knowledge Base (KB) is the missing **durable layer**. It sits beside the ephemeral run
state and grows as Charm works the repo. The longer Charm operates on a project, the more it
knows relative to a cold-start agent.

## The mechanic we're borrowing: atomic notes + summaries + thin indexes

This design is lifted from atomic-note knowledge systems (Zettelkasten-style). The core
machine has three parts:

1. **Atomic notes** — one concept per note. A note answers exactly one question.
2. **A `summary` in every note's frontmatter** — one self-contained sentence, readable
   *without opening the body*. This is the most important field.
3. **Thin index files** that list notes *by their summaries*.

The payoff is **context economy**. An agent navigates the KB by reading a tiny index, then a
root index, then opening only the one or two notes whose summary matches the task — instead of
re-reading the codebase. For a human this is convenience; for an agent it's the difference
between spending 2k tokens and 40k tokens to orient.

## Layout

The KB is nested under `.charm/` but is the one durable child. Run state stays ephemeral.

```
.charm/
├── PROJECT.md            # ephemeral — this session's brief
├── tickets/              # ephemeral
├── COORDINATION.md       # ephemeral
├── prompts/              # ephemeral (regenerated)
├── db.sqlite             # ephemeral
├── logs/                 # ephemeral
└── kb/                   # DURABLE — the knowledge base (tracked in git)
    ├── INDEX.md          # tiny always-read entry index; lists the roots
    ├── architecture/
    │   ├── _index.md     # root index: this root's notes, by summary
    │   └── <note>.md
    ├── decisions/
    │   ├── _index.md
    │   └── NNNN-<slug>.md
    ├── conventions/
    │   ├── _index.md
    │   └── <note>.md
    ├── gotchas/
    │   ├── _index.md
    │   └── <note>.md
    └── domain/
        ├── _index.md
        └── <note>.md
```

Two-tier navigation (`INDEX.md` → root `_index.md` → note) keeps every file an agent reads
small. No file in the read path should ever be large.

### Required gitignore change

`.charm/` is currently fully ignored (`.gitignore`). To make the KB durable and shareable
while keeping run state untracked, replace the single `.charm/` line with:

```gitignore
.charm/*
!.charm/kb/
```

`.charm/*` ignores the direct children (run state); `!.charm/kb/` re-includes the KB
directory and everything under it. This is the standard git negation idiom — it works only
because `.charm/` itself is not excluded, just its children.

**Without this change the KB never gets committed and the whole feature is local-only.**

## Root taxonomy — fixed core, open extension

Five fixed default roots, chosen to organize *understanding of a codebase* (not a human's
life, which is what general-purpose note vaults optimize for):

| Root | Holds |
|---|---|
| `architecture` | How the system is actually built — components, data flow, the mental model |
| `decisions` | ADR-style: what we chose and **why** (e.g. the Bun-over-Rust call) |
| `conventions` | Patterns and idioms *this specific repo* follows |
| `gotchas` | Traps, flaky behavior, non-obvious constraints |
| `domain` | Glossary — what the project's terms actually mean |

These five are the defaults and should cover most needs. An agent **may** add a new root
directory when something genuinely doesn't fit any of them — but adding a root is a
deliberate act: create the dir, give it an `_index.md`, and add its row to `INDEX.md`. Don't
spawn roots casually; prefer fitting a note into an existing root.

## Note frontmatter schema

Every note (excluding `INDEX.md` and `_index.md`) carries:

```yaml
---
id: <kebab-slug>          # stable identifier; matches the filename without .md
root: architecture        # which root this note lives in
type: architecture | decision | convention | gotcha | domain
status: current | stale | superseded
summary: "One self-contained sentence — the navigation surface."
related:                  # KB-relative paths, no .md extension; optional
  - decisions/0003-bun-over-rust
created: YYYY-MM-DD        # immutable, set once
updated: YYYY-MM-DD
---
```

Field notes:

- **`summary`** is the field that makes the whole system work. It must be accurate and stand
  on its own — a reader decides whether to open the note based on this line alone.
- **`status`** is the rot defense. A decision that gets reversed flips to `superseded` (not
  deleted — keep the audit trail) with `related` pointing at its replacement. `stale` flags a
  note that's suspected out of date but not yet reverified.
- **`related`** uses plain KB-relative paths, not `[[wikilinks]]` — this KB is read by agents
  via Read/grep, not by an Obsidian graph. Inline body links use ordinary markdown relative
  links for the same reason.

## File naming

Lowercase kebab-case filenames (`spawn-model.md`, `tmux-pane-layout.md`). No Title Case, no
spaces in filenames — machine-friendly, and avoids the case/space filesystem hazards that
human-edited vaults hit. Decisions get a zero-padded numeric prefix, ADR-style:
`0001-single-git-tree.md`, `0002-bun-over-rust.md`.

## Index file formats

`kb/INDEX.md` — the always-read entry point, kept tiny:

```markdown
# Project Knowledge Base

Durable, cross-session understanding of this project. Read this first; open notes by summary.

| Root | Notes | What it holds |
|---|---|---|
| [architecture](architecture/_index.md) | 4 | How the system is built |
| [decisions](decisions/_index.md)       | 6 | What we chose and why |
| [conventions](conventions/_index.md)   | 3 | Repo patterns and idioms |
| [gotchas](gotchas/_index.md)           | 5 | Traps and non-obvious constraints |
| [domain](domain/_index.md)             | 2 | Glossary of project terms |
```

Each root's `_index.md` — lists that root's notes by summary:

```markdown
# Architecture

| Note | Summary | Status |
|---|---|---|
| [spawn-model](spawn-model.md) | Each agent is a real `claude` process in its own tmux pane | current |
| [coordination-file](coordination-file.md) | Workers declare in-flight plans in a file-locked COORDINATION.md | current |
```

## Navigation SOP (read path)

1. Read `kb/INDEX.md` (tiny — always first).
2. Pick the relevant root; read its `_index.md`.
3. Open only the 1–2 notes whose summary matches the task.

Never bulk-read the KB. If you find yourself opening more than a couple of notes, the index
summaries aren't doing their job — fix the summaries.

## Write-back loop

A KB that nothing maintains rots, and a KB the agent trusts but that lies is **worse than no
KB**. The discipline that keeps it alive:

- When an agent learns something durable, it writes/updates one atomic note, updates that
  root's `_index.md` row, and bumps `updated`.
- Discovery (Stage 0) **seeds** the KB and **reads** it to avoid re-asking what's already
  known. Workers (Stage 3) **append** gotchas and decisions they hit during implementation.
- Reversing a decision: flip the old note to `status: superseded`, point its `related` at the
  replacement — don't delete.

## What we deliberately dropped

From the human-vault patterns this borrows from, we left behind the ceremony that doesn't earn
its keep for an agent-managed, repo-scoped KB:

- **Git pre/post-flight rules** — Charm already manages commits.
- **B-tree "split at 200 entries" discipline** — a project KB rarely reaches that scale; revisit
  if a root saturates.
- **Title Case naming** — replaced with machine-friendly kebab-case.
- **Daily Notes / Backlog / Goals roots** — those organize a human's life, not a codebase.

## Implementation status

All three original follow-ups are shipped:

1. **Apply the gitignore negation** — done. `charm start` calls `maybeConfigureGitignore()` on
   first run, which appends `.charm/*` / `!.charm/kb/` to the project's `.gitignore`.
2. **Scaffold `kb/` on `charm init`** — done. `scaffoldCharmDir()` in `src/cli.ts` copies the
   KB template on `charm init` and `charm start` (first run only; never clobbered on re-init).
3. **Wire the read/write-back loop into prompts** — done. The discovery, planner, and worker
   prompts all reference `.charm/kb/INDEX.md` and specify when to read and write KB notes.
