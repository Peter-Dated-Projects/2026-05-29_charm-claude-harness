---
id: audit-existing-docs
root: decisions
type: decision
status: current
summary: "Audit of all docs/ files and root README.md: accuracy, completeness, cross-links, and terminology gaps as of 2026-06-16."
created: 2026-06-16
updated: 2026-06-16
---

# Docs Audit — Gap and Quality Report

Scope: every file under `docs/` plus the root `README.md`. Each file was read in
full, spot-checked against `src/`, and evaluated on completeness, accuracy relative
to the code at HEAD, consistency with other docs, and onboarding clarity.

---

## Per-file assessment

| File | Completeness | Accuracy | Consistency | Key issues |
|---|---|---|---|---|
| README.md | High | Partial | Partial | `update_plan` description wrong; "no worktrees" claim stale; worktree tools undocumented |
| docs/README.md | High | High | High | None |
| docs/operating/getting-started.md | High | High | High | None |
| docs/operating/running-a-session.md | High | High | High | None |
| docs/operating/modes-and-models.md | Medium | High | High | `haiku-4.5` not listed; per-role model defaults not explained |
| docs/operating/cli.md | High | High | High | None |
| docs/operating/keybindings.md | High | High | High | None |
| docs/operating/troubleshooting.md | High | High | High | None |
| docs/developing/architecture.md | High | High | High | ASCII diagram omits `charm-graph`; "no worktrees" claim stale |
| docs/developing/mcp-tools.md | Partial | High | High | Missing three worktree tools entirely |
| docs/developing/build.md | Medium | Partial | Partial | CLI binary name wrong; build output table incomplete |
| docs/developing/knowledge-base.md | Medium | Partial | High | Still reads as design doc despite feature being shipped |
| docs/developing/preflight.md | High | High | High | None |
| docs/design/parallelization.md | High | High | High | Generic content with no charm-specific anchoring |
| docs/design/phasing-sequencing.md | High | High | High | Contains internal ticket reference ("Research output for T-002") |

---

## Accuracy issues (code disagrees with docs)

### 1. `update_plan` writes to ticket activity log, not `COORDINATION.md`

**Where**: `README.md` line 107, in the MCP tools table.

The README says:
> `update_plan` | worker | upsert this agent's entry in `COORDINATION.md`

The code at `src/daemon/index.ts:930` (and `docs/developing/mcp-tools.md`) correctly
shows that `update_plan` appends to the ticket's activity log
(`.charm/tickets/<id>.md`) — not to `COORDINATION.md`. `COORDINATION.md` is
refreshed as a side effect, but the plan text is never written there.

**Fix**: Update the README's MCP tools table entry for `update_plan` to match the
description in `mcp-tools.md`.

### 2. README.md says "no worktrees (a deliberate rejection)" — worktree tools exist

**Where**: `README.md` lines 19 and 43; `docs/developing/architecture.md` echoes
the same claim ("There are no git worktrees — a deliberate rejection").

The code (`src/mcp/server.ts:128–160`) implements three tools — `create_worktree`,
`list_worktrees`, and `close_worktree` — and the `.charm/worktrees/` path is
established. The "no worktrees" framing is now inaccurate: worktrees exist as an
optional orchestrator-side tool for isolated parallel branches.

**Fix**: Update the README and architecture doc to describe worktrees as a
side-tool for non-overlapping parallel lines of work, not a rejected approach.
Add a section in `architecture.md` under "Coordination on one tree" that explains
the opt-in worktree model alongside the default shared-tree model.

### 3. `build.md` uses `charm-claude` as the installed CLI command

**Where**: `docs/developing/build.md`, install instructions near line 82.

The doc says:
```
charm-claude init && charm-claude start "your goal"
```

But `frieren.sh install` renames the binary: `install -m 0755 "dist/charm-claude" "$bindir/charm"`.
The installed command is `charm`, not `charm-claude`. Every other doc (README, cli.md,
getting-started.md) correctly calls it `charm`.

**Fix**: Replace `charm-claude` with `charm` in `build.md`'s install example.

### 4. `build.md` quick-build output table omits `charm-graph`

**Where**: `docs/developing/build.md` line 17.

The doc says:
> `bun run build → dist/charm-claude, dist/charmd, dist/charm-mcp, dist/charm-console`

But `dist/` also contains `charm-graph` (confirmed present). The architecture doc
correctly lists `charm-graph` as a binary.

**Fix**: Add `charm-graph` to the build output list in `build.md`.

### 5. `mcp-tools.md` missing three worktree tools

**Where**: `docs/developing/mcp-tools.md` — no mention anywhere.

`create_worktree`, `list_worktrees`, and `close_worktree` exist in
`src/mcp/server.ts:128–160` and are callable by the orchestrator. They are fully
absent from the MCP tools reference doc.

**Fix**: Add a "Worktrees" section to `mcp-tools.md` documenting all three tools,
their caller (orchestrator), and when to use them vs. the default shared-tree model.

### 6. `knowledge-base.md` reads as a design spec for an already-shipped feature

**Where**: `docs/developing/knowledge-base.md`, header block.

The document opens with:
> Status: **design** (file/dir layout + schema only). Prompt wiring and `charm init`
> integration are deliberately out of scope here and tracked as follow-ups.

The KB is fully operational: it exists, is git-tracked, and workers write to it
every session. The "open follow-ups" at the bottom (apply gitignore, scaffold on
init, wire prompt loop) may or may not be complete but the feature is shipped.

**Fix**: Update the status header to reflect current state. Verify each of the three
open follow-ups against the code and either mark them done or keep them as
genuine outstanding items.

---

## Completeness issues

### 7. `modes-and-models.md` does not explain per-role model differentiation

**Where**: `docs/operating/modes-and-models.md`.

The code (`src/daemon/spawn.ts:96–99`) shows that `DEFAULT_MODELS` assigns different
defaults per role:
- `main`: `opus-4.8`
- `reviewer`, `worker`, `tester`: `sonnet-4.6`

These defaults apply when no explicit `-m` flag or `CHARM_MODEL_<ROLE>` override is
set. The current docs say only "development mode defaults to Opus / research mode
defaults to Sonnet" at the fleet level, which understates what actually happens
(the orchestrator always starts on Opus in development mode regardless of mode default).

**Fix**: Add a note explaining that the orchestrator always defaults to Opus and
sub-agents default to Sonnet, with the mode flag adjusting what new spawns use.

### 8. `modes-and-models.md` and `cli.md` do not mention `haiku-4.5`

**Where**: `docs/operating/modes-and-models.md` (accepted values list);
`docs/operating/cli.md` (`-m` option description).

`docs/developing/preflight.md` instructs users to run the preflight with:
```
./charm.sh start -m haiku-4.5 --development "..."
```

But `haiku-4.5` is not in the `MODEL_ALIASES` map in `src/daemon/spawn.ts`, and
`modes-and-models.md` lists only `sonnet-4.6`, `opus-4.6/4.7/4.8` variants as
accepted short names. The docs don't explain that any raw `claude-*` id also works.

**Fix**: Clarify in `modes-and-models.md` and `cli.md` that raw `claude-*` ids are
accepted. Add `haiku-4.5` to the preflight's model note, or add it as a recognized
alias in `spawn.ts` so it isn't silently used as a pass-through.

### 9. `architecture.md` ASCII diagram omits `charm-graph`

**Where**: `docs/developing/architecture.md`, the ASCII diagram.

The binary table correctly lists `charm-graph` as a binary; the ASCII diagram in
`How a session is wired` does not show it.

**Fix**: Add `charm-graph` to the diagram, noting it opens in its own window.

---

## Terminology inconsistencies

| Term pair | Where | Assessment |
|---|---|---|
| "Stage 0/1/2/3/4" (pipeline stages) vs. ticket frontmatter `stage` field | All docs | No conflict — the pipeline stages use capital S ("Stage 0") and the ticket field uses lowercase. Consistent enough; no fix required. |
| "gate" | All operating docs | Used consistently for human approval checkpoints (stages 0, 2, 4 only). Consistent. |
| "ticket" vs. "task" | All docs | "ticket" is used throughout; "task" does not appear in place of "ticket". Consistent. |
| "phase" vs. "stage" | Design docs use "phase" as a generic term; operating docs use "Stage N" | Not a conflict — design docs are generic orchestration theory. Consistent within each context. |
| "worker" vs. "sub-agent" | README uses "sub-agent" informally; MCP doc and prompts use "worker" | Minor inconsistency. Not worth a sweep fix; acceptable for the intro vs. technical docs split. |

---

## Cross-link audit

All internal markdown links were traced. No broken links found. Every relative path
in every doc resolves to a file that exists at HEAD.

| Source file | Links checked | Broken |
|---|---|---|
| docs/README.md | 14 | 0 |
| docs/operating/getting-started.md | 5 | 0 |
| docs/operating/running-a-session.md | 1 | 0 |
| docs/operating/modes-and-models.md | 1 | 0 |
| docs/operating/cli.md | 1 | 0 |
| docs/operating/troubleshooting.md | 3 | 0 |
| docs/developing/architecture.md | 2 | 0 |
| README.md | 2 | 0 |
| All others | 0 | 0 |

Note: `mcp-tools.md` references `src/schema.ts` and `src/mcp/server.ts` as inline
code (backticks), not as hyperlinks — these are correct code references, not links.

---

## Top 5 highest-priority gaps to fix

1. **Worktrees are undocumented and contradicted**: The README and architecture doc
   actively deny that worktrees exist. The MCP tools doc omits them entirely. This is
   the highest-severity gap because an orchestrator agent reading the docs would
   never discover the `create_worktree` tool exists.

2. **`update_plan` description in README is wrong**: A worker reading the README
   would misunderstand where their plan goes. The mcp-tools.md is correct; the README
   is not. Low effort, high clarity payoff.

3. **`build.md` binary name error**: Anyone following `build.md` as the canonical
   install guide will call `charm-claude` and get a "command not found" on their
   installed binary. High user-facing confusion risk.

4. **`knowledge-base.md` is frozen in design mode**: The doc actively discourages
   treating the KB as real ("Status: design") when agents are writing to it every
   session. This undermines the agents' confidence in maintaining the KB.

5. **`mcp-tools.md` as the authoritative tool reference is incomplete**: Missing
   three tools means agents reading the doc to understand the full surface will miss
   `create_worktree`, `list_worktrees`, `close_worktree`.

---

## Suggested new docs that don't exist yet

1. **`docs/operating/worktrees.md`** — When to use worktrees vs. the default
   shared-tree model; how to open, work in, and close a worktree; the orchestrator's
   responsibility to close every worktree it opens.

2. **`docs/developing/session-isolation.md`** — The UUID-keyed session model, the
   `.charm/run/<uuid>/` layout, how multiple sessions coexist, and how `:q` targets
   only its own session. Currently scattered across README, architecture.md, and
   running-a-session.md but never consolidated.

3. **`docs/operating/approval-gates.md`** — A dedicated reference for the three
   gates (stages 0, 2, 4), what to look for before approving each, and how to
   approve via the console vs. the CLI. Currently implied across running-a-session.md
   but there's no single "how to be a good human in the loop" doc.

4. **`docs/developing/ticket-lifecycle.md`** — A standalone reference for the
   `status` and `stage` fields, all valid values, and the state machine. Currently
   in running-a-session.md but hard to find as a quick reference for agents writing
   against the schema.
