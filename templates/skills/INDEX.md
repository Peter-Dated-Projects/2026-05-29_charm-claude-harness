# Charm operator skills

Procedures the orchestrator can run on the user's request. Match the user's
intent to a row, then **read that `SKILL.md` and follow it exactly** before
acting — do not improvise the operation from this table alone.

| If the user asks to… | Read & follow |
| --- | --- |
| restart charm / reset the tickets / clear the ticket log / wipe the backlog | `.charm/skills/charm-restart/SKILL.md` |
| reset the knowledge base / wipe the kb / clear the kb / start the kb fresh | `.charm/skills/charm-reset-kb/SKILL.md` |

Each skill delegates its actual mechanism to a `charm` subcommand
(`charm restart`, `charm reset-kb`), so it works in any project without
importing charm's source. From a source checkout, substitute `./charm.sh` for
`charm`.
