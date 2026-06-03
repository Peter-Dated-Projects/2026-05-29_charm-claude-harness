# CHARM workspace

This is a charm workspace: agents here run a staged, human-gated multi-agent
pipeline on one shared git tree. Your role behavior is set by the prompt injected
at spawn (`.charm/prompts/*.md`) — that is authoritative. This file only adds the
workspace facts and guardrails every agent shares.

## Guardrails

- **Respect your file scope.** There are no worktrees — all agents share one
  tree. Each ticket declares `touches:`; the daemon serializes overlapping scopes
  and agents coordinate through `.charm/COORDINATION.md`. Read it before editing,
  and stay inside your declared scope.
- **Never hand-edit or delete tickets.** `.charm/tickets/*.md` are canonical and
  `.charm/db.sqlite` is a rebuilt index over them — touching either by hand
  desyncs them. Ticket changes go through charm's MCP tools; to wipe the backlog,
  use the `charm-restart` skill.
- **Never clobber `.charm/kb/`.** It's the durable knowledge base the fleet
  accumulates — real work product. Only the `charm-reset-kb` skill replaces it,
  and only after explicit confirmation.

## Operator skills

When the user asks for one of these, read and follow that `SKILL.md` exactly —
don't improvise the operation.

| User asks to… | Follow |
| --- | --- |
| restart charm / reset the tickets / clear the ticket log / wipe the backlog | [charm-restart/SKILL.md](skills/charm-restart/SKILL.md) — kills ticketed agents, wipes tickets + db index, resets `COORDINATION.md`; daemon, KB, and session stay up |
| reset / wipe the knowledge base / start the kb fresh | [charm-reset-kb/SKILL.md](skills/charm-reset-kb/SKILL.md) — **destructive**; wipes `.charm/kb/` and restores the template scaffold; double-confirm first |
