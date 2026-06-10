---
id: ink-comounted-useinput-keysets
root: gotchas
type: gotcha
status: current
summary: "Ink delivers every keypress to every mounted useInput with isActive=true; two handlers co-mounted in one console tab must use disjoint key sets or shared keys double-fire."
created: 2026-06-09
updated: 2026-06-09
---

Ink's `useInput` does not route keys by focus or by component nesting. Every
keypress is delivered to EVERY mounted `useInput` whose `{ isActive }` is true.
A single `inputActive` flag that gates a whole tab does NOT partition keys
between two handlers that mount together inside that tab.

This bites in the console's Files tab (`src/console/app.tsx` + `file-tree.tsx`):
`FileTree`'s `useInput` and the Files-tab viewer's scroll `useInput` are both
mounted while the tab is focused, and both see `isActive=true` at once. If they
share a key, it fires in both — e.g. `g` would jump the tree cursor AND scroll
the viewer to top on one press.

The fix is a hand-maintained disjoint key partition, not a focus mechanism:
- Tree (`FileTree`) owns: `j`/`k`/up/down, Shift+up/down, Enter/right, left/`h`,
  `r` (refresh), `g`/`G` (cursor top/bottom).
- Files-tab viewer owns ONLY: mouse wheel, Space/`b` (page), `^d`/`^u` (half),
  and `+`/`-` (list resize). It deliberately does NOT bind `g`/`G`/`r`.

Note this diverges from `ArtifactsTab`, which has a SINGLE combined `useInput`
and so can bind `g`/`G`->viewer-scroll and `r`->reset-selection freely. When the
viewer's scroll state was factored into the shared `useViewer` hook, the KEY
BINDINGS were intentionally left in each tab's own `useInput` for exactly this
reason — hoisting them would have forced both tabs onto one keymap.

Takeaway: any time you add a second `useInput` inside an already-active tab,
diff its key set against the others mounted alongside it before shipping.
