# PROP-agent-capability-enforcement

**Status:** draft

---

## Problem

The charm daemon enforces some role-based access controls today, but the
enforcement is ad-hoc: each restricted tool has its own inline check, the
checks are inconsistent in depth, and there is no single authoritative
description of which role is allowed to call what. This makes it easy for a
new tool to accidentally ship without enforcement, and hard for an operator or
reviewer to audit the security surface of the pipeline.

The specific risks:

1. **Self-scoped operations are not daemon-verified.** `report_status`,
   `set_ticket_status`, and `update_plan` are documented as self-scoped (an
   agent acts only on its own ticket/state), and the MCP shim enforces this by
   injecting `CHARM_AGENT_ID` as `agent_id`. But the daemon does not cross-
   check that the caller's identity matches the `agent_id` in the request. Any
   agent with raw socket access could manipulate another agent's state by
   sending a crafted RPC with a different `agent_id`.

2. **`set_session_description` is unrestricted.** Any agent can overwrite the
   session description surfaced to the operator in `charm list`. There is no
   role guard.

3. **The capability model lives only in prose.** The CLAUDE.md prompt text and
   code comments describe what each role can do, but there is no machine-
   readable declaration. Enforcement is a side-effect of inline `if` checks
   scattered across `src/daemon/index.ts`, not a first-class table.

4. **No phased roadmap.** Future hardening ideas (cross-agent read isolation,
   rate limits, per-role tool allow-lists) exist as comments and mental notes
   but are not captured as a staged plan.

---

## Context / Findings

### Current enforcement inventory

Calling convention: every MCP tool call flows through `src/mcp/server.ts`,
which injects `CHARM_AGENT_ID` as `caller_id` (for orchestrator-gated tools)
or `agent_id` (for self-scoped tools). The daemon's RPC switch in
`src/daemon/index.ts` checks roles via `resolveCaller(caller_id)` and
`assertOrchestrator(caller_id, tool)`.

**Orchestrator-only** (enforced at daemon, `assertOrchestrator` or equivalent):
- `create_tickets`, `promote`
- `spawn_workers`, `spawn_review_agents`, `request_review`
- `cancel_ticket`
- `continue_agent`
- `set_ticket_state` (cross-ticket state write, orchestrator-driven)

**Self-kill-only** (enforced at daemon, `kill_agent`):
- Sub-agents may kill only themselves; orchestrator/operator may kill any agent.

**Self-scoped by shim injection, not daemon verification**:
- `report_status` — `agent_id` injected by shim; daemon calls
  `registry.setState(input.agent_id, ...)` without checking
  `input.agent_id === AGENT_ID_OF_CALLER`.
- `set_ticket_status` — same pattern.
- `update_plan` — same pattern.

**Unrestricted (no role guard)**:
- `set_session_description` — any agent; operator-intent operation.
- `await_approval` — any agent; intentional (agents need to park at gates).
- `read_coordination`, `list_tickets`, `list_agents` — any agent; intentional
  read-only views.
- `open_graph` — any agent; side-effect-free UX call.

### The `resolveCaller` mechanism

`resolveCaller(caller_id)` maps a caller to one of `"operator"`, `"main"`, or
an `AgentRole`. An undefined `caller_id` maps to `"operator"` (the console /
CLI path, which sends no id). `MAIN_AGENT_ID = "main-001"` is a hardcoded
constant; the orchestrator's pane exports this exact string as
`CHARM_AGENT_ID`. Sub-agent ids are `role-NNN` (e.g. `worker-002`).

The mechanism is sound for orchestrator-gating. The gap is that self-scoped
operations (report_status etc.) use `agent_id`, not `caller_id`, so
`resolveCaller` is never invoked for them.

---

## Proposal

### Phase 1 — close the current gaps (low effort, high value)

**1a. Add daemon-side self-scope verification for `report_status`,
`set_ticket_status`, and `update_plan`.**

Add a `caller_id` field to the input schemas for these three operations. The
shim already injects `CHARM_AGENT_ID` for `agent_id`; extend the shim to also
pass it as `caller_id`. The daemon verifies `input.agent_id === input.caller_id`
(or equivalently, that `resolveCaller(caller_id)` resolves to the same agent
as `registry.get(agent_id)`). An agent that sends a mismatched pair gets a
hard error. This closes the raw-socket impersonation path without changing any
agent-facing behavior.

**1b. Restrict `set_session_description` to orchestrator/operator.**

Add `assertOrchestrator(input.caller_id, "set_session_description")` to the
`set_session_description` case. The shim injects `caller_id` already for other
orchestrator-only tools; extend it for this one. Sub-agents have no legitimate
reason to rename the session.

**1c. Add a capability table to schema.ts (or a new capabilities.ts).**

Replace the scattered inline comments with a single declarative table:

```ts
// Illustrative shape — exact implementation TBD
const CAPABILITIES: Record<string, { roles: AgentRole[] | "all" }> = {
  create_tickets:          { roles: ["main"] },
  spawn_workers:           { roles: ["main"] },
  report_status:           { roles: "all", selfScoped: true },
  set_session_description: { roles: ["main"] },
  read_coordination:       { roles: "all" },
  // ...
};
```

The table becomes the reference; enforcement code imports it rather than
embedding the same `if (role !== "main")` check repeatedly. This is a
refactor, not a behavior change.

### Phase 2 — per-role prompt-level capability declarations

Emit the allowed tool list for each role into the system prompt so agents do
not attempt forbidden calls and waste a turn waiting for a rejection:

- Orchestrator prompt: full tool list.
- Worker prompt: omit orchestrator-only tools from the catalog section;
  keep `report_status`, `set_ticket_status`, `update_plan`, `await_approval`,
  `read_coordination`, `list_tickets`.
- Reviewer/tester prompts: same as worker, or further restricted as needed.

This is a prompt-engineering change (`templates/prompts/*.md` + `spawn.ts`
CHARM_RULES block) rather than a runtime enforcement change. It reduces
misdirected tool calls without requiring any new daemon logic.

### Phase 3 — cross-agent read isolation (deferred)

Restricting agents to reading only their own ticket's activity log and the
COORDINATION.md summary (rather than the full store) is the natural next step
but it requires a meaningful read-path rework and adds complexity that the
current fleet size does not justify. Capture as a future proposal rather than
building now.

Worktree-per-agent isolation (giving each agent its own git worktree so file
edits cannot interfere) is explicitly deferred to a separate proposal. It is a
large structural change with its own tradeoffs around merge-back, the shared
`.charm/` directory, and tmux session topology.

---

## Alternatives considered

- **Trust the shim entirely and skip daemon verification.** The shim is the
  only production path, and it injects the correct id. Rejected: "the shim
  will always be the only caller" is a fragile assumption. The daemon socket is
  accessible to anything in the tmux session; a prompt-injected agent or a
  debugging script could bypass the shim. Defense-in-depth at the daemon layer
  costs almost nothing.

- **Add caller_id to ALL operations including read-only ones.** Over-
  engineering: `read_coordination` and `list_tickets` have no state side-
  effects. Enforcing identity for reads adds noise without security value.

- **Implement a formal capability system (ACL table evaluated at dispatch).**
  The capability-table in Phase 1c is a step toward this but stops short of a
  generic evaluator. A full ACL evaluator is warranted only once the tool count
  and role count grow enough that the table has more than one dimension of
  variation. Today it does not.

---

## Open questions

- Should `await_approval` remain unrestricted? The current design allows any
  agent to park at a human gate, which seems correct. But a misbehaving sub-
  agent could flood the approval queue. Rate-limit or orchestrator-only may be
  worth revisiting if the queue is ever abused in practice.

- Phase 1c capability table: should it live in `schema.ts` alongside the Zod
  schemas, or in a dedicated `capabilities.ts`? The schemas and capabilities
  are related but serve different consumers (parse vs. dispatch).

- For Phase 2 prompt trimming: should the disallowed-tools list be passed to
  `buildClaudeCommand` via `--disallowed-tools` (Claude CLI flag, hard block)
  or only omitted from the prompt catalog (soft guidance)? Hard-blocking via
  CLI flag is more reliable but requires knowing the exact tool names the MCP
  server registers.

---

## Status

draft
