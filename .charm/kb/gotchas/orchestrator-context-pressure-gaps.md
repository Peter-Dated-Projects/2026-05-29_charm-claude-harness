---
id: orchestrator-context-pressure-gaps
root: gotchas
type: gotcha
status: current
summary: "The orchestrator accumulates context across all five stages with no proactive compaction, no persisted planning rationale, and no post-compaction recovery path -- three gaps that compound as session length grows."
created: 2026-06-13
updated: 2026-06-13
---

# Orchestrator Context Pressure Gaps

## The core problem

The orchestrator runs a single session from Stage 0 (discovery) through Stage 4 (test). By mid-Stage 3 its context contains: the full discovery interview, all planning deliberation, all reviewer output, and every agent done/blocked/reap cycle. Claude Code's auto-compression kicks in at some point and summarizes older history using its own heuristics -- which may or may not preserve what the orchestrator needs for good scheduling decisions.

## Gap 1: No proactive compaction

There is no mechanism to trigger compaction before context pressure forces it. Auto-compression fires reactively and without a targeted prompt, so it compresses generically rather than prioritizing the orchestrator's actual working set (current wave state, pending reaps, blocked tickets, approved project goal).

**Mitigation (not yet implemented):** Add a `/compact [focus]` instruction to the orchestrator prompt at natural stage transition points (e.g. after Stage 2 approval, before launching a new wave of workers). Claude Code's `/compact` accepts a focus prompt that directs what to preserve. The orchestrator.md stage transition notes are the right place to embed this.

## Gap 2: Planning rationale is context-only

The wave decomposition and dependency reasoning from Stage 1 live only in the orchestrator's context. After compaction, the WHY behind the ticket graph is gone. If a ticket is reassigned or descoped mid-Stage 3, the orchestrator has to re-derive structure from the ticket files alone.

**Mitigation (not yet implemented):** Have the planner write a `decisions/` KB note with the wave decomposition rationale and key dependency constraints before calling `create_tickets`. This costs one KB write per session but makes the planning rationale durable and readable by future sessions.

**References:**
- [Claude Code & Agent Memory: Best Practices for 2026](https://orchestrator.dev/blog/2026-04-06--claude-code-agent-memory-2026/) -- "neither compaction alone nor memory alone is sufficient for truly long-running work"
- [Context Compression in AI Agents: Hermes vs. Claude Code](https://mem0.ai/blog/how-hermes-and-claude-handle-context-compression-in-real-production-agents-(and-what-you-should-extract))

## Gap 3: No post-compaction re-orientation path

If the orchestrator is disoriented after compression (or after `charm resume`), there is no explicit recovery checklist in its prompt. In principle it can re-derive current state from `read_coordination()` + KB + ticket files, but this is not a documented recovery procedure.

**Mitigation (not yet implemented):** Add a recovery section to orchestrator.md: "If you are disoriented about where the session stands, re-read `read_coordination()`, check `list_tickets({statuses:['running','blocked','failed']})`, and skim `kb/INDEX.md` before acting. Do not guess the current wave from memory."

## Gap 4: Large orchestrator system prompt

The orchestrator's system prompt concatenates orchestrator.md + discovery.md + planner.md + CLAUDE.md + hardcoded CHARM_RULES before any user message is exchanged. This consumes context headroom upfront and means the planning instructions are live even after Stage 1 is complete, when they are no longer relevant.

**Mitigation options:**
- Split the prompt injection so discovery.md is appended only at Stage 0 start, and planner.md only at Stage 1 start. This requires a mechanism for the orchestrator to receive new system prompt content at runtime, which Claude Code does not currently support natively.
- Alternatively, trim discovery.md and planner.md to be shorter and more directive; most of the current verbosity is examples that could be condensed.

**Reference:** [LLM Orchestration in 2026 -- context management strategies](https://orq.ai/blog/llm-orchestration)

## What exists and works well

- KB two-tier navigation prevents bulk reads (see `decisions/0001-orchestrator-context-safeguards.md`)
- `charm resume` provides session reattach after terminal loss
- External state (COORDINATION.md, ticket files, KB) means re-orientation IS possible; the gap is that it is not documented as a first-class recovery procedure
- Sub-agents have short, scoped sessions -- context pressure is an orchestrator-specific problem, not fleet-wide

## References

- [AI Agent Orchestration Patterns: context window saturation](https://jobsbyculture.com/blog/ai-agent-orchestration-patterns-2026)
- [Multi-Agent Orchestration: hierarchical decomposition reduces orchestrator context load](https://www.augmentcode.com/guides/multi-agent-orchestration-architecture-guide)
- [Claude Code context window optimization](https://claudefa.st/blog/guide/mechanics/context-management)
- Related KB notes: `decisions/0001-orchestrator-context-safeguards.md`
