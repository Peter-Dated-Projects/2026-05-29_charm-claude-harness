# Worktrees

By default, all worker agents in a charm session share a single git tree. File-scope
locking (`touches:` in ticket frontmatter) and `COORDINATION.md` keep them safe on that
shared tree. Worktrees are an opt-in escape hatch for situations where that model is not
enough — specifically, when a line of work needs to be **fully isolated** from the main
checkout.

A charm worktree is **a completely separate copy of the repo** — a full clone with its own
`.git`, checked out under `.charm/worktrees/<name>/`. It is **not** a linked `git worktree`.
That matters: an agent inside a copy can edit anything, including its own `.charm` (its KB,
proposals, scratchpad), and none of it touches the main checkout. The copy is wired with the
main repo as its `origin`, so committed work is merged back **deliberately and separately** —
charm does no automatic merge-back.

Worktrees are an orchestrator-side tool. Workers do not create or manage them; the
orchestrator (main agent) opens and closes them.

## When to use worktrees vs. the shared-tree model

**Default: shared tree.** Most work belongs here. The daemon serializes tickets whose
`touches:` scopes overlap, so parallel work that touches different files is safe without
any additional setup. Use the shared tree unless you have a specific reason not to.

**Worktrees: full isolation.** Use a copy when a line of work must be sealed off from the
main checkout, for example:

- A Graphite stack where each diff must be its own branch.
- A hotfix that needs to ship from `main` while a feature is already in progress.
- Experimental work — including risky changes to `.charm` itself or the KB — that the
  orchestrator wants kept off the main checkout until it is proven.

If the work could share a branch on the main tree, use the shared tree. The daemon's scope
locking handles file-level concurrency; worktree copies are for total isolation.

## What is and isn't carried into a copy

A copy is a `git clone`, so it carries the **committed** state of the repo at creation time:
all tracked files, including the tracked `.charm` surfaces (`kb/`, `proposals/`,
`scratchpad/`). It does **not** carry gitignored run state (`db.sqlite`, `run/`, `tickets/`)
or uncommitted edits in the main checkout — so a copy never duplicates the live control
plane.

Each copy therefore gets its **own KB**. KBs do not auto-sync between copies and the main
checkout; if a copy's KB work should land in main, merge that branch back like any other
change.

## Opening a worktree

The orchestrator calls `create_worktree` with a name (and optionally a base branch). Charm
clones the repo and cuts a fresh `charm/<name>` branch off the base under
`.charm/worktrees/<name>/`.

```
create_worktree(name="hotfix", base="main")
# -> standalone copy at .charm/worktrees/hotfix/ on branch charm/hotfix, origin -> main
```

For the full parameter spec and return shape, see
[docs/developing/mcp-tools.md](../developing/mcp-tools.md).

## Working inside a worktree

Use the `EnterWorktree` and `ExitWorktree` tools to scope an agent's working directory to a
copy. While inside, the agent operates on a fully isolated repo and cannot see in-flight
changes on the main checkout or in other copies.

Workers assigned to a worktree-based ticket commit on their branch normally from inside the
copy — the workflow is the same as on the shared tree, just in a separate repo. To land the
work, merge the branch back into the main checkout before closing the copy (e.g. fetch the
copy's branch from main, or push it).

## Closing a worktree

The orchestrator is responsible for calling `close_worktree` for every copy it opens, once
the work is merged or abandoned. Closing **deletes the whole copy**, so any committed-but-
unmerged work on its branch is gone with it — merge first if you want to keep it. Orphaned
copies accumulate disk usage and can confuse future sessions that inspect the layout.

```
close_worktree(name="hotfix")
```

## Checking open worktrees

`list_worktrees` returns every copy currently present under `.charm/worktrees/`, including
its name, branch, and path.
