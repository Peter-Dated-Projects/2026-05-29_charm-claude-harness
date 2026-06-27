---
id: spawn-worktree-param-not-exposed-in-mcp-schema
root: gotchas
type: gotcha
status: current
summary: "The spawn RPCs (spawn_workers/spawn_investigators/request_review) now accept a `worktree` name param daemon-side to populate Agent.worktree_name, but the MCP tool schemas in src/mcp/server.ts do NOT declare it, so an orchestrator agent cannot pass it through the MCP surface yet -- only a direct RPC / console caller can."
created: 2026-06-26
updated: 2026-06-26
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
