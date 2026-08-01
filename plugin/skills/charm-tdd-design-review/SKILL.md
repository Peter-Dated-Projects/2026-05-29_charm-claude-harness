---
name: charm-tdd-design-review
description: "Review a Technical Design Document (TDD) — a written design/architecture proposal, not test-driven development. Runs a mandatory intent preface, deterministic risk routing, then a right-sized review (1 reviewer for small features, up to a phased architecture panel for new services or company initiatives). Use when asked to review, critique, sanity-check, or approve a design doc, RFC, ADR, architecture proposal, or tech spec, or when the user names a mode: quick, standard, architecture, initiative."
---

# TDD Design Review

"TDD" here means **technical design document**. This skill reviews a written
design; it never runs tests and never writes the design.

Goal: catch core design flaws — wrong problem, wrong boundary, one-way door,
unowned data, missing failure mode — **before** they are expensive, without
launching a multi-agent panel for a two-file feature.

## Hard rules

1. **Read-only.** Every agent this skill spawns is read-only. Do not edit the
   TDD, the code, or any ticket. Producing a review is the deliverable. Only
   modify something if the user gives a *separate, explicit* instruction after
   the review ("now apply blocker 2 to the doc"). The sole writes this skill
   makes are its own artifacts under the run directory, plus the one-time
   `.charm/` and `.gitignore` setup below.
2. **Preface is mandatory.** Never review a TDD before establishing what the
   user is actually trying to build. No exceptions, not even for `quick`.
3. **Route before you spend.** The router in
   [references/risk-routing.md](references/risk-routing.md) is deterministic and
   runs on extracted signals — never on document length, tone, or vocabulary.
4. **Label every material finding** as `EVIDENCE`, `INFERENCE`, `ASSUMPTION`,
   `QUESTION`, or `RECOMMENDATION`. A blocker must cite an exact source. Rules:
   [references/evidence-and-synthesis.md](references/evidence-and-synthesis.md).
5. **Ask, don't guess.** If uncertainty blocks review confidence, stop and ask
   the user focused questions. Never spend an extra agent to guess.
6. **Never invent consensus.** Preserve dissent and say what evidence resolves it.

## Run directory

Every artifact this skill produces goes under `.charm/` in the repository root
(the working directory when not inside a git repo):

```text
<run-dir> = .charm/tdd-review/<run-slug>/
```

`<run-slug>` is a short kebab-case name for the run — the TDD's identifier, or
what the run covers when it spans several docs (`tdd-014`, `billing-rewrite`,
`per-tdd`). Never write review output anywhere else, and never write outside
`.charm/`.

Set this up **before** stage 1, in the main thread:

1. `mkdir -p .charm/tdd-review/<run-slug>` — creates `.charm/` if it does not
   already exist.
2. Make sure `.charm/` is git-ignored:
   - If `.charm/.gitignore` already exists, it is charm-managed and already
     ignores everything except its own re-included subtrees. `tdd-review/` is
     not one of them, so it is covered — **leave that file alone**.
   - Otherwise append `.charm/` to the repository's root `.gitignore`, creating
     the file if needed. Idempotent: skip if an equivalent rule is already
     present.
3. Confirm with `git check-ignore -q .charm/tdd-review/<run-slug>` before
   spawning any agent. If it does not report ignored, stop and tell the user
   rather than generating output that would land in their diff.

If the run directory already exists and is non-empty, it holds a previous
review — ask whether to resume, write to a new slug, or overwrite. Never
silently clobber a prior run.

## Workflow

Four stages, strictly ordered. Each stage can halt the run.

### Stage 1 — Preface (mandatory, 1 agent or inline)

Spawn the preface interviewer with `agents/preface-interviewer.md`. It talks to
the user and establishes: user/business problem, desired observable outcome,
users and downstream consumers, constraints, non-goals, existing behaviour that
must not change, assumptions, blast radius, and which decisions the author
actually wants reviewed.

Output: **intent brief** (≤1 page) written to `<run-dir>/intent-brief.md`.

Run inline in the main thread instead of spawning when the user is already in a
live conversation about the design — the interview needs their answers, and a
subagent that cannot reach them is worse than no subagent. Spawn when the TDD
plus a ticket already answer most questions and you only need gaps closed.

Halt if the user cannot state the problem or the desired outcome. There is
nothing to review yet; say so.

### Stage 2 — Evidence extraction + routing (1 cheap agent)

Spawn the extractor with `agents/evidence-extractor.md`, given the TDD, the
intent brief, and any supplied repo/ticket/contract evidence. It:

- splits the material into **facts / inferences / assumptions / questions /
  recommendations**, each with a source citation;
- scores the nine routing signals in
  [references/risk-routing.md](references/risk-routing.md);
- flags **blocking ambiguities** — unknowns that would change the shape of the
  design, not just its details.

Output: **evidence packet** at `<run-dir>/evidence-packet.md`. This packet, plus
the intent brief, is the *only* context reviewers get. Do not hand reviewers the
raw TDD and full conversation — attach the TDD as a reference they may open on
demand for exact-section citation.

Then apply the router yourself, in the main thread, with no model call:
compute the tier, the mandatory roles, and the triggered specialists.

**Stop early** if the packet reports a blocking ambiguity. Ask the user those
questions and re-run stage 2 on the answers. Reviewing on top of a blocking
unknown produces confident noise.

### Stage 3 — Adaptive review

Tier from the router (or the user's explicit mode; honour it, and note in the
output when it differs from the routed tier and why that matters).

| Tier | Agents | Composition |
| ------ | -------- | ------------- |
| `quick` | 1 | design reviewer |
| `standard` | 2 | design reviewer (primary) + exactly 1 triggered specialist |
| `architecture` | 3–4 | systems architect + behaviour/product reviewer + 1–2 triggered specialists |
| `initiative` | phased | discovery → architecture → delivery/migration → launch-readiness gates |

`initiative` runs **gate by gate**, not all at once. Each gate's output feeds the
next, and a failed gate stops the run. One independent challenge review is
allowed, and only for a material irreversible decision. Gate definitions:
[references/risk-routing.md](references/risk-routing.md#initiative-gates).

Role mandates and their prompt files:
[references/reviewer-roles.md](references/reviewer-roles.md).

Model assignment and spawn mechanics per platform:
[references/platform-profiles.md](references/platform-profiles.md). Detect the
platform from the running environment; if ambiguous, ask once.

**Spawning.** Every role's prompt is a stored file in `agents/`. Give each agent
a short instruction — its prompt file path, the run directory, and its assigned
scope — and let it read its own prompt. **Never read an `agents/*.md` file into
your own context**, on any run: the orchestrator routes and synthesises, and the
prompt bodies must stay out of the main thread for the whole review.

> Read `<skill-dir>/agents/<role>.md` and follow it exactly. Inputs are in
> `<run-dir>/` (`intent-brief.md`, `evidence-packet.md`). The TDD is at
> `<tdd-path>`. You are read-only. Write your review to
> `<run-dir>/review-<role>.md` and return only your findings block.

Independent reviewers in the same tier run in parallel. Dependent reviews
(anything that needs another reviewer's conclusion) run sequentially.

### Stage 4 — Synthesis (main thread, no extra agent)

Merge with [references/evidence-and-synthesis.md](references/evidence-and-synthesis.md):
deduplicate by claim (not by wording), demote unsupported claims, preserve
dissent, and never upgrade an `ASSUMPTION` to a fact because two agents said it.

Emit the report from
[references/output-templates.md](references/output-templates.md):

verdict → decisions reviewed → blockers → non-blocking risks → behaviour
contract → test/validation plan → architecture consequences → owners → open
questions → dissent register.

Verdict is exactly one of: **`ready`**, **`ready with conditions`**,
**`needs design work`**.

## Cost policy

- Deterministic router **before** any review model call.
- One compact evidence packet shared by all reviewers; never re-send raw context.
- Role prompts live in `agents/` and are read by the agent, not by you — the
  orchestrator pays for a file path, not thirteen prompt bodies.
- Never run two generalist reviewers with the same mandate.
- Specialists launch **only** from an explicit risk trigger, never "to be safe".
- Sequential for dependent reviews; stop early on blocking ambiguity.
- Caps: quick 1 · standard 2 · architecture 3–4 · initiative phased gates with
  at most one independent challenge review, reserved for material irreversible
  decisions.
- Prefer a **cross-model-family** challenger for high-risk work where the
  platform supports it — a same-family second opinion correlates with the first.

## Mode selection

The user may name a mode (`quick`, `standard`, `architecture`, `initiative`).
Honour it. Still run the preface and the router: the router's job in that case
is to tell the user when their chosen mode is below the routed risk, and which
signal caused it. If no mode is named, the router decides silently.

## Layout

```text
charm-tdd-design-review/
├── SKILL.md                          this file — workflow and rules
├── agents/                           stored subagent prompts — spawn by path,
│                                     never read into the orchestrator's context
└── references/
    ├── risk-routing.md               signals, scoring, tiers, triggers, gates
    ├── reviewer-roles.md             role mandates → prompt files
    ├── platform-profiles.md          Claude Code / Codex-GPT / Cursor
    ├── evidence-and-synthesis.md     labels, citations, merge, verdicts
    └── output-templates.md           report template + 4 worked examples
```

Output lands in the reviewed repository, not in the skill directory:

```text
<repo-root>/.charm/tdd-review/<run-slug>/
├── intent-brief.md          stage 1
├── evidence-packet.md       stage 2
├── review-<role>.md         stage 3, one per reviewer
└── REPORT.md                stage 4 synthesis
```
