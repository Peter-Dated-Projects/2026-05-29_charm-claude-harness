# bug-triage-and-session-continuity

**Status:** draft

---

## Problem

Two operator-facing symptoms surfaced during use:

1. **The console sidebar dies when viewing files.** Opening a file in the Files
   tab sometimes leaves the console pane dead / blank for the rest of the run.
2. **Chats cannot be resumed.** After quitting a session, there is no way back
   into the orchestrator conversation; it feels like sessions are not being
   saved.

A codebase audit run alongside these reports also surfaced a cluster of latent
correctness, lifecycle, and durability bugs that have not yet bitten visibly but
will. This document gives the root cause of each, groups them by the underlying
design fault, and lays out a prioritized fix plan so the work can be ticketed.

---

## Context / Findings

### A. Session continuity — the "can't resume" symptom

The headline finding: **sessions are being saved correctly; charm simply has no
mechanism to return to them.**

Evidence gathered:

- Claude Code writes a transcript per session to
  `~/.claude/projects/<munged-cwd>/<session-uuid>.jsonl`. The project store for
  this repo holds dozens of saved transcripts — persistence is working.
- charm does **not** override `HOME` or `CLAUDE_CONFIG_DIR` for any spawn, and
  both the orchestrator (`cli.ts`, main pane spawned with `cwd: paths.root`) and
  every sub-agent (`daemon/index.ts`, `splitPane({ cwd: paths.root })`) launch in
  the project root. Transcripts therefore land in the standard per-project store,
  the same place a plain `claude` invocation in this repo would write them.
- **Root cause:** `buildClaudeCommand` (`daemon/spawn.ts`) never passes any
  session flag. The only flags it emits are `-p` (sub-agents), `--model`,
  `--permission-mode`, `--mcp-config`, `--disallowed-tools`,
  `--append-system-prompt`, and the positional prompt. There is no
  `--session-id`, `--resume`, or `--continue` anywhere in the spawn path. Every
  `charm start` launches a brand-new Claude session with no link to any prior
  conversation.
- charm also never **captures** the Claude-side session UUID. It tracks its own
  `randomUUID()` (used to namespace the run dir and tmux session), the tmux pane
  id, and `CHARM_AGENT_ID` — none of which is the Claude session id. So even with
  intent to resume, charm holds no handle to resume by.
- `charm attach` only re-attaches to a **live** tmux session. Once the operator
  quits (`:q` -> `tmux kill-session`) or runs `charm stop`, the orchestrator's
  `claude` process is gone and its transcript is orphaned from charm's control
  plane. It is still resumable by hand (`claude --resume` from the repo root),
  but charm surfaces no path to it.

The installed Claude Code (2.1.x) supports the flags needed to fix this:
`--session-id <uuid>` (launch with a caller-chosen id), `-r/--resume [value]`
(resume by id), `-c/--continue` (most recent), and `--fork-session` (resume into
a fresh id without mutating the original).

### B. The "sidebar dies on file view" symptom

The Files tab's own read and render paths are **well-guarded**, so the crash is
not where it appears to be:

- File reads are wrapped in `try/catch` (`console/app.tsx`, `useFileContent`),
  falling back to `"(file not readable)"`.
- Binary files are sniffed for null bytes and decoded with a strict
  (`fatal: true`) UTF-8 decoder inside `try/catch` (`console/file-tree.tsx`),
  treating undecodable input as binary rather than throwing.
- Viewer geometry is floored (`viewerWidth = max(8, ...)`,
  `viewerHeight = max(1, ...)`), and there is an explicit comment that a file
  deleted between selection and render must not throw during render.

The actual culprit is finding **#2 below**: the orphan-pane sweep can kill the
console pane. With session-level `remain-on-exit on`, a console process that dies
for any reason (a transient render error, OOM, an accidental key) leaves a *dead
but listed* pane; the next sweep tick sees a dead pane that is not in its
protected set and kills it permanently. A recoverable blip becomes a dead
sidebar for the rest of the run. This is the bug to fix for symptom 1.

### C. Audit findings, grouped by root fault

The eleven confirmed bugs cluster into a few underlying faults rather than being
independent:

**Fault 1 — the lifecycle code assumes one agent per ticket and one clean exit.**
A ticket can legitimately carry a worker plus a reviewer or tester at once, and
agents can die uncleanly. Three bugs flow from this assumption:

- **#1 (high) — teardown reaps only the first agent on a ticket.** Both the
  terminal-state path in `set_ticket_state` and `cancel_ticket`
  (`daemon/index.ts`) use `registry.list().find(... ticket_id === ...)`, which
  returns a single agent. A second agent on the same ticket is never torn down:
  its pane lingers and it keeps consuming a concurrent-agent slot. Over a run the
  fleet silently clogs until it can no longer spawn.
- **#6 (medium) — the liveness sweep forces a ticket to `failed` on any agent
  death.** When the sweep reaps a dead pane it unconditionally sets the ticket
  `failed`/`failed` regardless of the agent's role or the ticket's current
  status. A tester or reviewer dying on a ticket a worker already marked
  `complete` resets it to `failed` and triggers a redundant retry of finished
  work.
- **#4 (medium) — an agent killed while parked in `await_approval` leaves a
  zombie gate.** The approval gate lives in the queue's `waiters` map until
  `resolve` is called, but `tearDownAgent` never cancels a gate the dying agent
  was waiting on (there is no agent->gate link). The gate persists on the
  operator board forever and broadcasts to console listeners; one accumulates per
  killed-while-waiting agent.

**Fault 2 — pane lifecycle safety.**

- **#2 (high) — the orphan-pane sweep can kill the console pane.** The sweep
  builds its protected set from `agentPaneIds` only; the console pane id, tracked
  separately and never added to that set, is unprotected. Combined with
  `remain-on-exit on`, a dead console pane is killed on the next sweep. (See
  section B — this is symptom 1.)

**Fault 3 — RPC framing decodes bytes too early.**

- **#3 (medium) — multibyte UTF-8 split across socket reads is corrupted.** Both
  the daemon server and the client call `chunk.toString("utf8")` on each raw
  socket chunk *before* concatenating with the leftover buffer. A multibyte
  codepoint whose bytes straddle two reads decodes to replacement characters
  (`U+FFFD`). Large payloads with any non-ASCII content (a ticket body with an
  accented character or emoji) silently corrupt, since `U+FFFD` inside a JSON
  string still parses. Newline framing itself is fine; only multibyte content is
  affected.
- **#9 (low) — bad-request reply uses `id:"?"`, which never correlates.** On a
  parse failure the server replies with a sentinel id the client can never match
  (it correlates strictly on `resp.id === id`), so the caller waits out the full
  timeout. Worse, the client does not advance its read buffer past the
  unmatched frame, so the connection can wedge until timeout. Only reachable from
  a malformed/external client, hence low.

**Fault 4 — concurrency in the spawn path.**

- **#5 (medium) — concurrent spawn handlers double-spawn on overlapping
  touches.** `spawn_workers` computes the runnable set from `inFlight()` *before*
  entering the layout lock, and a freshly spawned agent stays in the `spawning`
  state (invisible to `inFlight()`, which counts only `running`/`blocked`)
  throughout the `splitPane` subprocess. Two near-simultaneous spawn calls can
  each pick a ticket touching the same file; both pass the count-only cap guard
  and spawn, producing two workers editing one file concurrently — the exact
  write-conflict the touches machinery exists to prevent. A single batched
  `spawn_workers` call is safe (its one solver pass de-conflicts internally);
  the race needs two overlapping calls.

**Fault 5 — graph integrity.**

- **#7 (medium) — a dangling `depends_on` id deadlocks a ticket silently.** The
  solver only adds a graph edge for a dependency that resolves to a real ticket,
  so a typo or stale id is excluded from the cycle check — yet `depsReady` still
  requires every listed id to be in the `completed` set, which a non-existent id
  can never enter. The ticket lands in `deferred` on every spawn attempt forever,
  with no error surfaced. A single typo hangs a ticket.

**Fault 6 — store durability.**

- **#11 (low) — ticket `.md` files are written non-atomically.** `create`,
  `update`, and `promoteDraft` persist with a bare `writeFileSync`, while
  `COORDINATION.md` uses an atomic temp-file + fsync + rename. The asymmetry cuts
  the wrong way: the canonical ticket file (which the entire sqlite index is
  rebuilt from on daemon start) is the one written unsafely. A crash mid-write
  leaves corrupt frontmatter; the next start's index rebuild throws and the
  daemon fails to boot, since the rebuild is not wrapped in `try/catch`.
- **#10 (low) — `nextId()` string-sorts ids and clobbers past 999.** Ids are
  selected with `ORDER BY id DESC` on a TEXT column and zero-padded to three
  digits, so once `T-1000` exists, `T-999` sorts lexically higher and is returned
  as the max; the next id computes back to `T-1000`, overwriting the existing
  file and index row. Requires 1000+ tickets, hence low, but it is silent data
  loss with no guard.

**Fault 7 — Files-tab state hygiene (cosmetic).**

- **#8 (low) — `defaultExpanded` expands gitignored `.charm` subdirs.** It marks
  `.charm` subdirs expanded via a filesystem check independent of the git-allowed
  filter, so a gitignored subdir is expanded and watched but never rendered as a
  row. The result is wasted watcher subscriptions and spurious re-renders on
  writes into those dirs (which agents touch frequently), with no visible output.
  Not the crash, but a real state/efficiency divergence.

---

## Proposal

Fix in priority order. Priorities reflect active pain first, then silent
corruption / fleet degradation, then latent edge cases.

### P0 — active pain

**Fix #2 (console-pane sweep guard).** Add the console pane id to the sweep's
protected set before the orphan pass:

```ts
const knownPanes = new Set(agentPaneIds);
if (consolePaneId) knownPanes.add(consolePaneId);
```

Then decide a policy for a genuinely dead console pane: prefer respawning the
console (it is a recoverable process) over killing it, or at minimum leave it
alone. This resolves symptom 1.

**Build session continuity (the "can't resume" problem).** Three pieces:

1. **Stamp a session id at spawn.** Generate a UUID per agent in
   `buildClaudeCommand`/`spawnAgent` and pass `--session-id <uuid>` so charm —
   not Claude — owns the id. Record it on the registry entry and persist it in
   the session `meta.json` (and, for the orchestrator, in the per-directory
   last-session record) so it survives a daemon restart.
2. **Add a `charm resume [session]` command.** Relaunch the orchestrator pane
   with `claude --resume <stored-uuid>` (or `--continue` for the most recent),
   re-supplying the same `--mcp-config`, `--append-system-prompt`, and model the
   original spawn used, and re-registering the pane with the daemon. This is the
   path the operator actually wants: pick up the prior orchestrator chat where it
   left off, fully wired back into the control plane.
3. **Consider `--fork-session`** for the case where the operator wants to branch
   from a prior conversation without mutating the saved transcript.

Open detail to settle during build: confirm that resuming with a *changed*
`--append-system-prompt` and a *new* `--mcp-config` (the run dir / socket differ
each session) behaves correctly — the conversation should resume while picking up
the new run's control-plane wiring. Verify against the installed CLI before
committing the UX.

### P1 — silent corruption and fleet degradation

**Fix #1 (multi-agent teardown).** Replace the `.find()` in both the
`set_ticket_state` terminal path and `cancel_ticket` with a `.filter()` over all
non-main agents on the ticket, tearing each down. The `cancel_ticket` path awaits
its teardown, so wrap the matches in `await Promise.all(...)` before refreshing
coordination. While here, fix the `agentByTicket` map, which bakes in the same
one-agent-per-ticket assumption (its `.set()` silently overwrites on collision) —
make it a `Map<ticketId, Set<agentId>>` or equivalent.

**Fix #6 (sweep clobbering completed tickets).** Before the sweep writes a ticket
to `failed`, read its current status and skip the write if it is already terminal
or handed off (`complete`/`reviewed`), or gate the failed-write on
`agent.role === "worker"`. A reviewer or tester dying should not reopen finished
work.

**Fix #3 (RPC UTF-8 framing).** Buffer incoming `Buffer`s and decode to string
only at the newline frame boundary, or use `node:string_decoder`'s
`StringDecoder`, which carries partial multibyte sequences across chunks. Apply
on both the server and client read paths.

**Fix #5 (spawn race).** Make the read-solve-spawn section atomic: include
`spawning` agents in the `inFlight()` view and run `nextRunnable` plus the
registry insert under one shared lock (the layout lock, or a dedicated spawn
lock) so a ticket's `touches` claim is visible to a concurrent handler before the
next solve runs.

### P2 — latent but real

**Fix #4 (zombie approval gates).** Thread the waiting agent's id through
`enqueue` so each gate is tagged with its owner, and have `tearDownAgent`
reject/resolve any gate for that agent before removing it from the registry.

**Fix #7 (dangling dependency).** Validate `depends_on` referential integrity
when tickets are created/indexed: reject (or surface a clear diagnostic for) any
dep id that does not resolve to an existing ticket, instead of letting it
silently deadlock.

**Fix #11 (atomic ticket writes).** Reuse the atomic write pattern already used
for `COORDINATION.md` (temp file + fsync + rename) for ticket `.md` writes.
Separately, wrap the per-file parse in the index rebuild in `try/catch` so one
corrupt file is skipped with a warning rather than aborting the whole rebuild and
crashing the daemon on boot.

### P3 — edge cases and cleanup

**Fix #9 (bad-request correlation).** Parse the inbound line's id before schema
validation and echo it on the error reply; and have the client advance its read
buffer past any consumed frame, treating an `ok:false` frame whose id does not
match as a terminal reject rather than re-reading it.

**Fix #10 (`nextId` overflow).** Sort numerically
(`ORDER BY CAST(SUBSTR(id, 3) AS INTEGER) DESC`) and/or widen the zero-pad, and
add an existence guard in `create` mirroring the one `promoteDraft` already has.

**Fix #8 (gitignored expansion).** At init, intersect `defaultExpanded(root)`
with the git-allowed set (when non-null) so gitignored `.charm` subdirs are
neither expanded nor watched.

---

## Alternatives considered

- **Session resume by parsing the transcript after the fact** instead of stamping
  `--session-id` at spawn. Rejected: fragile (depends on transcript internals)
  and racy. Owning the id at spawn is deterministic and lets charm record it
  immediately.
- **Spot-fixing #1, #4, and #6 independently.** They share one root assumption
  (one agent per ticket, one clean exit). Worth fixing the model — a
  ticket->agents relation and a single uniform teardown path — rather than three
  separate patches that will drift.
- **Disabling `remain-on-exit`** to dodge #2. Rejected: `remain-on-exit` is what
  keeps a crashed *agent* pane visible for diagnosis. The fix is to protect the
  console pane, not to lose crash visibility fleet-wide.

---

## Open questions

- Does resuming a session with a different `--append-system-prompt` and a new
  `--mcp-config` behave as intended on the installed CLI? Needs a direct test
  before the resume UX is finalized.
- For `charm resume`, should sub-agent conversations also be resumable, or only
  the orchestrator? The orchestrator is the conversation the operator interacts
  with; sub-agents are usually short-lived and ticket-scoped, so orchestrator-only
  may be the right v1.
- Should `charm resume` reattach to the prior tmux session if it still exists, or
  always relaunch fresh from the saved transcript? Defines how `resume` and
  `attach` relate.

---

## Status

draft
