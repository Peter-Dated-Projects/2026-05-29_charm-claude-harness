---
name: charm-update-project-brief
description: Refresh an existing Charm project brief in place after completed work changes standing project facts. Use after a session merge or when the user asks to update or refresh a file in `.charm/project-briefs/`; preserve concise, operator-owned context.
---

# Update a project brief

Refresh standing context; do not turn the brief into a work log.

## Precondition

This skill only applies inside an initialized charm workspace. Before doing anything,
confirm `.charm/CHARM.md` exists at the repository root. If it does not, stop and tell
the user this skill is charm-only (`charm init` first) — do NOT create a `.charm/` directory.

## Locate and compare

1. Use the brief selected for the current project session. If there is no selected brief, identify the target file; ask only when multiple briefs could apply.
2. Read the existing brief before editing it.
3. Compare it with the project's current integrated state — the accepted, completed work present in the working tree at the point you are invoked (this skill runs after the stage-4 integration merge, before the changes reach upstream main). Base updates on that landed state and durable artifacts (accepted decisions, KB entries, proposals, docs) — NOT on speculative or in-flight changes from tickets still being built.

## Apply the smallest truthful change

- Update only facts that affect future planning: project purpose, architecture/layout, constraints, links, or current objective.
- Preserve the frontmatter, stable sections, and unrelated operator-authored wording.
- Replace stale statements; do not append a chronological session summary.
- Link detailed rationale or history from the KB, proposal, or repository document instead of copying it.
- Keep the `## Links` section current as project material accumulates: add links to new durable `.charm/kb/` notes, `.charm/proposals/`, or repo docs this session produced; remove links whose targets were deleted or superseded. Do NOT add `.charm/scratchpad/` (or `tickets/`/`run/`) links — that material is transient; promote a durable version first, then link it.
- Leave the brief unchanged when the session did not alter standing context.

## Surface the result

Report the changed sections, the evidence for each change, and any unresolved question. Do not claim a change when no standing fact changed.
