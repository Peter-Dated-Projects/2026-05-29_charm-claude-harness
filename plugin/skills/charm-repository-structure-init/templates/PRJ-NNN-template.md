# PRJ-NNN: Title

**Status:** Active — one clause on what that means as of {{TODAY}}.
**Supersedes:** what in [PLAN.md](../PLAN.md) this narrows, if anything. `PLAN.md` retains the
long-term vision; say plainly whether it is still the delivery plan.

One paragraph: what this project delivers, end to end. A reader who stops here should know
what ships.

## Why this shape

Why this slice and not a bigger or smaller one. Name the differentiated part — the work that
is genuinely hard and genuinely unserved — and name what was cut, along with the risk surface
that went away with it. A scope decision that removes no risk was not a scope decision.

## Scope

**In:**

- Capability, one per line, concrete enough to test.

**Out:**

- What was deliberately excluded, including the tempting adjacent things.

Note anything that survives the cut in reduced form and which TDD owns it, so the boundary is
not ambiguous later.

## Pipeline

```text
input → stage → stage → output artifact
```

The end-to-end flow in one block. Useful as the shared mental model in every later discussion.

## Related TDDs

State the build order in a sentence and name the critical path.

| Order | TDD | Owns in this project | Status |
| --- | --- | --- | --- |
| 1 | [TDD-000: Contracts](../tdds/TDD-000-contracts.md) | | Proposed |

The **Owns in this project** column matters: a TDD can be broader than what this project needs
from it. The **Status** column carries project-specific qualifiers — `Proposed — scope-reduced`,
`Proposed — critical path` — not just the TDD's own lifecycle state.

**Deferred — not live contracts, no active dependency permitted:**
List them inline with links, so a reader cannot accidentally build on one.

## Platform baseline

{{PLATFORM_BASELINE}}

Then the platform-specific items to settle during implementation rather than design —
toolchain versions, runtime maturity, path and locking semantics, anything worth measuring
before it surprises you.

## Open decisions

Ordered by how much they block. Each is a real fork, not a task.

1. **Name of the decision.** The options, and what each one costs. Say which are one-way doors.

A decision that is decision-ready — has options, tradeoffs, an owner, and a decision point —
should live as a risk record in the owning TDD instead. This list is for the project-level
forks that cut across TDDs.

## First milestone

The smallest piece of real work that produces real measurements, and the numbers it must
record. Prefer a milestone that sits behind no gate: if every pending measurement in the plan
requires the contract bundle first, find the one that does not.

State what it settles. A milestone that closes two open decisions outright is worth more than
one that produces a demo.
