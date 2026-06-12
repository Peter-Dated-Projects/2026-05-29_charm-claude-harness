# Charm console keybindings

A complete reference for every keystroke the charm console (`src/console/app.tsx`)
responds to, organized by scope. The console is an Ink TUI with four tabs --
Artifacts, Approvals, Agents, and Files -- plus a global app shell that owns tab
switching and the session-level commands.

Bindings are grouped one table per scope. Within a tab, only that tab's handler
is active; the global shell keys work from any tab. The tables below are
transcribed directly from the `useInput` handlers in `src/console/app.tsx` and
`src/console/file-tree.tsx` -- if a future change touches those handlers, update
this doc to match.

A note on `:q` and `:a`: these are session-level commands surfaced in the shell
hint, handled by the console host (the tmux/session layer), not by the Ink
`useInput` handlers documented here.

## Global / app shell

Active on every tab.

| Key | Action |
| --- | --- |
| `1` | Select Artifacts tab |
| `2` | Select Approvals tab |
| `3` | Select Agents tab |
| `4` | Select Files tab |
| `Tab` | Cycle forward: Artifacts -> Approvals -> Agents -> Files -> Artifacts |
| `Shift-Tab` | Cycle backward: Artifacts -> Files -> Agents -> Approvals -> Artifacts |
| `:q` | Quit the console (session host command) |
| `:a` | Detach from the session (session host command) |

Note the cycle order: `Tab` and `Shift-Tab` move through the tabs in *display
order* (Artifacts, Approvals, Agents, Files) and its exact reverse. `Files` sits
last in the forward cycle and first after `Artifacts` in the backward cycle.
The console also auto-switches to Approvals when a gate is waiting and the
current tab is Artifacts.

## Artifacts tab

A vertical split: a file list (`.charm/PROJECT.md`, `COORDINATION.md`, and every
ticket) above a scrolling markdown viewer. A single combined input handler owns
both the list navigation and the viewer scroll, so `g`/`G`/`r` are free to act on
the viewer and selection here.

| Key | Action |
| --- | --- |
| `j` / `Down` | Select next file in the list |
| `k` / `Up` | Select previous file in the list |
| `+` / `=` | Grow the file-list panel (shrink the viewer) |
| `-` / `_` | Shrink the file-list panel (grow the viewer) |
| `Space` / `PageDown` | Scroll viewer down one page |
| `b` / `PageUp` | Scroll viewer up one page |
| `Ctrl-d` | Scroll viewer down half a page |
| `Ctrl-u` | Scroll viewer up half a page |
| `g` | Jump viewer to top |
| `G` | Jump viewer to bottom |
| `r` | Reset file selection (back to the stage-inferred default) |
| Mouse wheel | Scroll the viewer |

## Files tab

A VS Code-style file explorer: a keyboard-driven directory tree above a markdown
viewer. Unlike the Artifacts tab, the tree and the viewer are **two separate
input handlers** that mount together while the tab is focused. To keep them from
double-firing, the tree owns navigation and `g`/`G`/`r`, and the viewer owns only
a strict subset of scroll keys -- see "Co-mounted input handlers" below.

### Tree (`FileTree`)

| Key | Action |
| --- | --- |
| `j` / `Down` | Move cursor down one row |
| `k` / `Up` | Move cursor up one row |
| `Shift-Down` | Jump to the next FILE, skipping directory rows |
| `Shift-Up` | Jump to the previous FILE, skipping directory rows |
| `Enter` / `Right` | Expand the directory under the cursor, or open the file |
| `Left` / `h` | Collapse the expanded directory, or move to the parent row |
| `r` | Refresh the tree and re-read the gitignore filter |
| `g` | Move cursor to the top of the tree |
| `G` | Move cursor to the bottom of the tree |

### Viewer

| Key | Action |
| --- | --- |
| `Space` / `PageDown` | Scroll viewer down one page |
| `b` / `PageUp` | Scroll viewer up one page |
| `Ctrl-d` | Scroll viewer down half a page |
| `Ctrl-u` | Scroll viewer up half a page |
| `+` / `=` | Grow the tree panel (shrink the viewer) |
| `-` / `_` | Shrink the tree panel (grow the viewer) |
| Mouse wheel | Scroll the viewer |

Important: in the Files tab, `g`, `G`, and `r` act on the **tree** (cursor
top/bottom and refresh), NOT on the viewer. This differs from the Artifacts tab,
where the same keys scroll the viewer and reset selection. The Files-tab viewer
deliberately binds no `g`/`G`/`r`, so those presses reach only the tree.

## Approvals tab

Navigate pending approval gates and approve or reject the selected one.

| Key | Action |
| --- | --- |
| `j` / `Down` | Select next gate |
| `k` / `Up` | Select previous gate |
| `y` / `a` | Approve the selected gate |
| `n` / `r` | Reject the selected gate |

## Agents tab

Navigate the live agent list, dismiss finished agents, and kill running ones.

| Key | Action |
| --- | --- |
| `j` / `Down` | Select next agent |
| `k` / `Up` | Select previous agent |
| `d` | Dismiss the selected agent (only when its state is `done` or `failed`) |
| `x` then `x` | Kill the selected agent (double-press; only when `spawning` or `running`) |

The kill is a two-step confirm: the first `x` arms the kill for the selected
agent and shows a prompt; a second `x` on the same agent carries it out. Moving
the selection with `j`/`k` disarms a pending kill.

## Design note: co-mounted input handlers

Ink's `useInput` does not route keypresses by focus or component nesting. Every
keypress is delivered to EVERY mounted handler whose `isActive` is true. In the
Files tab the tree's handler and the viewer's handler are both mounted and both
active at once, so any key they share would fire in both places (for example,
`g` would jump the tree cursor AND scroll the viewer on a single press).

The fix is a hand-maintained disjoint key partition rather than a focus
mechanism: the tree owns `j`/`k`/arrows, `Shift`+arrows, `Enter`/`Right`,
`Left`/`h`, `r`, and `g`/`G`; the Files-tab viewer is restricted to a strict
subset -- mouse wheel, `Space`/`b`, `Ctrl-d`/`Ctrl-u`, and `+`/`-` -- and binds
no `g`/`G`/`r`. The Artifacts tab does not face this constraint because it uses a
single combined handler, which is why it can bind `g`/`G`/`r` to viewer actions
freely. Any new second handler added inside an already-active tab must have its
key set diffed against the others mounted alongside it.
