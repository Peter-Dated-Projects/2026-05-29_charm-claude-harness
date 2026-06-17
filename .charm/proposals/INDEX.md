# Proposals

Design proposals, RFCs, and exploratory write-ups produced during a charm
session. This is the home for **research-mode** output: when the goal is to
explore and refine an idea before committing to a ticketed build, draft the
proposal here and iterate it in place as research sharpens it.

One idea per file, named `PROP-<short-slug>.md` (e.g.
`PROP-auth-token-rotation.md`). Add a row to the table below when you create one.

Proposals are durable and git-tracked -- they accumulate across sessions, like
the knowledge base. They are write product, not scratch: don't delete a
proposal to "clean up". Supersede it and record what replaced it.

## Suggested shape

- **Problem** -- what we're solving and why now.
- **Context / findings** -- what research surfaced (links, file:line, prior art).
- **Proposal** -- the recommended approach.
- **Alternatives considered** -- and why they lost.
- **Open questions** -- what still needs answering before a build.
- **Status** -- draft | refined | accepted | superseded-by:<file>

## Proposals

| File | Summary | Status |
| --- | --- | --- |
| [PROP-charm-harness-notes.md](PROP-charm-harness-notes.md) | Settings UI, PROJECT-NNN proposal naming, finished folder, git worktrees, orchestrator prompt defaults, voice note project reference, research-mode KB enforcement | draft |
| [PROP-charm-harness-ui-revamp.md](PROP-charm-harness-ui-revamp.md) | Evaluate charm.land (Bubble Tea stack) vs. building a full Electron/Tauri app; two-track recommendation | draft |
| [PROP-rust-rewrite.md](PROP-rust-rewrite.md) | Ground-up Rust rewrite: component mapping, crate selection, hard parts (async shared state, no official MCP SDK, frontmatter round-trip), effort by crate | draft |
| [PROP-go-rewrite.md](PROP-go-rewrite.md) | Ground-up Go rewrite: goroutine daemon, Bubble Tea console, component mapping, library choices, effort by package | draft |
| [PROP-file-explorer-tab.md](PROP-file-explorer-tab.md) | Add a fourth Files tab to the console with VS Code-style collapsible tree and markdown viewer; keyboard-only, pure console change, no daemon deps | draft |
| [PROP-bug-triage-and-session-continuity.md](PROP-bug-triage-and-session-continuity.md) | Root-cause + prioritized fix plan for the sidebar-dies and can't-resume symptoms plus 11 audited bugs; session continuity design (stamp --session-id at spawn, add `charm resume`), grouped lifecycle/RPC/concurrency/store fixes | draft |
| [PROP-agent-capability-enforcement.md](PROP-agent-capability-enforcement.md) | Consolidate the capability model: inventory current enforcement, close self-scope verification gap and unrestricted set_session_description, add declarative capability table, per-role prompt trimming; worktree isolation deferred | draft |
| [PROP-orchestrator-context-resilience.md](PROP-orchestrator-context-resilience.md) | Four targeted changes to prevent orchestrator lobotomy: proactive /compact at stage transitions, persist planning rationale to KB, post-compaction re-orientation checklist, and stage-gated prompt injection | draft |
| [PROP-ota-update-strategy.md](PROP-ota-update-strategy.md) | OTA update mechanism survey for Rust desktop apps; recommends custom download+atomic-swap via GitHub Releases with ed25519 signing; AppImage+zsync for Linux delta updates | draft |
