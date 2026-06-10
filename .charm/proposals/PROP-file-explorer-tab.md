# file-explorer-tab

**Status:** draft

---

## Problem

The Artifacts tab (`app.tsx:112`) shows a flat, hard-coded list of files:
PROJECT.md, COORDINATION.md, and every `.md` inside `.charm/tickets/`. There is
no way to browse the rest of the project tree — proposals, KB, prompts, the
scratchpad, or arbitrary files an agent just wrote — without leaving the console
and using a shell. Operators regularly need to spot-check what agents are
producing, which means either Alt-tabbing to a terminal or adding files to the
hard-coded list. Neither is good UX.

---

## Context / Findings

### Current artifacts model

`useFileTree` (app.tsx:55) hardcodes three sources:

```
if (existsSync(paths.projectMd))       out.push(paths.projectMd)
if (existsSync(paths.coordinationMd))  out.push(paths.coordinationMd)
if (existsSync(paths.ticketsDir))      // *.md inside .charm/tickets/
```

The list is flat and is already watche d by chokidar. The viewer panel below it
renders the selected file as markdown. The interaction model (j/k or arrow keys to
navigate, scroll in the viewer) is already in place and works cleanly.

### What operators actually want to see

Beyond the tickets:
- `.charm/proposals/PROP-*.md` — research output from discovery sessions
- `.charm/kb/**` — knowledge base articles agents write
- `.charm/prompts/*.md` — prompt templates (useful to verify mid-run)
- `.charm/scratchpad/` — orchestrator draft tickets
- Arbitrary project files an agent just created or edited

The natural shape for "arbitrary project files" is a VS Code-style tree: the
project root as the top node, folders expand/collapse, files are leaves that
open in the viewer on selection.

### Why this fits in the console as a new tab

There are three tabs today (`Tab = "artifacts" | "approvals" | "agents"`,
app.tsx:14). A fourth tab — "Files" — maps cleanly onto this. It keeps the
viewer reuse pattern (render the selected file as markdown below the tree) and
does not require any daemon changes; it's a pure console addition.

### Ink/React constraints

The console runs in Ink (React for the terminal). Ink has no mouse click support
beyond wheel events (the current `mouse.ts` intercepts scroll only). Expand/
collapse must be keyboard-driven: Enter or right-arrow to open a node, left-arrow
or Escape to close/go up. This is actually fine — it mirrors vim's NetRW and
VS Code's keyboard-only tree navigation mode, which is already the idiom of the
rest of the console.

Ink renders via flexbox; each tree row is one `<Text>` component. Indentation
is cosmetic (leading spaces or `│`/`├`/`└` box chars). The existing
`wrap="truncate-end"` pattern handles long paths cleanly.

### Node.js FS

`readdirSync` with `{ withFileTypes: true }` gives `Dirent` objects that expose
`.isDirectory()`, which is all we need to build a lazy tree. Lazy means: only
read a directory's children when the node is expanded; collapse drops the children
from state. This keeps startup instant regardless of how deep the project tree is.

chokidar watching is already used for the file list and viewer; the file explorer
can re-use the same pattern — watch the currently-expanded directories so the
tree stays live as agents write files.

### Paths to expose

The `charmPaths` object (`paths.ts:51`) has every named path the daemon uses.
The file explorer should root at `ROOT` (the project root) and apply a
`.gitignore`-aware filter. Directories to collapse by default: `node_modules`,
`.git`, `rust/target`, `dist`. The `.charm/` subtree should be expanded by
default since that is where agents write their output.

---

## Proposal

Add a fourth tab `"files"` to the console, reachable via `4` or the existing
Tab/Shift-Tab cycle.

### Tree state model

```ts
type TreeNode = {
  path: string;          // absolute
  name: string;          // display name (basename)
  isDir: boolean;
  expanded?: boolean;    // dirs only
  children?: TreeNode[]; // populated on expand
  depth: number;
};
```

A flat `cursor: number` index into the visible-rows array drives selection.
Visible rows are derived from the tree by a `flattenVisible(root)` pass that
descends only into expanded dirs. This is the standard virtual-tree pattern used
by every file browser.

### Key bindings (additive, consistent with existing tab conventions)

| Key | Action |
| --- | --- |
| j / down | cursor down one row |
| k / up | cursor up one row |
| Shift+down | skip to next file (skip over directory rows) |
| Shift+up | skip to previous file (skip over directory rows) |
| Enter / right | expand dir / open file in viewer |
| left / h | collapse dir (or move cursor to parent) |
| r | refresh (re-read current dir) |
| g / G | top / bottom |
| Space / b | page down / page up in viewer |
| ^d / ^u | half-page down / up in viewer |
| wheel | scroll viewer (same as Artifacts tab) |

File selection opens the file in the viewer panel below (same markdown renderer
as ArtifactsTab — reuse `useFileContent` and `renderMarkdown`).

Shift+up/down skip folders: scan forward or backward through the `flattenVisible`
array, advancing the cursor past any `isDir === true` rows until a file row is
reached. Ink's `useInput` exposes `key.shift` alongside `key.upArrow`/
`key.downArrow`, so the check is `key.shift && key.downArrow`. If no file exists
in that direction the cursor stays put.

### Layout

Same vertical split as ArtifactsTab: tree panel on top (height user-adjustable
with +/-), markdown viewer below. The tree panel shows one row per visible node
with indentation. Suggested row format:

```
  ▶ .charm/             <- collapsed dir, cursor on it
    ├ kb/
    │ ├ INDEX.md        <- leaf file
    │ └ architecture/
    ▶ proposals/        <- expanded dir
      ├ PROP-foo.md     <- selected file, rendered in viewer below
```

Box-drawing chars (`├`, `└`, `│`) are cosmetic — the terminal handles them as
single-width characters, so alignment is reliable in practice.

### Default-expanded paths on open

Expand `.charm/` and its direct children (tickets, proposals, kb, prompts,
scratchpad) automatically. Everything else starts collapsed. Rationale: the
operator launched the console to see what agents are doing inside `.charm/`;
the project root context (src/, docs/, etc.) is secondary.

### Auto-reveal on file change (optional / phase 2)

When chokidar fires on a path inside the tree, if the file is inside an already-
expanded subtree, refresh that subtree. If the file is newly created in an
unexpanded dir, add a badge to the dir row (e.g. `kb/ (!)`) to indicate unseen
changes. This is a nice-to-have; not required for MVP.

### Gitignore filtering

Use a simple hard-coded blocklist for MVP: `node_modules`, `.git`, `rust/target`,
`dist`, `*.lock`, `.DS_Store`. A proper gitignore parser is nice-to-have (phase 2)
and out of scope for the initial build.

### Implementation scope

All changes are confined to `src/console/app.tsx` plus an optional
`src/console/file-tree.tsx` extraction if the component grows large. No daemon
changes, no schema changes, no new dependencies — `readdirSync` is already
imported in app.tsx and chokidar is already a dep.

---

## Alternatives Considered

- **Extend the existing Artifacts tab instead of a new tab:** The Artifacts tab
  hard-codes a specific set of charm-workspace files and auto-selects on stage
  changes. Merging a free-roaming file explorer into that tab would complicate
  the auto-selection logic and muddle the UX intent. A dedicated tab keeps
  concerns separate.

- **Show the full tree inside the Artifacts tab as a replace for the flat list:**
  Tempting, but the Artifacts tab serves a specific workflow (reviewing the files
  relevant to the current approval stage). A full tree makes that harder to
  scan quickly. Keeping the two separate preserves the Artifacts tab's focused
  UX.

- **Mouse click support via xterm escape sequences:** `mouse.ts` already uses
  xterm mouse reporting for wheel events. Extending it to click coordinates is
  feasible but requires hit-testing every rendered row — non-trivial in Ink
  where row positions are not introspectable at render time. Keyboard-only is
  faster to ship and covers 100% of the same capability.

- **Telescope/fuzzy-find launcher (`:e <pattern>`):** A fuzzy file opener would
  complement the tree browser but is not a substitute — browsing unknown output
  requires seeing the structure, not knowing a filename in advance. Both can
  coexist; fuzzy-find is a natural phase 2 on top of the tree.

---

## Open Questions

1. **Gitignore parsing:** Hard-coded blocklist is enough for MVP. Should phase 2
   use the `ignore` npm package (already in many Node projects) or shell out to
   `git ls-files --others --exclude-standard`? The latter is accurate but adds a
   process spawn on every directory expand.

2. **Binary file handling:** The viewer will render anything as text. Binary files
   (images, compiled artifacts in non-gitignored paths) will produce garbage.
   Should the tree gray out non-text files, or just let the viewer show them (which
   is what most editors do on first click)?

3. **chokidar scope:** Watching the entire project root for the auto-reveal
   badge feature could be expensive in large repos. Should the watcher be
   scoped to `.charm/` only, or made configurable?

4. **Tab number:** Currently 1/2/3 for Artifacts/Approvals/Agents. "Files" would
   become 4. Is that ordering intuitive, or should Files replace Artifacts at 1
   and push the others to 2/3/4?

---

## Status

draft
