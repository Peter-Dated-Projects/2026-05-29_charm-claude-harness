---
id: orchestrator-context-safeguards
root: decisions
type: decision
status: current
summary: "Current design choices that limit orchestrator context growth: KB two-tier navigation, narrow ticket bodies, external state as ground truth, and charm resume for session reattach."
created: 2026-06-13
updated: 2026-06-13
---

# Orchestrator Context Safeguards

## Context

The orchestrator runs a single multi-hour interactive session covering all five pipeline stages. Its context accumulates the Stage 0 interview, Stage 1 planning deliberation, Stage 2 reviewer output, and every Stage 3 wake-up/reap cycle. This makes it the agent most exposed to context pressure in the fleet.

## Safeguards currently in the design

### 1. KB two-tier navigation

Agents are instructed to never bulk-read the KB. The protocol is: `INDEX.md` (always tiny) -> root `_index.md` -> only the 1-2 notes whose one-line summary matches the current goal. This keeps KB reads narrow and avoids loading unrelated notes into the orchestrator's context.

### 2. Short ticket bodies, no inlined docs

The planner prompt explicitly prohibits inlining spec documents into ticket bodies:
> "Reference authoritative docs by path; never inline them ... inlining a large document into each ticket bloats the `create_tickets` call."

Ticket bodies carry only: scope, file ownership, and acceptance criteria. Everything else is a path pointer.

### 3. External state as ground truth

COORDINATION.md, ticket files, and the KB are all external to the orchestrator's context. The orchestrator reads them on demand via MCP calls (`read_coordination()`, `list_tickets()`) or direct file reads. This means the orchestrator's context is a cache, not the source of truth -- in principle, a disoriented orchestrator can re-derive the current state of play from these artifacts.

### 4. Orchestrator is unkillable

`MAIN_AGENT_ID = "main-001"` is hardcoded and the kill path hard-rejects any attempt to terminate it. This prevents accidental or malicious teardown of the session-long process.

### 5. charm resume

The orchestrator's session UUID is persisted to `.charm/run/<uuid>/orchestrator-session.json`. `charm resume` reattaches to the existing conversation via `--resume <uuid>` with the same system prompt, model, and MCP config. This is the recovery path when the terminal is lost or the session detaches.

### 6. modelLine context overflow instruction

Every spawned agent's system prompt includes: "If a task exceeds your capabilities or context window, surface it rather than silently truncating." This is a behavioral instruction, not a technical safeguard.

## What this design does NOT address

See the gotcha note `orchestrator-context-pressure-gaps.md` for the gaps and mitigations.

## References

- `src/daemon/spawn.ts` -- prompt assembly, `MAIN_AGENT_ID`, session UUID persistence
- `.charm/prompts/planner.md` -- "Reference authoritative docs by path; never inline them"
- `.charm/prompts/discovery.md` -- two-tier KB navigation instruction
- [Claude Code context management practices](https://dev.to/myougatheaxo/claude-code-context-management-keep-ai-output-consistent-on-long-projects-4d5h)
- [Multi-agent orchestration: context window management](https://www.augmentcode.com/guides/multi-agent-orchestration-architecture-guide)
