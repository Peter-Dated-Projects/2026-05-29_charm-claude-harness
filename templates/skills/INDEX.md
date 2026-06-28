# Charm operator skills

Procedures the orchestrator can run on the user's request. Match the user's
intent to a row, then **invoke that skill and follow it exactly** before
acting — do not improvise the operation from this table alone.

These skills ship in the `charm` Claude Code plugin (installed by
`frieren install`), so invoke them by their namespaced skill name via the Skill
tool — they are not files in this project.

| If the user asks to… | Invoke |
| --- | --- |
| restart charm / reset the tickets / clear the ticket log / wipe the backlog | `charm:charm-restart` |
| reset the knowledge base / wipe the kb / clear the kb / start the kb fresh | `charm:charm-reset-kb` |

Each skill delegates its actual mechanism to a `charm` subcommand
(`charm restart`, `charm reset-kb`), so it works in any project without
importing charm's source. From a source checkout, substitute `./charm.sh` for
`charm`.
