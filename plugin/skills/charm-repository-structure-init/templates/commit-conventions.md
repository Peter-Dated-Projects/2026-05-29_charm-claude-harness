# Commit conventions

Every commit message in this repo starts with a typed scope:

```text
<area>(<scope>): <subject>
```

The point is that `git log --oneline` should let you find the commit that touched a given
asset without opening any of them. The area names the *kind* of thing that changed; the scope
names *which one*.

## Areas

Replace this table with the areas this repo actually has — one row per kind of asset someone
would want to filter the log by. Delete the rows that don't apply; a convention listing areas
nobody uses trains people to ignore it.

| Area | Covers | `<scope>` is |
| --- | --- | --- |
| `docs` | Planning and reference documentation | The doc area: `planning`, `tdds`, `projects` |
| `plan` | `docs/planning/PLAN.md` — product intent, scope, delivery order | Omit, or the section |
| `prj` | A project document under `docs/planning/projects/` | The project number: `PRJ-001` |
| `tdd` | A design document under `docs/planning/tdds/` | The TDD number: `TDD-002` |
| `script` | Shell and build entry points | The script filename |
| `chore` | Dependencies, config, ignores, and anything with no user-visible behavior | The subsystem, or omit |

Add an area when a genuinely new kind of asset appears — the list is descriptive, not fixed.
Do not stretch an existing area to cover something it does not describe.

## Rules

- **One area per commit.** A change spanning a document and an index that lists it is two
  commits. Shared index files belong to the commit for the thing being indexed only if no
  other area changed with them.
- **One scope per commit** within an area. Two TDDs revised at once is two `tdd(...)` commits.
- **Subject is imperative and lowercase**, no trailing period: `add`, `move`, `remove`,
  `rename`, `fix` — not `added` or `Adds`.
- **Say what changed, not that something changed.** `tdd(TDD-002): drop the hosted-model
  adapter from scope` beats `tdd(TDD-002): update`.
- **Body explains why**, when the subject cannot carry it. Wrap at 72 columns. A commit that
  removes or supersedes something should say what replaced it.

## Examples

```text
plan: narrow the first release to local-only inference
prj(PRJ-001): record the handoff-artifact decision
tdd(TDD-002): add the evidence uniqueness key
tdd(TDD-005): defer — no in-app editing in this scope
docs(tdds): move TDD-005 and TDD-006 into the deferred table
chore: ignore the local artifact store
```

## Why not plain Conventional Commits

Conventional Commits types (`feat`, `fix`, `chore`, …) describe the *nature* of a change.
When a repo's assets are heterogeneous, the useful question when reading the log is usually
"which asset moved?", not "was it a feature or a fix". Naming the asset kind in the area, and
its identity in the scope, answers that directly — and `which document changed` is not
recoverable from a `feat:` prefix.

If this repo is mostly application code with a conventional release process, prefer standard
Conventional Commits instead and delete this file. The two do not mix well.
