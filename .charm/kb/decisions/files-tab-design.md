---
id: files-tab-design
root: decisions
type: decision
status: current
summary: "Files tab (console file explorer) design: appended as tab 4, keyboard-only VS Code-style tree, gitignore via git ls-files, binary detection, all in src/console/ with no daemon changes."
created: 2026-06-09
updated: 2026-06-09
---

# Decision: Files tab — console file explorer design

Source proposal: `.charm/proposals/PROP-file-explorer-tab.md`
Project spec: `.charm/PROJECT.md` (Files tab project).

This is the first delivery of the "close the Ink gaps" near-term path
recommended in `prop-ui-revamp-feasibility.md` — a free-roaming file/KB/proposals
browser inside the existing Ink console rather than a Go (Track A) or Electron
(Track B) rewrite.

## Decisions locked in discovery

- **Placement:** appended as tab `4` (1-Artifacts / 2-Approvals / 3-Agents /
  4-Files). Existing tab numbers and the stage-aware auto-flip to Approvals are
  left untouched. Rejected: replacing Artifacts at tab 1, and merging the tree
  into the Artifacts tab (would muddle its stage-aware flat-list UX).

- **Interaction is keyboard-only.** Ink has no row-level click hit-testing;
  wheel scrolling of the viewer is kept (via the existing `mouse.ts`), but tree
  selection is keys only. Key map mirrors the Artifacts tab plus tree-specific
  bindings: `j`/down and `k`/up move one row; **Shift+down / Shift+up jump to
  the next/previous file row, skipping directories**; Enter/right expands a dir
  or opens a file; left/`h` collapses; `r` refreshes; `g`/`G` top/bottom.
  Shift-arrow uses Ink's `key.shift` flag in `useInput`.

- **Full feature set in the first build** (not a lean MVP): gitignore-aware
  filtering, live auto-reveal markers when a watched file changes, and
  binary-file handling are all in scope from the start.

- **Gitignore mechanism:** shell out to `git` (the workspace is always a git
  repo) rather than add a parser dependency. Leaning toward a one-shot
  `git ls-files --cached --others --exclude-standard` snapshot at tab open,
  cached and refreshed on `r` — accurate and a single spawn.

- **Binary files:** detected via a null-byte sniff; dimmed in the tree AND, if
  opened, the viewer shows `(binary file — N bytes)` instead of dumping raw
  bytes that corrupt the terminal.

- **Tree model:** lazy `TreeNode { path, name, isDir, expanded?, children?,
  depth }`, flattened to visible rows by descending only into expanded dirs; a
  numeric cursor indexes the visible-rows array. Children are read on first
  expand, not up front.

## Boundaries

Pure `src/console/` change — **no daemon, RPC, schema, or `paths.ts` changes**.
The existing JSON-RPC `status` poll already supplies everything the rest of the
console needs; the file tree reads the filesystem directly (`node:fs`) and
watches it with the already-present `chokidar`, exactly as the Artifacts tab
does. Artifacts tab behavior is unchanged (shared helpers may be extracted, but
its UX must not move).
