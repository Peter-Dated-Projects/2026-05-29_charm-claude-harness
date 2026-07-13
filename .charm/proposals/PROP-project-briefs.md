# project-briefs

**Status:** draft

---

## Problem

Today a charm session is anchored to a one-line **goal**: `charm start "add auth
token rotation"`. That goal becomes the orchestrator's kickoff message
([cli.ts:206](../../src/cli.ts#L206), pushed as the positional first turn in
[spawn.ts:419](../../src/daemon/spawn.ts#L419)). It works for a single ad-hoc
task, but it carries no standing operational context: what the project *is*, its
architecture, constraints, conventions, links, and current objective. Every
session re-derives that from scratch, and there's no way to say "work on Project
X" and have the fleet start already knowing X.

We want a durable, per-project **operational brief** the operator authors once
and reuses across sessions, plus a way to pick one at launch.

---

## Context / findings

Four pieces of the existing design make this cheap to add:

1. **Goal injection is already a "default first message."** The positional
   prompt mechanism the operator imagined already exists — it's the goal path.
2. **System-prompt assembly is a clean injection slot.**
   [`buildClaudeCommand`](../../src/daemon/spawn.ts#L209) stitches role prompt +
   baseline + rules + coordination + workspace guardrails into a
   `--system-prompt-file`. Adding a brief block is one more concatenation.
3. **A pre-daemon interactive TTY slot exists.**
   [`confirm-prompt.tsx`](../../src/cli/confirm-prompt.tsx) is an Ink prompt
   rendered in `charm start` *before* the daemon spawns and tmux attaches. A
   project picker drops into the same slot with the same lifecycle (render →
   resolve → `clear()` + `unmount()` → continue).
4. **A vestigial `projectMd: .charm/PROJECT.md` already exists**
   ([paths.ts:106](../../src/paths.ts#L106)) — defined but never read. This
   proposal repurposes that intent into a `project-briefs/` directory and removes
   the dead single-file path.

### Injection: why split system-prompt vs. first-message

The brief must survive two things a first-message-only approach does not:

- **Context compaction.** A first user turn gets consumed and can be summarized
  away; the system prompt persists for the whole conversation.
- **`charm resume`.** Resume rebuilds the system prompt but deliberately drops
  the positional prompt ([spawn.ts:419](../../src/daemon/spawn.ts#L419) — resume
  omits the kickoff so history isn't re-run). A brief in the first message would
  vanish on resume; a brief in the system prompt is re-injected faithfully as
  long as the selected brief is persisted in the session record.

So: **durable brief content → system prompt; kickoff → a pointer message.**

### Scope of injection: orchestrator only

Only the `main` agent gets the brief in its system prompt. Sub-agents receive
scoped tickets, and the orchestrator threads whatever brief context a ticket
needs into that ticket. This avoids adding brief-size tokens to every sub-agent
launch, and keeps the brief a planning-level input, not fleet-wide boilerplate.
(A future `--brief-fleet` flag could opt the whole fleet in; not in scope now.)

---

## Proposal

### Storage

- `.charm/project-briefs/<slug>.md`, one file per project.
- Frontmatter: `name`, `description`, optional `repo`, `created`. Body: freeform
  operational brief (what the project is, architecture, constraints,
  conventions, links, current objective).
- **Durable, git-tracked surface**, like `kb/` and `proposals/`. This is the
  easy-to-miss wiring: `ensureCharmGitignore`
  ([cli.ts:1130](../../src/cli.ts#L1130)) must add `!/project-briefs`, or the
  `/*` rule ignores the whole directory and briefs never commit.

### CLI

- `charm start` — unchanged (plain window or `[goal...]`).
- `charm start --project` (no value) — Ink picker: lists existing briefs,
  type-to-filter, plus a `+ Create new` entry.
- `charm start --project <slug>` — direct selection by slug/name, no TTY needed
  (scriptable; also what resume relies on internally).
- `--project` and a positional `[goal...]` may coexist: brief = standing
  context, goal = today's specific ask. A brief-only session runs off the
  brief's own "current objective" section.

### Create-new flow

Picker scaffolds `.charm/project-briefs/<slug>.md` from a template, then opens it
in `$EDITOR` (the operator's configured terminal editor, the same one
`git commit` uses). On save/exit, `start` proceeds with that brief. If `$EDITOR`
is unset, skip the editor, print the scaffolded path, and tell the operator to
fill it in and re-run — never force an editor choice.

### Injection

- New optional `SpawnSpec.projectBrief?: string` (the brief file contents).
- `buildClaudeCommand` appends a `CHARM_PROJECT_BRIEF` block to the system prompt
  for `role === "main"` only, e.g.:

  ```
  ## Project brief (standing context)
  This session is anchored to project "<name>". The following is authoritative
  operational context; the full file is .charm/project-briefs/<slug>.md.
  <brief body>
  ```

- Kickoff message becomes a pointer, not a dump:
  `Project: <name>. Your operational brief is standing context in your system
  prompt (full file: .charm/project-briefs/<slug>.md). [optional: Today's goal:
  <goal>.] Begin Stage 1 (Investigation) per your system prompt.`

### Persistence + resume

- Persist the selected slug in the orchestrator session record
  (`orchestrator-session.json`, written in the `start` action) as
  `project_brief`.
- `charm resume` re-reads the brief from that slug and passes it back into
  `buildClaudeCommand`, so the rebuilt system prompt still carries the brief.

### Prompts / docs

- `orchestrator.md` — short section: a session may be anchored to a **project
  brief** (authoritative standing context); the staged pipeline still applies
  unchanged. Distinguish from the ticket-level "handoff brief" produced by the
  `charm-planning` skill so the terms don't blur.
- `CHARM.md` — list `project-briefs/` among the durable surfaces.

### Wiring checklist

| File | Change |
| --- | --- |
| [paths.ts](../../src/paths.ts) | add `projectBriefsDir`; remove vestigial `projectMd` |
| [cli.ts](../../src/cli.ts) `scaffoldCharmDir` | `mkdir` project-briefs; seed a template brief |
| [cli.ts](../../src/cli.ts) `ensureCharmGitignore` | add `!/project-briefs` |
| **new** `src/cli/project-picker.tsx` | Ink fuzzy picker + create-new (`$EDITOR`) |
| [cli.ts](../../src/cli.ts) `start` | `--project` option, picker, resolve brief, pass to `buildClaudeCommand`, persist slug |
| [cli.ts](../../src/cli.ts) `resume` | re-read brief from persisted slug |
| [spawn.ts](../../src/daemon/spawn.ts) | `SpawnSpec.projectBrief`; `CHARM_PROJECT_BRIEF` block (main only); pointer kickoff |
| `templates/prompts/orchestrator.md` | project-brief section |
| `templates/charm/CHARM.md` | list project-briefs as durable surface |
| `templates/` | brief template file |

`charm.sh` needs no change — it forwards `"$@"`, and the picker renders on the
inherited TTY before `--no-attach` handoff, exactly like `confirm()` would.

---

## Alternatives considered

- **First-message-only injection.** Simpler, but the brief dies on
  `--compact`/summarization and disappears on `charm resume` (resume drops the
  positional prompt). Rejected.
- **Pointer-only (inject just the path, let the agent read the file).** Cheapest
  on tokens and always fresh, but relies on the agent choosing to read it before
  planning. Acceptable as a large-brief fallback; default is to inline for
  bounded operator-authored briefs.
- **Reuse `projectMd` as a single `.charm/PROJECT.md`.** One project per repo;
  can't hold multiple briefs or a picker. Rejected in favor of a directory.
- **Whole-fleet injection.** Adds brief-size tokens to every sub-agent launch for
  context the orchestrator can already thread into tickets. Deferred behind a
  possible future flag.

---

## Open questions

1. **Large briefs.** Inline the whole body into the system prompt, or a summary +
   path pointer past some size threshold? Default: inline; revisit if briefs grow.
2. **Brief lifecycle commands.** Do we want `charm project list/edit/rm` as
   first-class subcommands, or is file-on-disk + picker enough for v1? Lean: v1
   is picker + files only.
3. **Slug derivation on create.** Derive slug from the typed name
   (`sessionBaseName`-style sanitization), or ask separately? Lean: derive,
   show it, let the operator override.
