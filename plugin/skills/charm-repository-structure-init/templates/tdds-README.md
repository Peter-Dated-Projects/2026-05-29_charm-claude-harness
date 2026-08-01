# Technical Design Documents

These documents turn the product architecture in [PLAN.md](../PLAN.md) into independently
implementable subsystem designs. `PLAN.md` owns product intent, feature scope, and delivery
phases. Each TDD owns the technical contracts and acceptance tests for its subsystem.

## Numbering

TDDs are identified as `TDD-NNN` and filed as `TDD-NNN-kebab-case-title.md`. The numbering
rules are the same ones documented for projects in
[projects/README.md](../projects/README.md#numbering): numbers start at 000, are assigned in
creation order, and are permanent — never reused, renumbered, or reordered, including on
deferral or supersession. Status lives inside the document, never in the filename.

`TDD-000` is reserved for the contract bundle: the shared schema inventory, seam invariants,
time and ID representations, cross-process envelope, error behavior, compatibility policy, and
fixtures. Every other TDD depends on it.

New TDD: copy [_TEMPLATE.md](_TEMPLATE.md) to the next free number, add a row to Build order
below, and add it to the owning project's Related TDDs table.

## Current scope

The active project is **[PRJ-001: Title](../projects/PRJ-001-kebab-title.md)**:

> One-sentence scope statement, copied from the project document so this index stands alone.

Name here anything the project explicitly defers, and state the rule: no active TDD may take a
dependency on a deferred document, and no deferred schema is part of the contract bundle.

## Build order

Ordered by implementation sequence, not by number.

| Order | TDD | Owns | Depends on |
| --- | --- | --- | --- |
| 1 | [TDD-000: Contracts](TDD-000-contracts.md) | Schema inventory, seam invariants, time contracts, IPC/error behavior, compatibility policy, fixtures | None |
| 2 | | | |

Call out the critical path in bold under the table — the subsystems whose output everything
downstream reads. Nothing after them can be meaningfully validated until they produce real
output from real inputs, so measuring them comes before elaborating anything else.

## Deferred

Retained for reference. These have **not** been revised against the current baseline and are
**not** live contracts.

| TDD | Why deferred |
| --- | --- |
| | |

List separately anything withdrawn from the critical path along with them — decisions,
integration spikes, and release gates that no longer apply. Withdrawn is not pending; say
which it is.

## Platform baseline

{{PLATFORM_BASELINE}}

Repeat the binding constraint here rather than only in `PLAN.md`. A TDD author reads this
index, not the full plan, before making a resource decision.

## Shared rules

Invariants every TDD inherits. Adjust to the system; these are the ones worth stating in most:

- Stable IDs cross subsystem boundaries; filenames and ambiguous numeric types do not.
- Original source data is read-only.
- Every derived artifact is reproducible from versioned inputs, and the key it is reproducible
  *from* is explicitly defined.
- Every mutation is scoped, validated, versioned, and auditable.
- Agent-asserted facts are hypotheses until a human confirms them; nothing an agent writes
  silently becomes canon.
- Any accelerated or optional path has a declared fallback, with a stated time bound as well
  as a quality bound.
- UI and agent use the same domain operations.
- Long work returns a durable job ID and can be cancelled or resumed.
- A TDD may refine implementation details but may not silently reduce a Core feature from
  [PLAN.md](../PLAN.md).
- [TDD-000](TDD-000-contracts.md) is the inventory authority for the contract bundle, seam
  invariants, compatibility policy, and required fixtures. A dependent TDD may add domain
  behavior but must not define a competing wire shape.

## Decision process

Before production implementation of a subsystem's claimed behavior, its owning TDD moves from
`Proposed` to `Accepted`. Consequential open questions become decision-ready risk records with
current status and evidence, latest decision point, explicit options and tradeoffs, closure
evidence, and phase impact. Questions labeled non-blocking state why they are deferred and the
condition that would promote them to blocking. Test fixtures and measured thresholds replace
assumptions during implementation.

Note here whether ownership is a single person. If it is, every "signoff" in these documents
is self-certification and should be read as a checklist rather than a gate — say so, so nobody
mistakes a filled-in owner field for external review.

## Review status

Record completed design reviews: what was reviewed, where the artifacts live, and which
findings still stand after later scope or platform changes. A review that predates a scope cut
is partly moot — say which parts.
