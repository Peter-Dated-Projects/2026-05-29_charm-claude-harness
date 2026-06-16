# Worktrees

By default, all worker agents in a charm session share a single git tree. File-scope
locking (`touches:` in ticket frontmatter) and `COORDINATION.md` keep them safe on that
shared tree. Worktrees are an opt-in escape hatch for situations where that model is not
enough — specifically, when two lines of work need to live on **different branches** at
the same time.

Worktrees are an orchestrator-side tool. Workers do not create or manage them; the
orchestrator (main agent) opens and closes them.

## When to use worktrees vs. the shared-tree model

**Default: shared tree.** Most work belongs here. The daemon serializes tickets whose
`touches:` scopes overlap, so parallel work that touches different files is safe without
any additional setup. Use the shared tree unless you have a specific reason not to.

**Worktrees: branch isolation.** Use a worktree when two lines of work genuinely need
different branches, for example:

- A Graphite stack where each diff must be its own branch.
- A hotfix that needs to ship from `main` while a feature is already in progress on a
  feature branch.
- Experimental work the orchestrator wants kept off the main branch until it is proven.

If the work could share a branch, use the shared tree. The daemon's scope locking handles
file-level concurrency; worktrees are for branch-level isolation.

## Opening a worktree

The orchestrator calls `create_worktree` with a name and a base branch. Charm creates a
new branch off the base and checks it out under `.charm/worktrees/<name>/`.

```
create_worktree(name="hotfix", base="main")
# -> worktree at .charm/worktrees/hotfix/ on branch worktrees/hotfix
```

For the full parameter spec and return shape, see
[docs/developing/mcp-tools.md](../developing/mcp-tools.md).

## Working inside a worktree

Use the `EnterWorktree` and `ExitWorktree` tools to scope an agent's working directory to
a worktree checkout. While inside, the agent operates on an isolated branch and cannot see
in-flight changes on the shared tree or in other worktrees.

Workers assigned to a worktree-based ticket commit and push their branch normally from
inside the worktree — the workflow is the same as on the shared tree, just on a different
branch.

## Closing a worktree

The orchestrator is responsible for calling `close_worktree` for every worktree it opens,
once the work is merged or abandoned. Orphaned worktrees accumulate disk usage and can
confuse agents in future sessions that inspect the checkout layout.

```
close_worktree(name="hotfix")
```

## Checking open worktrees

`list_worktrees` returns all worktrees open for the current session, including their name,
branch, and path under `.charm/worktrees/`.
