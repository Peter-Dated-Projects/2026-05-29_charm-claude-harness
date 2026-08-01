# Platform profiles

All three profiles run the **same review contract**: same four stages, same
router, same prompt files in `agents/`, same findings block, same verdict
states, same caps. They differ only in **which model runs which role** and in
**how the platform spawns and constrains a subagent**.

If a platform is not listed, pick the closest profile and state the substitution
in the report header. Model aliases not defined in a profile below (for example
`Luna`) are **configurable, not hard-coded** — do not use one until a profile
here names it and assigns it a role.

## Shared contract (all platforms)

| Element | Value |
| --- | --- |
| Stage order | preface → extraction+routing → review → synthesis |
| Reviewer input | intent brief + evidence packet; TDD by path for citation |
| Reviewer output | the findings block in [evidence-and-synthesis.md](evidence-and-synthesis.md#findings-block) |
| Tool access | read-only for every spawned agent |
| Synthesis | main thread, no extra agent |
| Caps | quick 1 · standard 2 · architecture 3–4 · initiative phased gates + ≤1 challenge |
| Escalation | a reviewer names the specialist and trigger; it does not self-expand scope |

## Claude Code

Spawn with the `Agent` tool. Use `subagent_type: "Explore"` for read-only
reviewers (it has no edit tools) and `general-purpose` only where a reviewer
genuinely needs to run a read command. Set `model` per agent. Independent
reviewers in one tier go in a single message so they run concurrently.

| Stage / tier | Composition |
| --- | --- |
| Preface | Sonnet — `agents/preface-interviewer.md` (or inline in the main thread when the user is live) |
| Extraction + routing | **Haiku** — `agents/evidence-extractor.md` |
| `quick` | Sonnet design reviewer |
| `standard` | Sonnet design reviewer (primary) + 1 Sonnet specialist |
| `architecture` | **Opus** systems architect + Sonnet behaviour/product + 1–2 Sonnet specialists |
| `initiative` | **Opus** initiative lead (G1) + **Opus** systems architect (G2) + targeted Sonnet specialists (G2–G4) |
| Challenge review | Opus adversarial challenger, scoped to one decision, once |

Opus is for **material architecture decisions** — boundaries, one-way doors,
initiative scope. Not for routine review, not for extraction, not for a
generalist pass on a small feature.

Claude Code has repository access, so `agents/implementation-analyst.md` is
available here on the same terms as in the Cursor profile: run it (Sonnet, via
`Explore`) when the TDD makes checkable claims about the current codebase. It
occupies one of the tier's slots — it does not raise the cap.

Spawn instruction template:

> Read `<skill-dir>/agents/<role>.md` and follow it exactly. Inputs:
> `<run-dir>/intent-brief.md`, `<run-dir>/evidence-packet.md`. TDD:
> `<tdd-path>`. Read-only — do not edit any file except your own output at
> `<run-dir>/review-<role>.md`. Return only the findings block.

## Codex / GPT

**Terra** is the default worker for every stage. **Sol** appears only as a
narrowly scoped adversarial critic at high risk.

| Stage / tier | Composition |
| --- | --- |
| Preface | Terra — `agents/preface-interviewer.md` |
| Extraction + routing | Terra at **lower reasoning effort** — `agents/evidence-extractor.md` |
| `quick` | Terra design reviewer |
| `standard` | Terra design reviewer + 1 Terra specialist, **only when triggered** |
| `architecture` | Terra systems reviewer + **Sol** adversarial architecture critic + 1–2 Terra specialists |
| `initiative` | Terra initiative lead + targeted Terra specialists per gate + one **Sol** challenge review after G2 |

Sol constraints — non-negotiable:

- **Not the default design or implementation author.** It never writes the
  design, never proposes the primary architecture, and never runs as the
  generalist reviewer.
- Its job is to **falsify**: break assumptions, surface fatal coupling, find
  missing failure modes, and name cheaper alternatives meeting the same stated
  outcome.
- **Evidence-bound** — the citation rules in
  [evidence-and-synthesis.md](evidence-and-synthesis.md#citation-rules) apply in
  full. A confident unfalsifiable objection is dropped in synthesis.
- Scoped to **one named decision** per invocation, passed in the spawn call.
- At `architecture`, Sol occupies **one of the tier's 3–4 slots** — it does not
  raise the cap, and it is still scoped to a single named decision, not the
  whole design.
- "No falsification found" is a valid, useful return.

Enforce read-only through the sandbox/approval configuration, not by asking
nicely — run reviewers with filesystem writes disabled apart from the run
directory.

## Cursor

Use per-agent model configuration and read-only mode where the platform offers
it. Cursor's repository exploration is the differentiator: use it to *gather*
evidence, and keep the *extraction* in a separate read-only agent so exploration
output does not leak unlabelled claims into the packet.

| Stage / tier | Composition |
| --- | --- |
| Preface | Composer 2.5 (standard) — `agents/preface-interviewer.md` |
| Evidence gathering | Cursor Explore / fast repository exploration — collects candidate sources only |
| Extraction + routing | read-only extractor agent — `agents/evidence-extractor.md` |
| `quick` | Composer 2.5 (standard) design reviewer |
| `standard` | Composer 2.5 primary + 1 selected specialist model, triggered |
| `architecture` | **Opus** systems architect + Composer 2.5 codebase/implementation analyst + behaviour/product reviewer + 1 triggered specialist |
| `initiative` | **Opus** initiative lead + Composer 2.5 implementation architect + independent challenger (**Grok 4.5** or **GPT**) + delivery/SRE reviewer per gate |

The Composer implementation analyst is a distinct mandate from the systems
architect: it answers "does the described change match what the repository
actually looks like", citing paths and lines. It does not rule on boundaries.

The independent challenger is deliberately **cross-model-family** — that is the
point of it, and Cursor is the platform where it is cheapest to arrange.

## Choosing a challenger

Prefer cross-family for high-risk work: Claude Code → Opus challenger only if
nothing else is available (note the correlation in the report); Codex → Sol;
Cursor → Grok 4.5 or GPT against a Composer/Opus architecture. A same-family
challenger shares the primary reviewer's blind spots and should be reported as
weaker evidence than an independent one.
