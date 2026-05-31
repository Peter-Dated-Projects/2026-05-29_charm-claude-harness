---
name: charm-restart
description: Reset a running charm session's ticket backlog — kill any agents currently working on a ticket, then wipe all tickets (markdown files + the db.sqlite index) and reset COORDINATION.md, leaving the daemon up. Use when the user asks to restart charm, reset the tickets, or clear the ticket log.
---

# Restart charm (reset the ticket backlog)

This skill clears the workflow's tickets so charm can re-plan from a clean slate. It does **not** stop the daemon, tmux session, or graph viewers — those stay up. It only resets ticket state.

To understand why each step is needed, two facts about how tickets are stored:

1. **Tickets live in two places.** The markdown files in `.charm/tickets/*.md` are the source of truth. The `tickets` table in `.charm/db.sqlite` is a *derived index* the daemon rebuilds from those files (`reindexAll()`) on startup. A clean wipe has to clear **both** — deleting only the files leaves `nextId()` counting up from the stale DB (it reads `MAX(id)` from the table), so the next ticket would be `T-007` instead of `T-001`.
2. **Deleting a ticket out from under a live agent breaks the daemon.** When an agent reports `done`/`failed`, the daemon calls `store.update(ticket_id, …)` with no error guard ([src/daemon/index.ts](../../../src/daemon/index.ts) `report_status`), and `update()` throws `unknown ticket` if the file is gone. So any agent mid-flight on a ticket must be **killed first**. Killing is safe: the `kill_agent` handler wraps its ticket update in try/catch, and tearing the agent down also removes its block from `COORDINATION.md`.

So a correct reset = kill ticketed agents → delete ticket files → clear the DB index → reset the coordination doc. The daemon reads tickets fresh from disk on every operation, so it picks up the empty backlog immediately — no restart required.

## When to use

- "restart charm" / "reset the tickets" / "clear the ticket log" / "wipe the backlog"
- The workflow's tickets are wrong and you want the orchestrator to re-plan from scratch
- You want a clean ticket slate but want to keep the daemon, KB, and session running

This skill leaves `kb/`, `meta.json`, and the daemon itself untouched. To wipe the knowledge base, use the `reset-kb` skill. To fully bounce the daemon (pick up daemon/MCP/console source changes), that's a `stop` + `start`, not this skill.

## How agents get killed

There's no operator-facing kill CLI — `kill_agent` is only a daemon RPC, reachable over the Unix socket at `.charm/sock`. The skill calls it as the **operator** (no `caller_id`, which `resolveCaller` treats as the privileged operator allowed to kill any agent). The charm MCP server's `kill_agent` tool is just a stdio shim that forwards to this same RPC, so calling the socket directly is the simplest path and needs no MCP client.

## Steps

Run from the repo root (the dir holding `charm.sh`), where `.charm/` lives. The one bun script below does the whole reset in the correct order; it's idempotent and degrades gracefully if the daemon is already down.

```bash
bun -e '
import { charmPaths } from "./src/paths.ts";
import { rpcCall } from "./src/daemon/rpc.ts";
import { Database } from "bun:sqlite";
import { readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const paths = charmPaths(process.cwd());

// 1. Kill every agent currently assigned a ticket (operator caller = no caller_id).
//    Done first so no agent reports done/failed against a ticket we are about to delete.
try {
  const { agents = [] } = await rpcCall(paths.socket, "status");
  const ticketed = agents.filter((a) => a.ticket_id && a.role !== "main");
  for (const a of ticketed) {
    await rpcCall(paths.socket, "kill_agent", { agent_id: a.id });
    console.log(`killed ${a.id} (was on ${a.ticket_id})`);
  }
  console.log(ticketed.length ? `killed ${ticketed.length} ticketed agent(s)` : "no ticketed agents to kill");
} catch (e) {
  console.log(`daemon unreachable (${e.message}) — skipping agent kill, continuing wipe`);
}

// 2. Delete the ticket markdown files — the source of truth.
let removed = 0;
if (existsSync(paths.ticketsDir)) {
  for (const f of readdirSync(paths.ticketsDir)) {
    if (f.endsWith(".md")) { rmSync(join(paths.ticketsDir, f)); removed++; }
  }
}
console.log(`removed ${removed} ticket file(s)`);

// 3. Clear the derived index so nextId() resets to T-001.
if (existsSync(paths.db)) {
  const db = new Database(paths.db);
  db.exec("DELETE FROM tickets");
  db.close();
  console.log("cleared tickets table in db.sqlite");
}

// 4. Reset COORDINATION.md, dropping any orphaned agent blocks.
writeFileSync(paths.coordinationMd, "# COORDINATION.md\n\n_Daemon will populate this as agents check in._\n");
console.log("reset COORDINATION.md");
'
```

After it runs, verify the slate is clean:

```bash
ls .charm/tickets/                                          # no T-*.md files
bun -e 'import {Database} from "bun:sqlite"; const c = new Database(".charm/db.sqlite").query("SELECT count(*) n FROM tickets").get(); console.log("tickets in db:", c.n)'   # 0
```

## Caveats to flag

- **The daemon keeps running.** This is a ticket reset, not a daemon bounce. If the goal is to pick up edited daemon/MCP/console source, that needs `./charm.sh stop` then `./charm.sh start` — not this skill.
- **`nextId` resets to `T-001`.** Because the DB index is cleared, the next ticket created starts the numbering over. That's intended for a clean backlog; flag it if the user expected IDs to keep climbing.
- **Only ticketed agents are killed.** Agents with no `ticket_id` (and the main orchestrator) are left alone. If a non-ticketed agent is holding stale context, the user can kill it separately or stop the session.
- **Session name.** The script uses the default socket at `.charm/sock`. If charm was started under a non-default `--root`, run from that root (or adjust `process.cwd()`); the tmux `--session` name doesn't matter here since this talks to the daemon socket, not tmux.
- **Want a full reset (KB + tickets + fresh goal)?** That's a fresh run: `reset-kb` for the knowledge base, this skill for tickets, or remove `.charm/` entirely and `./charm.sh init` + `start`.
