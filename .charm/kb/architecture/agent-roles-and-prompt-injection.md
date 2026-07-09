---
id: agent-roles-and-prompt-injection
root: architecture
type: architecture
status: current
summary: "Five agent roles (main, reviewer, worker, tester, plain), their lifespans, models, and how buildClaudeCommand assembles each agent's system prompt at spawn time."
created: 2026-06-13
updated: 2026-06-13
---

# Agent Roles and Prompt Injection

## The five roles

| Role | Stage | Mode | Lifespan | Default model |
|---|---|---|---|---|
| `main` (orchestrator) | 0-4 | interactive | full session -- never killed | Opus 4.8 |
| `reviewer` | 2 | interactive (resumable) | one ticket, exits on `report_status(done)` | Sonnet 4.6 |
| `worker` | 3 | interactive | one ticket, reaped by orchestrator | Sonnet 4.6 |
| `tester` | 4 | headless | one ticket, exits after checklist | Sonnet 4.6 |
| plain | -- | interactive | blank window, no orchestration instructions | Sonnet 4.6 |

The orchestrator is a real top-level `claude` process, not a subagent. It is the process that `charm start` launches. Its id is hardcoded as `MAIN_AGENT_ID = "main-001"` and is protected from `kill_agent` calls by any party, including itself.

Sub-agents are separate real `claude` processes in their own tmux panes, spawned by the daemon via `spawn_workers` / `spawn_review_agents` / `request_review`. This is the deliberate opposite of Claude Code's native subagent tool, which nests subagents inside the parent process context.

## How the system prompt is assembled

All prompt assembly happens in `src/daemon/spawn.ts:buildClaudeCommand`. The result is passed to each `claude` process via `--system-prompt`, which REPLACES Claude Code's default system prompt entirely (not `--append-system-prompt`, which layers on top of it) -- every spawned agent's instruction set is exactly what charm assembled, with no competing default persona to dilute it. Because the default is gone, the assembly also includes a CHARM_BASELINE layer (core agentic-coding discipline) and an ENV_INFO layer (cwd, git status, platform, today's date) that used to come free from the default prompt. There is no CLAUDE.md hook injection -- charm injects directly at spawn so guardrails reach only charm-spawned agents, not every `claude` run in the repo.

The assembled prompt is a concatenation of these layers, in order:

**1. Role prompt** -- read from `.charm/prompts/<role>.md` at spawn time.
The orchestrator (`main`) is special: its file is `orchestrator.md`, the complete
main-agent prompt (the gated-pipeline frame plus the two stages it runs
directly). It used to be assembled from `orchestrator.md` + `planner.md`; those
were merged into one file and `planner.md` no longer exists.
All other roles load a single `<role>.md`.

**2. CHARM_BASELINE** -- hardcoded block: core agentic-coding discipline (read before edit, no scope creep, git safety, security). Applied fleet-wide, including plain windows -- with `--system-prompt` replacing the default entirely, this is the only source of that guidance left.

**3. CHARM_RULES** -- hardcoded block: emoji ban, no-built-in-subagent rule, full MCP tool catalog with capability annotations. Applied fleet-wide.

**4. CHARM_COORDINATION** -- escalation ethos for the fleet: surface blockers early, lead with the decision you need, be terse. Applied to sub-agents only (not the orchestrator, not plain).

**5. CHARM_SKILLS** -- operator skills router (restart / reset-kb). Orchestrator only.

**6. CHARM_WORKSPACE** -- contents of `.charm/CHARM.md`, appended directly only for worktree spawns (shared-tree spawns get it via the repo-root CLAUDE.md's `@.charm/CHARM.md` import instead, since re-appending would double-inject it).

**7. modelLine** -- which model the agent is running as, with the instruction to surface (not swallow) context window overflow.

**8. ENV_INFO** -- cwd, is-git-repo, platform, OS version, today's date. Replaces the dynamic environment block Claude Code's default system prompt used to inject; needed for the same reason as CHARM_BASELINE.

## Hard tool removal

Three built-in Claude Code tools are removed at the API level for every agent:
`Agent`, `Task`, `Workflow`

This is a flag-level removal (`--disallowed-tools`) -- the tools leave the schema entirely. Agents cannot call them even if instructed to. All fan-out must go through the charm MCP tools, which the daemon mediates with dep/scope enforcement.

Note: the Bash escape hatch (running `claude` directly via Bash) is not closed by this flag; it would require sandboxing Bash, which workers need for their actual work.

## Model selection precedence

1. `CHARM_MODEL_<ROLE>` env override (per-role)
2. `CHARM_MODEL` fleet-wide override (`charm start -m`)
3. `CHARM_MODE` default (research -> Sonnet 4.6, development -> Opus 4.8)
4. `DEFAULT_MODEL_BY_ROLE` static fallback (main=Opus 4.8, others=Sonnet 4.6)

## Thinking token budgets

main: 64,000 (max); reviewer/worker/tester: 32,000 (high). Overridable per-role via `CHARM_THINKING_<ROLE>`.

## References

- `src/daemon/spawn.ts` -- `buildClaudeCommand`, `defaultModelForRole`, `defaultThinkingForRole`
- `.charm/prompts/*.md` -- role prompt files
- `.charm/CLAUDE.md` -- workspace guardrails (CHARM_WORKSPACE layer)
- [Architecture doc](../../docs/developing/architecture.md)
