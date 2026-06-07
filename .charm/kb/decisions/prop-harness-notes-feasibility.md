---
id: prop-harness-notes-feasibility
root: decisions
type: decision
status: current
summary: "Feasibility and effort assessment for all seven items in PROP-charm-harness-notes: settings UI, PROJECT-NNN naming, finished/ folder, git worktrees, orchestrator prompt as default, voice note project reference, and research-mode KB-write enforcement."
created: 2026-06-07
updated: 2026-06-07
---

# Feasibility: PROP-charm-harness-notes

Source proposal: `.charm/proposals/PROP-charm-harness-notes.md`

---

## 1 -- Settings UI pane

**Relevant code:**
- `src/console/app.tsx:14` — `Tab` type is `"artifacts" | "approvals" | "agents"`. The tab bar renders at line 438 and cycles via numeric keys `1/2/3` and tab/shift-tab.
- `src/paths.ts:89` — `claudeSettings` points to `<root>/.claude/settings.json`. No other settings store.
- `src/daemon/spawn.ts:84-92` — effective model/mode resolved from env vars (`CHARM_MODEL`, `CHARM_MODE`, `CHARM_MODEL_<ROLE>`) with no runtime override path back to a file.
- `src/daemon/rpc.ts` — the Console polls the daemon for `status`; it writes only via `approve_gate`, `dismiss_agent`, and `kill_agent` today.

**What exists vs. net-new:**
- The tab/panel scaffold in `app.tsx` is reusable; adding a fourth tab is a small structural change (update the `Tab` type, add a `4` key binding, extend the cycling logic, render a new component).
- A read-only settings view can be implemented purely client-side: read `.claude/settings.json` and the known env vars, render as a structured table. No new RPC needed.
- A writable settings view requires a new daemon RPC (e.g. `patch_settings`) and a JSON merge strategy for `.claude/settings.json`. There is no existing settings mutation path in the daemon.
- The "effective settings" surface is split across three sources (env vars, `.claude/settings.json`, and static defaults in `spawn.ts`). Displaying the merged view requires the Console to know all three, which means either the daemon exposes an `effective_settings` RPC method, or the Console re-implements the resolution logic locally.

**Effort:**
- Read-only pane: 1-2 days. Small code change in `app.tsx`, no daemon work.
- Full read/write with effective-config view: week+. Needs a new daemon RPC, settings merge logic, and careful handling of env-var overrides (which the Console cannot write).

**Risks / open questions:**
- Env vars cannot be written from the Console (they come from the shell that ran `charm start`). Any settings the UI writes to `.claude/settings.json` will be silently overridden if the corresponding env var is still set. The UI must make this visible.
- The proposal says "no new format"; confirm this means reusing the existing `.claude/settings.json` shape rather than a new `.charm/settings.json`.

---

## 2 -- PROJECT-NNN proposal naming + vended counter

**Relevant code:**
- `.charm/proposals/INDEX.md` — current naming convention is `PROP-<slug>.md` (no sequence number). The INDEX.md is maintained manually by agents; there is no tooling that reads or generates proposal filenames.
- `src/paths.ts` — no `proposalsDir` entry. The proposals folder is not referenced from any TypeScript source.
- `src/mcp/server.ts` — no proposal-related MCP tools exist.
- `src/console/app.tsx:55-78` — `useFileTree` lists only `PROJECT.md`, `COORDINATION.md`, and `tickets/*.md`. Proposals are invisible to the Console.
- `src/daemon/spawn.ts:224-230` — the skills index is injected into the main agent's system prompt. A "next proposal id" tool would fit the same injection pattern.

**What exists vs. net-new:**
- The INDEX.md table is the only existing structure. The counter is entirely net-new.
- A vended counter needs a backing store. Options: (a) scan existing `PROJECT-NNN-*.md` filenames at call time and return `max(NNN) + 1` — O(n), no persistent state; (b) add a row to the sqlite db — adds schema migration. Option (a) is simpler and race-safe if the MCP call is serialized through the daemon.
- MCP tool: `next_proposal_id` — new method in `src/mcp/server.ts` + daemon handler in `src/daemon/index.ts`.
- Console listing: add `proposalsDir` to `charmPaths` in `src/paths.ts`, extend `useFileTree` in `app.tsx` to include proposal files.
- Prompt update: add one sentence to the orchestrator and worker prompts specifying the naming scheme and tool.

**Effort:** 2-3 days (MCP tool + daemon handler + prompt edits + optional Console listing).

**Risks / open questions:**
- "PROJECT" in `PROJECT-NNN` is ambiguous — does it mean a fixed literal, or the actual project name (e.g. `CHARM-001-auth.md`)? The proposal uses `PROJECT-NNN` as a literal. Clarify before implementing.
- Counter scope: "per project" means per `.charm/` root. Two projects in different directories share nothing, so a scan-based counter is sufficient. If the project name is embedded in the filename, the scan logic must strip it consistently.
- The existing proposal files (`PROP-charm-harness-notes.md`) do not follow the new scheme. Decide whether to rename them or grandfather them.

---

## 3 -- `finished/` subfolder for accepted proposals

**Relevant code:**
- No TypeScript source references the proposals directory. The folder is purely file-system and markdown convention.
- `.charm/CLAUDE.md` (the workspace guardrails injected at spawn) mentions proposals at line ~20-30 but does not describe subfolder structure.

**What exists vs. net-new:**
- Entirely net-new convention. No code changes required.
- Implementation: create `.charm/proposals/finished/` (or let it be created on first use), update the CLAUDE.md guardrails to describe the accepted/superseded lifecycle, update the INDEX.md template to include a `status` column.
- The INDEX.md's `status` column already exists in the current template; adding an "accepted" and "superseded-by:<file>" state is a documentation change, not a code change.

**Effort:** Less than 1 day (template + guardrails edit only).

**Risks / open questions:**
- If item 2 (PROJECT-NNN naming) and item 3 (finished/ subfolder) ship together, the Console listing (if built) must handle two subdirectory levels in proposals/.
- Agents that glob `proposals/**` for context will pick up finished proposals. This is probably desirable (they are still valid historical context), but the prompt should clarify that `finished/` proposals are read-only reference, not active targets.

---

## 4 -- Git worktree support

**Relevant code:**
- `src/daemon/solver.ts:27-48` — `nextRunnable` flags a conflict whenever any `touches` glob of a candidate ticket overlaps any glob already in-flight. Worktree isolation would require this check to be skipped (or scoped) when the agents are in separate worktrees.
- `src/daemon/tmux.ts:62-76` — `splitPane` accepts a `cwd` option. Spawning a pane inside a worktree is already structurally supported; only the `cwd` value needs to change.
- `src/daemon/spawn.ts:163,279` — `buildClaudeCommand` takes `paths: CharmPaths` (rooted at the main tree) and writes an absolute `--mcp-config` path. This path points into the main tree; agents in a worktree resolve it correctly because it is absolute.
- `src/paths.ts:57-107` — all paths are anchored to `root` (the main tree). The `.charm/` directory lives in the main tree, so MCP socket, ticket files, and KB are always in one place regardless of how many worktrees exist. This is fine for MCP calls (CHARM_SOCKET is absolute) and for file tools using absolute paths.
- `src/daemon/registry.ts` — the `Agent` schema has no `worktree` field; the daemon has no mechanism to track or clean up worktrees.

**What exists vs. net-new:**
- Structural changes: `Agent` schema grows a `worktree?: string | null` field; `SpawnSpec` grows `worktree?: string`; `buildClaudeCommand` passes the worktree as `cwd` to `splitPane`; the daemon's spawn handler calls `git worktree add` before spawning and schedules `git worktree remove` on agent completion/failure.
- `solver.ts:nextRunnable` must accept a per-agent `worktree` annotation and skip the glob-conflict check when two tickets are in distinct worktrees.
- The daemon needs a new internal worktree registry (ticket_id -> worktree path) for cleanup.
- `charmPaths` does not need to change (`.charm/` stays in the main tree).

**Effort:** Week+ (daemon changes, solver change, spawn change, cleanup path, error handling for partial-branch state).

**Risks / open questions:**
- Merge/PR story: charm has no PR tooling today. Agents in worktrees produce branches that must be merged manually. The proposal leaves this open.
- Agent failure leaves a branch in a partial state. The cleanup path must call `git worktree remove --force` without deleting the branch (the human may want to inspect it), then optionally delete the branch via a separate operator command.
- Two agents writing `.charm/kb/` from different worktrees: both use absolute paths to the main tree, so writes serialize on the filesystem. This is safe but potentially racy without the existing file-lock used for COORDINATION.md writes. Confirm the lock covers KB writes too (currently it does not — KB files are written directly by agents without a daemon-mediated lock).

---

## 5 -- Orchestrator prompt pre-loaded on agent open

**Relevant code:**
- `src/daemon/spawn.ts:174-188` — the `else` branch for non-main roles loads only `${spec.role}.md` from `paths.promptsDir`. Workers get only `worker.md` + the shared CHARM_WORKSPACE + CHARM_RULES block.
- `src/daemon/spawn.ts:177-184` — the main agent concatenates `orchestrator.md`, `discovery.md`, `planner.md` in that order. `orchestrator.md` is the top-level frame.
- `.charm/prompts/orchestrator.md` — the frame describes the five-stage pipeline, approval gates, and the hard rule against premature fan-out. Stage-specific instructions (discovery interview, ticket generation) follow. Much of this is main-agent-specific.

**What exists vs. net-new:**
- Mechanically trivial: in the `else` branch at line 186, prepend `orchestrator.md` content to the role prompt before returning `rolePrompt`. One code change.
- The substantive question is what to include. `orchestrator.md` contains stage-0 and stage-1 instructions that are irrelevant and potentially confusing for a worker (a worker reading "do not call spawn_workers before discovery is approved" may over-interpret the constraint).
- Cleaner design (net-new file): extract harness-wide conventions out of `orchestrator.md` into a new `base.md` prompt (shared rules: KB conventions, MCP catalog, coordination board usage). Workers get `base.md` + `worker.md`; main gets `base.md` + `orchestrator.md` + `discovery.md` + `planner.md`. This avoids injecting stage-specific orchestrator instructions into workers.
- The `base.md` approach requires splitting `orchestrator.md` and updating `buildClaudeCommand`, but produces cleaner per-role prompts.

**Effort:**
- Naive concatenation of full `orchestrator.md` into all roles: half a day (one code change + test). Risk of worker confusion is real.
- Clean `base.md` extraction: 1-2 days (file split, prompt review, `buildClaudeCommand` update).

**Risks / open questions:**
- The existing `worker.md` already duplicates some harness conventions (MCP catalog, coordination protocol). If `base.md` is introduced, `worker.md` should be pruned to avoid contradictions.
- System prompt size increases for every agent. At large context windows this is not a concern, but the duplication of the full MCP catalog across both the system prompt and the CHARM_RULES block (injected separately at line 193-218 of spawn.ts) is already redundant. A `base.md` extraction is also an opportunity to clean that up.

---

## 6 -- Voice note project reference

**Relevant code:**
- `.charm/prompts/orchestrator.md` — no mention of voice notes. The voice note convention is in the operator's global `ASSISTANT.md` (outside this repo), not in any charm prompt file.
- `voice_note.py --context` (operator script) accepts a `<=15 word` description that is shown in the coordination queue when another agent is already speaking. The `--context` value is explicitly designed for this kind of situational label.
- There is no "project name" field in any charm data structure. The closest are: `SESSION_DESCRIPTION` (set by `set_session_description`, stored in `.charm/run/<uuid>/meta.json`), and `basename(root)` (derivable from the filesystem path).

**What exists vs. net-new:**
- Entirely a prompt edit. No code changes.
- Add a section to `orchestrator.md` (or a new `base.md` if item 5 ships) specifying: when calling `voice_note.py`, prepend the project name to the message text and include it in `--context`. The project name can be derived from `.charm/PROJECT.md`'s first non-blank line, or from `meta.json`'s description field.
- Agents already have filesystem access to both of those files.

**Effort:** Less than half a day.

**Risks / open questions:**
- If the session description hasn't been set yet (early in a session, before Stage 0 completes), the agent has nothing to reference. The prompt should specify a fallback: use `basename(root)` from the charm paths.
- The convention only takes effect for newly spawned agents after the prompt is updated; existing running agents in a session won't pick it up.

---

## 7 -- Research-mode prompt variant with KB-write enforcement

**Relevant code:**
- `src/daemon/spawn.ts:50-55` — `CharmMode` is `"research" | "development"`. The mode is read from `CHARM_MODE` env var and currently only affects the default model selection (Sonnet vs Opus). It has no effect on which prompt file is loaded.
- `src/daemon/spawn.ts:186-187` — the non-main role branch loads `${spec.role}.md` unconditionally, with no mode awareness.
- `src/mcp/server.ts` + daemon index — `set_ticket_status` has no pre-condition hooks; a worker can call it with `status=complete` at any time.
- `.charm/prompts/worker.md` — the existing worker prompt says "write any findings to `.charm/kb/`" but frames it as optional post-implementation guidance, not a hard gate.

**What exists vs. net-new:**
- **Prompt-only enforcement (simpler):** Add `worker-research.md` to `.charm/prompts/`. In `buildClaudeCommand` at line 186, check `process.env.CHARM_MODE === "research"` and load `worker-research.md` instead of `worker.md`. The new prompt instructs the agent to refuse to call `set_ticket_status(status=complete)` until at least one KB file has been created or updated in this session. No daemon changes.
- **Daemon-level enforcement (stronger):** In the `set_ticket_status` handler, when a research-mode ticket transitions to `complete`, check whether any file under `.charm/kb/` was written by this agent during this session. This requires tracking file writes per agent (either via a new MCP tool `log_kb_write` that agents call, or by diffing git status at transition time). Neither mechanism exists today.
- Git status diff at completion time is the most reliable approach: `git diff --name-only HEAD` filtered to `.charm/kb/**`. This works without any new per-agent tracking, but requires the agent to have committed its KB writes before calling `set_ticket_status(complete)` — which the current worker prompt already asks for (step 6 of the Mandatory protocol).

**Effort:**
- Prompt-only enforcement: 1 day (new prompt file + `buildClaudeCommand` mode-awareness).
- Daemon-level KB-write gate via git diff: 2-3 days (daemon handler change + git integration + error messaging back to agent).
- Full tracking via new MCP tool: week+ (new tool, new schema, new daemon state).

**Risks / open questions:**
- Research workers that update an existing KB note rather than creating a new file will satisfy the intent but not a naive "new file created" gate. The gate must check for modifications too, not just creations.
- If the agent crashes or is killed before committing, git diff shows nothing even if the agent did meaningful KB work. The prompt-only approach avoids this false negative at the cost of being bypassable.
- Research mode and development mode are set fleet-wide via `CHARM_MODE`. Mixed sessions (some research tickets, some development tickets) would give all workers the same prompt. Per-ticket mode annotation (a `mode` field on the ticket frontmatter) would be cleaner but is a larger schema change.
