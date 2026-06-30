---
id: spawn-worktree-param-not-exposed-in-mcp-schema
root: gotchas
type: gotcha
status: resolved
summary: "RESOLVED: the `worktree` param is now declared in the MCP inputSchemas for all four spawn tools (spawn_workers/spawn_investigators/spawn_researchers/request_review), so an orchestrator agent can direct agents into a worktree through the MCP surface. The fix also closed two downstream gaps a worktree spawn exposed: the ticket-read path and the CHARM.md guardrail injection (see Resolution below)."
created: 2026-06-26
updated: 2026-06-29
---

**Resolution (2026-06-29).** Exposing the param turned out to be only the first
of three coupled fixes — a worktree spawn doesn't work end-to-end with just the
schema change, because a worktree checkout omits all gitignored `.charm/`
control-plane state:

1. **Schema exposure.** Added `worktree: z.string().optional()` (with a `.describe()`)
   to the `inputSchema` of `spawn_workers`, `spawn_investigators`, `spawn_researchers`,
   and `request_review` in `src/mcp/server.ts`. The handlers already spread `...args`
   into the RPC, so it now threads straight through to the daemon.
2. **Ticket-read path.** The spawn prompts hard-coded a *relative* `Read .charm/tickets/<id>.md`.
   Tickets are gitignored, so a worktree checkout has no `.charm/tickets/`. Added
   `ticketReadPath(ticketId, cwd)` in `src/daemon/index.ts`: when cwd is a worktree it
   returns the absolute main-repo path (`join(paths.root, ".charm/tickets", ...)`),
   else the relative path unchanged. All ticket *mutations* already flow through the
   daemon to the main-repo store, so only the initial read needed redirecting.
3. **CHARM.md guardrails.** They reach agents via the root `CLAUDE.md` `@.charm/CHARM.md`
   import, which Claude Code loads only when cwd is the repo root. A worktree cwd plus a
   gitignored (absent) `.charm/CHARM.md` makes that import go dark. `buildClaudeCommand`
   in `src/daemon/spawn.ts` now appends the main-repo `CHARM.md` directly to the system
   prompt **only** when `spec.cwd` is set (a worktree spawn), avoiding double-injection
   in the shared-tree case.

The original gotcha, preserved below for context:

---

The daemon hierarchy backend (T-053) added an optional `worktree` param to the
spawn RPC inputs (`SpawnWorkersInput`, `SpawnInvestigatorsInput`,
`RequestReviewInput` in `src/schema.ts`). The daemon resolves it to a cwd via
`worktreePathFor` and threads it into `spawnAgentLocked`, which already called
`registry.setWorktree(basename(cwd))` -- so passing `worktree` is what finally
populates `Agent.worktree_name` (previously ALWAYS null because no caller passed a
cwd).

The footgun: the MCP tool definitions in `src/mcp/server.ts` declare
`inputSchema: { ticket_ids: z.array(z.string()) }` (and `{ ticket_id }` for
request_review) -- they do NOT include `worktree`. The MCP SDK validates args
against the tool's inputSchema before the handler runs, so even though the
handler spreads `...args` into the RPC call, an agent-supplied `worktree` is
stripped/rejected at the MCP boundary. It never reaches the daemon.

Consequence: today only a non-MCP caller (the console/operator, or a direct
`rpcCall(socket, "spawn_workers", { worktree })`) can actually set the worktree.
To let the orchestrator agent direct workers into a worktree, add
`worktree: z.string().optional()` to those three tools' `inputSchema` in
`src/mcp/server.ts` (out of T-053's `touches`, so deliberately left as a
follow-up). This was a scope boundary, not an oversight.

Related: the parent_id / sub_orchestrators half of the same backend is in
[[charm-session-socket-path-is-in-meta-json-not-run-dir]]'s sibling spec
(zed-phase-1-bridge-spec.md section 1.1-1.2).
