---
status: draft
---

# PROP-orchestrator-context-resilience

**Status:** draft

## Problem

The orchestrator runs a single, multi-hour interactive session covering all five pipeline stages. By mid-Stage 3 it has accumulated: the Stage 0 discovery interview, all Stage 1 planning deliberation, Stage 2 reviewer output, and every agent wake-up/reap cycle. When Claude Code's auto-compression fires, it summarizes older history using generic heuristics. The orchestrator may then:

- Lose track of which tickets are in which wave
- Forget the rationale behind dependency edges (making reassignment decisions blind)
- Be unable to self-diagnose that it has been compressed

There is no proactive compaction, no persisted planning rationale, and no documented re-orientation procedure. These three gaps compound as session length grows. The current system has the right instincts (external state, durable KB, `charm resume`) but has not closed the loop between them.

Research baseline: LLM orchestrators routinely fail in long sessions due to context saturation. The standard mitigations are proactive summarization with targeted focus prompts, external state as ground truth (already present here), and hierarchical decomposition so no single agent holds the full context. See [AI Agent Orchestration Patterns (2026)](https://jobsbyculture.com/blog/ai-agent-orchestration-patterns-2026) and [Context Compression in AI Agents: Hermes vs. Claude Code](https://mem0.ai/blog/how-hermes-and-claude-handle-context-compression-in-real-production-agents-(and-what-you-should-extract)).

## Context / Findings

From code audit (2026-06-13, `src/daemon/spawn.ts`, `.charm/prompts/*.md`):

**What currently protects the orchestrator:**
- KB two-tier navigation prevents bulk reads (agents instructed to read INDEX.md -> root _index.md -> at most 2 notes)
- Ticket bodies are kept short; planner.md explicitly prohibits inlining spec docs
- COORDINATION.md and ticket files are external state; the orchestrator queries them on demand
- `MAIN_AGENT_ID = "main-001"` is hardcoded and protected from kill_agent
- `charm resume` can reattach via `--resume <uuid>` with identical system prompt + model + MCP config

**What is missing:**
- No proactive compaction call at stage transitions
- Planning rationale (wave decomposition, dependency reasoning) lives only in context and is lost on any compression
- No recovery checklist in orchestrator.md for post-compression re-orientation
- Orchestrator system prompt is large upfront: orchestrator.md + discovery.md + planner.md + CLAUDE.md + hardcoded CHARM_RULES, all loaded before the first user message

The last point is meaningful: discovery.md and planner.md are only needed for Stages 0 and 1 respectively. After Stage 1 completes they are inert context overhead for the remainder of the session.

See also KB notes:
- `kb/decisions/0001-orchestrator-context-safeguards.md` -- what exists and why
- `kb/gotchas/orchestrator-context-pressure-gaps.md` -- gaps with per-gap mitigations

## Proposal

Four targeted changes, each independently shippable and each addressing one specific gap:

---

### Change 1: Proactive compaction at stage transitions (orchestrator.md)

At the end of Stage 2 (after `await_approval(stage=2)` returns) and at the start of each new worker wave in Stage 3, add an explicit instruction in orchestrator.md:

> Before spawning the next wave, run `/compact Preserve: the approved project goal from PROJECT.md, the current wave number and its ticket ids, any blocked or failed tickets, and the approved dependency graph structure. You may discard: the Stage 0 interview detail, Stage 1 brainstorming, and completed ticket details.`

**Why:** Claude Code's `/compact [focus]` accepts a targeted prompt that directs what to preserve. Running it proactively -- while the orchestrator still has clear recall -- produces better summaries than letting auto-compression fire under pressure. [Reference: Claude Code context management guide](https://dev.to/myougatheaxo/claude-code-context-management-keep-ai-output-consistent-on-long-projects-4d5h)

**What this does NOT require:** any code changes. Pure prompt change to orchestrator.md.

---

### Change 2: Persist planning rationale to KB (planner.md)

After `create_tickets` and before `spawn_review_agents`, instruct the planner to write a `decisions/` KB note with:
- The wave structure (Wave 0: [T-001, T-002], Wave 1: [T-003], etc.)
- The key dependency rationale (why each `depends_on` edge exists -- what output B literally needs from A)
- Any parallelism constraints that were non-obvious

**Why:** This is the planning reasoning that is hardest to reconstruct from ticket files alone. A future orchestrator session (or a resumed session post-compaction) can read this note and understand WHY the graph is shaped the way it is, not just what it looks like. Cost: one KB write per session.

**What this does NOT require:** any code changes. Addition to planner.md.

---

### Change 3: Post-compaction re-orientation checklist (orchestrator.md)

Add a section to orchestrator.md:

> **If you are disoriented or unsure of the current session state** (e.g. after a `/compact`, after `charm resume`, or after a long wait), re-orient before acting:
> 1. Call `read_coordination()` -- this is the live board; it shows every ticket not yet complete with its stage, status, and assigned agent.
> 2. Call `list_tickets({statuses: ["running", "blocked", "failed"]})` -- the actionable subset.
> 3. Read `kb/INDEX.md` -> `kb/decisions/<planning-rationale-note>.md` if it exists.
> 4. Do NOT infer the current wave from memory. Read the board.

**Why:** Re-orientation IS possible from external state, but only if the orchestrator knows to do it. Without an explicit checklist, a disoriented orchestrator tends to guess from memory or ask the user. [Reference: multi-agent orchestration guide](https://www.augmentcode.com/guides/multi-agent-orchestration-architecture-guide)

**What this does NOT require:** any code changes. Addition to orchestrator.md.

---

### Change 4: Stage-gated prompt injection (spawn.ts, medium effort)

**The gap:** discovery.md and planner.md are loaded into the orchestrator's system prompt at spawn time and remain there for the entire session, consuming ~3-5k tokens of context headroom after Stages 0 and 1 are complete.

**Option A (no code change):** Trim discovery.md and planner.md aggressively. Remove example wave diagrams, long explanatory prose, and anything that is already enforced by `charm` structurally (e.g. the wave-width logic can be summarized in 3 bullet points rather than a full worked example). Target: cut each file by ~40%.

**Option B (code change, medium effort):** Add a mechanism for the daemon to inject additional system-prompt segments to the orchestrator at stage transitions via `--append-system-prompt` on a follow-up spawn, OR by delivering stage instructions as a `[charm]` message at the right moment (the orchestrator reads it like any other wake-up ping). This would allow discovery.md to be injected only at Stage 0 start and planner.md only at Stage 1 start, clearing them from the active prompt once their stage is complete.

Option B requires daemon changes (`spawn.ts`, possibly a new MCP tool `append_system_context`). It is non-trivial because Claude Code does not natively support post-spawn system prompt injection -- this would likely work by delivering the stage instructions as an agent message rather than a true system prompt segment.

**Recommendation:** Ship Option A first (no risk, immediate headroom), defer Option B until the prompt overhead is measured to be a real problem.

---

## Alternatives Considered

**Auto-compaction only (do nothing):** Claude Code already auto-compresses when context fills. The problem is that auto-compression uses generic heuristics and fires reactively. Research consistently shows this produces worse results than proactive, targeted compaction. Rejected.

**Planner as a separate headless sub-agent:** Spawn a headless `planner` agent that does the Stage 1 graph decomposition and exits. This keeps the planning deliberation completely off the orchestrator's context. Tradeoff: the orchestrator loses direct visibility into the dependency reasoning; it only sees the resulting tickets. Also requires a new agent role and changes to the spawn/registry path. Deferred as a larger architectural change -- the KB write in Change 2 is a simpler way to persist the same information.

**Periodic orchestrator restarts with state reload:** Kill and respawn the orchestrator at each wave boundary, reloading state from KB + tickets + COORDINATION.md. This is the "stateless orchestrator" pattern. Very clean architecturally, but requires the orchestrator to be resumable mid-session (which `charm resume` partially supports). Main risk: any state the orchestrator held that was not externalized is lost. Deferred; Changes 1-3 are much lower risk and address the same failure modes.

## Open Questions

1. How often does compaction actually fire in practice on a typical 3-wave, 8-ticket session? Without instrumenting token counts there is no baseline. Worth adding a log line in the daemon when the orchestrator session JSON shows evidence of compression (token count drop between wake-ups).

2. Does `/compact` with a focus prompt actually work in `--permission-mode auto` without human approval? If it requires interactive confirmation it cannot be embedded in the orchestrator prompt. Needs a test session to verify.

3. For Change 4 Option B: is `--append-system-prompt` on a second spawn of the same session valid, or does it only apply at fresh spawn? If not valid, the message-delivery approach needs a protocol so the orchestrator distinguishes "stage instructions" from "human operator messages."

## Status

draft -- pending review and a test session to validate Change 1 (proactive compaction) works end-to-end in auto mode.
