---
name: charm-restart
description: Reset a running charm session's ticket backlog — kill any agents currently working on a ticket, then wipe all tickets (markdown files + the db.sqlite index) and reset COORDINATION.md, leaving the daemon up. Use when the user asks to restart charm, reset the tickets, or clear the ticket log.
---

# Restart charm (reset the ticket backlog)

This skill clears the workflow's tickets so charm can re-plan from a clean slate.
It does **not** stop the daemon, tmux session, or graph viewers, and it does
**not** touch the knowledge base — those all stay up. It only resets ticket state.

The whole reset is one command, `charm restart`, which does the steps below in
the correct order. It is idempotent and degrades gracefully if the daemon is
already down. You do not need to reproduce the steps by hand — they are
documented here only so you understand what the command does and can explain it.

To see why the order matters, two facts about how tickets are stored:

1. **Tickets live in two places.** The markdown files in `.charm/tickets/*.md`
   are the source of truth. The `tickets` table in `.charm/db.sqlite` is a
   *derived index* the daemon rebuilds from those files on startup. A clean wipe
   clears **both** — deleting only the files leaves `nextId()` counting up from
   the stale DB (it reads `MAX(id)`), so the next ticket would be `T-007` instead
   of `T-001`.
2. **Deleting a ticket out from under a live agent breaks the daemon.** When an
   agent reports `done`/`failed`, the daemon updates that ticket and throws
   `unknown ticket` if the file is gone. So any agent mid-flight on a ticket is
   **killed first**. Killing is safe and also removes the agent's block from
   `COORDINATION.md`.

So `charm restart` = kill ticketed agents → delete ticket files → clear the DB
index → reset the coordination doc. The daemon reads tickets fresh from disk on
every operation, so it picks up the empty backlog immediately — no restart of
the daemon required.

## When to use

- "restart charm" / "reset the tickets" / "clear the ticket log" / "wipe the backlog"
- The workflow's tickets are wrong and you want the orchestrator to re-plan from scratch
- You want a clean ticket slate but want to keep the daemon, KB, and session running

## Steps

Run from the project root (the dir holding `.charm/`):

```bash
charm restart            # from a source checkout: ./charm.sh restart
```

To target a project rooted elsewhere, pass `--root <path>`.

Then verify the slate is clean:

```bash
ls .charm/tickets/       # no T-*.md files remain
```

## Caveats to flag

- **The daemon keeps running.** This is a ticket reset, not a daemon bounce. To
  pick up edited daemon/MCP/console source, that needs a `stop` then `start`.
- **`nextId` resets to `T-001`.** The DB index is cleared, so the next ticket
  starts numbering over. That's intended for a clean backlog; flag it if the user
  expected IDs to keep climbing.
- **Only ticketed agents are killed.** Agents with no `ticket_id` (and the main
  orchestrator) are left alone. If a non-ticketed agent holds stale context, the
  user can kill it separately or stop the session.
- **Want a full reset (KB + tickets)?** Reset the KB with the `charm-reset-kb`
  skill, the tickets with this one — or remove `.charm/` entirely and re-init.
