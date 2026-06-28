---
name: charm-reset-kb
description: Reset the charm knowledge base — wipe .charm/kb/ and restore it to the pristine template scaffold. DESTRUCTIVE; always double-confirm with the user before deleting. Use when the user asks to reset the database, reset/wipe the knowledge base, clear the kb, or start the kb fresh.
---

# Reset the knowledge base

The knowledge base lives at `.charm/kb/` — markdown files (`INDEX.md`,
`CONTRIBUTING.md`, and the `architecture/`, `conventions/`, `decisions/`,
`domain/`, `gotchas/` sections) that the agent fleet accumulates over a run.
`charm reset-kb` deletes it and restores the pristine template scaffold (a
faithful, byte-for-byte restore — the same scaffold `charm init` lays down).

Charm deliberately never clobbers an existing `.charm/kb/` during init/start
("accumulating data — never clobber it"), so `charm reset-kb` is the only way
back to the template. **The kb is real work product, and replacing it is
irreversible. Confirm before you touch it.**

## Scope — what this does and does NOT touch

- **Resets:** `.charm/kb/` only — deleted and re-copied from the template.
- **Leaves untouched:** `.charm/db.sqlite` (the ticket index — despite the
  "reset database" phrasing, this is NOT the database being reset), `tickets/`,
  `COORDINATION.md`, `meta.json`, `charm.json`, prompts, and all runtime state.

If the user actually wants to wipe the ticket store, that's the `charm-restart`
skill. If they want a whole fresh project (a full reset), that's `stop` →
`rm -rf .charm/` → `init` + `start`. Flag which they mean before proceeding.

## Step 1 — double-confirm (REQUIRED, do not skip)

The kb may hold hours of accumulated agent knowledge with no undo. Before
deleting anything, show the user what they'd lose and get an explicit yes.

1. Surface what's actually in the kb beyond the template, so the decision is
   informed:
   ```bash
   # Anything that exists only in the live kb, or differs from the scaffold,
   # is what a reset would discard.
   ls -R .charm/kb
   ```
2. Ask with `AskUserQuestion` (not an inline prompt). Make the destructive,
   irreversible nature explicit and name what's about to be lost. Offer a clear
   yes/no.
3. **Only proceed on an explicit yes.** Anything ambiguous → stop and ask again.
   Do not infer consent from the original "reset the kb" request — that request
   is what *triggered* the skill; the confirmation is a separate, deliberate gate.

If the user wants a safety net, offer to copy `.charm/kb/` to a timestamped
backup (e.g. `.charm/kb.bak/`) before wiping. Default to NOT backing up unless
asked, to avoid leaving stray dirs around.

## Step 2 — reset

Run from the project root (the dir holding `.charm/`):

```bash
charm reset-kb           # from a source checkout: ./charm.sh reset-kb
```

`charm reset-kb` confirms its template source exists before destroying the live
copy, so a missing template can't leave you with no kb at all. To target a
project rooted elsewhere, pass `--root <path>`.

## Caveats to flag

- **If charm is running**, the daemon and graph viewer watch `.charm/kb/`.
  Replacing the folder is fine — the watchers pick up the new (template) contents
  and the graph re-renders on the next change event. No restart needed. If the
  graph looks stale, nudge it by touching a kb file or use the `charm-restart`
  skill.
- **The live agents lose their accumulated knowledge.** Mid-run, in-progress
  agents keep their in-memory copy but write fresh from the blank template
  afterward. Usually you want to reset between runs, not during one — confirm
  timing if a session is active.
- **You get back whatever the template currently holds.** If the installed
  template has been customized, that's what's restored — which is intended.
