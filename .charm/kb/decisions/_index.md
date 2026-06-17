# Decisions

ADR-style records: what we chose and **why**. Name files with a zero-padded prefix,
e.g. `0001-single-git-tree.md`.

| Note | Summary | Status |
|---|---|---|
| [0001-orchestrator-context-safeguards.md](0001-orchestrator-context-safeguards.md) | Current design choices that limit orchestrator context growth: KB two-tier navigation, narrow ticket bodies, external state as ground truth, and charm resume for session reattach. | current |
| [prop-harness-notes-feasibility.md](prop-harness-notes-feasibility.md) | Feasibility and effort for all seven items in PROP-charm-harness-notes (settings UI, PROJECT-NNN naming, finished/ folder, git worktrees, orchestrator prompt default, voice note project ref, research-mode KB enforcement) | current |
| [prop-ui-revamp-feasibility.md](prop-ui-revamp-feasibility.md) | Feasibility and effort for PROP-charm-harness-ui-revamp: Track A (Bubble Tea Go TUI, ~6-7 days, clean Go/TS boundary via existing JSON-RPC socket) and Track B (Electron/Tauri, ~17-25 days); recommends closing Ink gaps first, then Track A if TUI ceiling is still blocking | current |
| [files-tab-design.md](files-tab-design.md) | Files tab (console file explorer) design: appended as tab 4, keyboard-only VS Code-style tree, gitignore via git ls-files, binary detection, all in src/console/ with no daemon changes | current |
| [spatial-canvas-ui-feasibility.md](spatial-canvas-ui-feasibility.md) | Spatial canvas UI is feasible (Tauri + CSS-transform is the best path) but should be skipped until charm is shared with non-terminal users or ticket volume exceeds ~50 concurrent. | current |
