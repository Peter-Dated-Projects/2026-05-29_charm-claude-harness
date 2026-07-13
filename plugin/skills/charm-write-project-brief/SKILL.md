---
name: charm-write-project-brief
description: Create a concise, evidence-based Charm project brief in `.charm/project-briefs/`. Use when the user asks to write, author, or create a project brief for `charm start --project`, including when several initiatives share one repository.
---

## Precondition

This skill only applies inside an initialized charm workspace. Before doing anything,
confirm `.charm/CHARM.md` exists at the repository root. If it does not, stop and tell
the user this skill is charm-only (`charm init` first) — do NOT create a `.charm/` directory.

# Write a project brief

Create standing operational context for one project. A project is an initiative with its own goal and boundaries; it is not necessarily the whole repository.

## Gather evidence

1. Identify the project and its boundary. Ask only if the initiative cannot be distinguished from other work in the repository.
2. Read the project entry points, architecture or design docs, relevant code, and existing `.charm/kb/` material. Prefer repository evidence over assumptions.
3. Find related project briefs. Keep overlapping facts consistent and state boundaries rather than duplicating another brief.

## Write the brief

Create `.charm/project-briefs/<slug>.md`. Do not overwrite an existing brief; use `charm start --project` to scaffold one when appropriate, or choose a distinct slug.

Use this structure:

```md
---
name: <human-readable project name>
description: <one-sentence purpose and current direction>
---

## What this project is
## Architecture / layout
## Constraints and conventions
## Links
## Current objective
```

State only durable facts that change how the orchestrator scopes work: purpose, owned paths and dependencies, non-obvious constraints, accepted decisions, and the near-term objective. Link to detailed material rather than copying it. Use repo-relative links.

### The `## Links` section is the project's index

Treat `## Links` as the project's curated index into related material that already lives in the charm workspace — the brief is a lens over existing surfaces, not a second doc store. Reference material with repo-relative links instead of restating it: the brief stays the self-sufficient injected file, and the links are on-demand depth an agent reads when a task needs it.

- Link ONLY durable, curated surfaces: `.charm/kb/` notes, `.charm/proposals/PROP-*.md`, other `.charm/project-briefs/`, and repo source/docs.
- Do NOT link `.charm/scratchpad/`, `.charm/tickets/`, or `.charm/run/`. Scratchpad is transient, un-indexed working space (drafts get moved out on promote; research and DAG artifacts accrete with no stable-target contract), so links into it rot. If a scratchpad finding matters long-term, promote it to a KB note or a `PROP-*` first, then link that durable target.
- This is the intended model: the curated Links list is the single source of truth. Do NOT introduce `project:` frontmatter tags, an indexer, or a new KB `projects` root.

## Keep it useful

- Keep the body short enough to remain useful as standing system-prompt context.
- Do not copy ticket activity, agent transcripts, speculative implementation plans, or temporary debugging notes.
- Mark uncertainty as an open question instead of presenting it as fact.
- Preserve the distinction between this project brief and a per-ticket handoff brief.

Finish by naming the file created, its project boundary, and the evidence used. Flag any assumption that needs operator confirmation.
