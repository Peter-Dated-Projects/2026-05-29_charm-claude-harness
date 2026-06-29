# Worktrees

By default, all worker agents in a charm session share a single git tree. File-scope
locking (`touches:` in ticket frontmatter) and `COORDINATION.md` keep them safe on that
shared tree. Worktrees are an opt-in escape hatch for situations where that model is not
enough — specifically, when a line of work needs to be **fully isolated** from the main
checkout.

A charm worktree is a real **`git worktree`** — its own working tree, index, and branch,
created with `git worktree add` and checked out under `~/.charm-worktrees/<repo>/<name>/`.
It shares the main repo's object store through a `.git` pointer file rather than being a
separate clone, so there is no full object copy and no separate `origin`. What it buys you
is an isolated **working tree**: an agent inside it can edit anything — including its own
`.charm` (its KB, proposals, scratchpad) — on its own branch, and none of it touches the
files in the main checkout. Because the branch already lives in the same repo, landing the
work is an ordinary merge, done **deliberately and separately** — charm does no automatic
merge-back.

Worktrees live outside the repo tree (under `~/.charm-worktrees/`, grouped by repo name) so
they never nest inside the working checkout and several repos can coexist under one root.

Worktrees are an orchestrator-side tool. Workers do not create or manage them; the
orchestrator (main agent) opens and closes them.

## When to use worktrees vs. the shared-tree model

**Default: shared tree.** Most work belongs here. The daemon serializes tickets whose
`touches:` scopes overlap, so parallel work that touches different files is safe without
any additional setup. Use the shared tree unless you have a specific reason not to.

**Worktrees: full isolation.** Use a worktree when a line of work must be sealed off from the
main checkout, for example:

- A Graphite stack where each diff must be its own branch.
- A hotfix that needs to ship from `main` while a feature is already in progress.
- Experimental work — including risky changes to `.charm` itself or the KB — that the
  orchestrator wants kept off the main checkout until it is proven.

If the work could share a branch on the main tree, use the shared tree. The daemon's scope
locking handles file-level concurrency; worktrees are for total working-tree isolation.

## What is and isn't carried into a worktree

`git worktree add` checks out the branch's **committed** tree at creation time: all tracked
files, including the tracked `.charm` surfaces (`kb/`, `proposals/`, `scratchpad/`). It does
**not** carry gitignored run state (`db.sqlite`, `run/`, `tickets/`) or uncommitted edits in
the main checkout — each working tree has its own untracked files, so a worktree never
duplicates the live control plane. Gitignored `.env` files are the exception: charm symlinks
them back to the main checkout so secrets and config are present.

Each worktree therefore gets its **own** working copy of the KB on its branch. KB edits there
live on that branch and do not reach main until the branch is merged back.

## Opening a worktree

The orchestrator calls `create_worktree` with a name (and optionally a base branch). Charm
runs `git worktree add`, cutting a fresh `charm/<name>` branch off the base under
`~/.charm-worktrees/<repo>/<name>/`.

```
create_worktree(name="hotfix", base="main")
# -> git worktree at ~/.charm-worktrees/<repo>/hotfix/ on branch charm/hotfix
```

For the full parameter spec and return shape, see
[docs/developing/mcp-tools.md](../developing/mcp-tools.md).

## Working inside a worktree

Use the `EnterWorktree` and `ExitWorktree` tools to scope an agent's working directory to a
worktree. While inside, the agent operates on a fully isolated working tree and cannot see
in-flight changes on the main checkout or in other worktrees.

Workers assigned to a worktree-based ticket commit on their branch normally from inside the
worktree — the workflow is the same as on the shared tree, just on a separate branch. Because
the branch already lives in the same repo, landing the work is a plain `git merge charm/<name>`
from the main checkout (no remote fetch needed); do that before closing the worktree.

## Closing a worktree

The orchestrator is responsible for calling `close_worktree` for every worktree it opens, once
the work is merged or abandoned. Closing runs `git worktree remove`, which deletes the working
tree. Commits on its `charm/<name>` branch remain reachable in the repo unless you pass
`delete_branch: true`, which also drops that branch (orphaning its commits to eventual GC) —
merge first if you want to keep the work. Orphaned worktrees accumulate disk usage and can
confuse future sessions that inspect the layout.

```
close_worktree(name="hotfix")
```

## Checking open worktrees

`list_worktrees` returns every worktree currently present under `~/.charm-worktrees/<repo>/`,
including its name, branch, and path.
