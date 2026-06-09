# PROP-charm-harness-notes

**Status:** draft

---

## Problem

The charm harness has accumulated several small but meaningful gaps in its
UX, agent conventions, and workflow ergonomics. None of these individually
justify a full overhaul, but together they create friction for both operators
and agents. This proposal collects them into a single actionable set.

---

## Context / Findings

These items surfaced from direct harness use and post-session review:

1. There is no settings UI surface -- users must edit raw JSON or CLAUDE.md
   files to configure harness behavior. This is a friction point for
   onboarding and for ad-hoc changes mid-session.

2. There is no enforced or surfaced convention for proposal file naming.
   Agents produce exploratory write-ups but drop them inconsistently across
   the repo, making discovery hard and supersession tracking impossible.

3. Finished/accepted proposals have no designated landing zone. They sit in
   the same folder as drafts, creating noise.

4. Git worktree support is absent. Multi-agent work on the same repo
   serializes at the file level even when agents are touching disjoint
   branches, which limits parallelism.

5. Agent chats open without the orchestrator prompt pre-loaded. Agents must
   re-derive context from scratch each session, increasing hallucination risk
   on project-specific details.

6. Voice notes from the orchestrator do not reference the active project.
   When multiple projects are in flight, audio updates are ambiguous.

7. Research-mode agents share the same default prompt as worker agents, even
   though their output target (the KB) and working style differ materially.

---

## Proposal

### 1 -- Settings UI page

Add a settings pane to the charm Console that surfaces user-configurable
options currently buried in JSON. Minimum viable scope: model selection,
agent concurrency cap, and default prompt mode. The pane should write back
to the existing settings store (no new format). A read-only view of current
effective settings (including env-overrides) is more valuable than a full
editor; prioritize that first.

### 2 -- Proposal naming convention: PROJECT-NNN format

Enforce a `PROJECT-NNN-<slug>.md` naming scheme for all proposal files in
`.charm/proposals/`, where NNN is a zero-padded three-digit counter
(001, 002, ...) scoped per project. The INDEX.md table already tracks files;
the counter makes ordering and cross-reference unambiguous.

- The charm UI should list all `PROJECT-NNN-*.md` files in the proposals
  folder and display them with their status.
- When an agent is spawned, its system context should include a note that
  proposals follow this naming scheme and must be placed in
  `.charm/proposals/`.
- A helper (CLI or MCP tool) should vend the next available NNN to avoid
  two agents racing on the same number.

### 3 -- Finished proposals folder

Add `.charm/proposals/finished/` as the canonical destination for accepted
or superseded proposals. The INDEX.md entry should be updated with a
`superseded-by` or `accepted` status and a link to the finished copy. The
original file in `proposals/` can then be removed (or symlinked) so the
active listing stays clean.

### 4 -- Git worktree setup

Add first-class git worktree support. Each worker agent that touches a
distinct branch should be issued its own worktree via `git worktree add`.
The daemon should track worktree-to-ticket mappings and clean up on
completion. The coordination serialization logic should be updated to treat
agents in separate worktrees as non-conflicting on overlapping `touches`
globs, since they are operating on different trees.

Open questions:
- What is the merge/PR story for worktree branches? Does charm open PRs
  automatically, or is that manual?
- How does the shared `.charm/` directory behave when multiple worktrees are
  active? (It lives in the main tree -- likely fine, but confirm.)

### 5 -- Orchestrator prompt as default on agent open

When any agent chat opens, the orchestrator prompt should be pre-loaded as
the session context. Currently agents bootstrap from a blank slate and
re-derive project-specific rules from scratch. Loading the orchestrator
prompt by default gives every agent the harness conventions, ticket schema,
and coordination rules without requiring explicit injection.

Worker agents that need a more restricted context can have their prompt
overridden at spawn time; the orchestrator prompt as default is a floor, not
a ceiling.

### 6 -- Orchestrator voice notes reference active project

Voice note calls from the orchestrator should always include the project name
or session description in the spoken update. The current pattern omits this,
making audio updates ambiguous when multiple sessions are running.

Implementation: update the orchestrator prompt to mandate that any
`voice_note.py` call includes the project name in the message text, and
update the `--context` flag value to include the project slug.

### 7 -- Research mode with KB-write enforcement

Research-mode agents should have a dedicated prompt variant that:

- Inherits the orchestrator prompt as a base (so harness conventions apply).
- Re-orients the agent toward investigation and synthesis rather than code
  output.
- Explicitly instructs the agent to write findings into the KB
  (`.charm/kb/`) before marking itself done.
- Blocks marking a research ticket complete until at least one KB file has
  been created or updated in the session.

The last point is the key behavioral difference from a normal worker: a
research agent that does not write to the KB has not finished its job.

---

## Alternatives Considered

- **Single mega-prompt for all agent types:** Simpler, but research agents
  and worker agents have genuinely different output contracts. A shared
  prompt produces mediocre behavior for both.

- **Manual proposal numbering:** Operators could number proposals by hand.
  Works until two agents race; a vended counter is safer at no real cost.

- **Worktrees as opt-in:** Could ship worktree support as an explicit flag
  per ticket. Easier to scope, but misses the point -- the value is automatic
  isolation, not more configuration knobs.

---

## Open Questions

- Git worktree cleanup strategy on agent failure (partial branch state).
- Whether the settings UI should be a charm Console pane or a separate TUI
  screen.
- How NNN counters are stored and reset across projects (per-project sqlite
  table or derived from existing filenames at read time).

---

## Status

draft
