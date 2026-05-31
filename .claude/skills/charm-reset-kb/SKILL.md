---
name: charm-reset-kb
description: Reset the charm knowledge base — wipe .charm/kb/ and restore it to the pristine templates/kb/ scaffold. DESTRUCTIVE; always double-confirm with the user before deleting. Use when the user asks to reset the database, reset/wipe the knowledge base, clear the kb, or start the kb fresh.
---

# Reset the knowledge base

The knowledge base lives at `.charm/kb/` — markdown files (`INDEX.md`, `CONTRIBUTING.md`, and the `architecture/`, `conventions/`, `decisions/`, `domain/`, `gotchas/` sections) that the agent fleet accumulates over a run. The pristine "original" is `templates/kb/`, which `charm init` copies into `.charm/kb/` verbatim (plain `cpSync`, no placeholder substitution — a reset is a faithful byte-for-byte restore).

Charm has **no built-in reset.** The scaffold deliberately never clobbers an existing `.charm/kb/` (the comment in `scaffoldCharmDir` calls it "accumulating data -- never clobber it"), so the only way back to the template is to do it by hand. This skill is that procedure, with a guardrail: **the kb is real work product, and replacing it is irreversible. Confirm before you touch it.**

## Scope — what this does and does NOT touch

- **Resets:** `.charm/kb/` only — deleted and re-copied from `templates/kb/`.
- **Leaves untouched:** `.charm/db.sqlite` (the ticket index — despite the "reset database" phrasing, this is NOT the database being reset), `tickets/`, `COORDINATION.md`, `meta.json`, `charm.json`, prompts, and all daemon/runtime state.

If the user actually wants to wipe the ticket store or start a whole new workflow, that's a different operation (a fresh run: stop → `rm -rf .charm/` → `init` + `start`) — flag that and confirm which they mean before proceeding.

## Step 1 — double-confirm (REQUIRED, do not skip)

The kb may hold hours of accumulated agent knowledge with no undo. Before deleting anything, show the user what they'd lose and get an explicit yes.

1. Surface the current state so the decision is informed — what's actually in the kb beyond the template:
   ```bash
   # Files that exist in the live kb but not the template (pure additions),
   # plus any that differ from the template (edited since init).
   diff -rq templates/kb .charm/kb 2>/dev/null || echo "(.charm/kb missing or no template)"
   ```
2. Ask with `AskUserQuestion` (not an inline prompt) — make the destructive, irreversible nature explicit and name what's about to be lost (e.g. "N added files, M edited files; this cannot be undone"). Offer a clear yes/no.
3. **Only proceed on an explicit yes.** Anything ambiguous → stop and ask again. Do not infer consent from the original "reset the kb" request — that request is what *triggered* the skill; the confirmation is a separate, deliberate gate.

If the user wants a safety net, offer to copy `.charm/kb/` to a timestamped backup (e.g. `.charm/kb.bak/`) before wiping. Default to NOT backing up unless asked, to avoid leaving stray dirs around.

## Step 2 — reset

Run from the repo root (the dir holding `charm.sh` and `templates/`). Substitute the `.charm/` path if the workspace is rooted elsewhere.

```bash
# Sanity: confirm the template source exists before destroying the live copy,
# so a missing/renamed template can't leave you with no kb at all.
test -d templates/kb || { echo "ABORT: templates/kb not found"; exit 1; }

rm -rf .charm/kb
cp -R templates/kb .charm/kb
```

## Step 3 — verify

```bash
# Should now be byte-identical to the template: no output = clean reset.
diff -rq templates/kb .charm/kb && echo "kb reset to template"
```

## Caveats to flag

- **If charm is running**, the daemon and the graph viewer watch `.charm/kb/` for changes. Replacing the folder is fine — the file watchers pick up the new (template) contents and the graph re-renders to the empty scaffold on the next change event. No restart needed. If the graph looks stale, nudge it by touching a kb file or use the `restart` skill.
- **The live agents lose their accumulated knowledge.** If a workflow is mid-flight, resetting mid-run means in-progress agents that already read kb context keep their in-memory copy, but anything they write afterward starts from the blank template. Usually you want to reset between runs, not during one — confirm timing if a session is active.
- **Template drift.** This restores to whatever `templates/kb/` currently holds, which is the source of truth for a fresh init. If the template itself has been customized, that's what you get back — which is the intended behavior.
