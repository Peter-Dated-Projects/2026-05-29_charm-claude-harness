# Risk routing

Deterministic. Runs in the main thread on the evidence packet's signal scores,
with no model call. Length, polish, and confidence of the TDD are **not**
inputs — a three-paragraph doc can propose a one-way door and a forty-page doc
can propose a config change.

## The nine signals

Each scored 0–3 by the evidence extractor. Every score carries a citation or is
recorded as `UNKNOWN`.

| # | Signal | 0 | 1 | 2 | 3 |
| --- | -------- | --- | --- | --- | --- |
| S1 | **Change scope** | one module | several modules, one service | several services | new service / new platform capability |
| S2 | **Blast radius** | internal only | one team's users | all users of one product | all products, or external partners |
| S3 | **Reversibility** | behind a flag, revert in minutes | revertible with effort | hard to reverse | one-way door (data shape, public contract, vendor lock) |
| S4 | **Dependencies** | 0–1 | 2–3 | 4–6 | 7+, or the set is unknown |
| S5 | **Data ownership / migration** | no schema change | additive, backwards-compatible | backfill, destructive, or dual-write | ownership boundary moves, or data splits across services |
| S6 | **Security / privacy** | no sensitive data, no authz change | new surface behind existing authz | touches authn/authz logic | handles PII/PCI/PHI, or crosses a trust boundary |
| S7 | **Reliability** | not on a serving path | adds a dependency to a serving path | changes a critical serving path | new failure domain, or a new/changed SLO |
| S8 | **Operational impact** | no new runtime surface | new config, metrics, dashboards | new deploy unit or on-call surface | new infrastructure tier or runtime |
| S9 | **Organisational impact** | one team | two teams | 3+ teams, or cross-org | company-wide mandate or standard |

`UNKNOWN` scores as **2** for routing (unknown risk is not low risk) and is
listed in the output as an open question. Three or more `UNKNOWN`s is itself a
blocking ambiguity — stop and ask before reviewing.

## Tier selection

Evaluate in order; first match wins.

1. **`initiative`** if S9 = 3, **or** (S9 ≥ 2 and S1 = 3 and S2 ≥ 2), **or** Σ ≥ 20.
2. **`architecture`** if any signal = 3, **or** Σ ≥ 11.
3. **`standard`** if Σ ≥ 5, **or** any signal = 2.
4. **`quick`** otherwise (Σ ≤ 4 and max ≤ 1).

Σ ranges 0–27. `initiative` is gated on **organisational** scope (S9): a new
service with product-wide blast radius is an `architecture` review, not a
company initiative, unless more than two teams are on the hook for it.

### Hard escalations (override a lower tier)

- S3 = 3 **and** S2 ≥ 2 → minimum `architecture`. One-way doors with real blast
  radius get an architect, whatever the sum says.
- S6 = 3 → minimum `architecture`.
- S1 = 3 (new service) → minimum `architecture`.
- S5 = 3 → minimum `architecture`.

### User-named mode

Honour it. If it is below the routed tier, run it and open the report with:

> Routed tier: `architecture` (S3=3 one-way door, cited §4.2). Running `quick`
> as requested. The unreviewed risk is the storage-format choice.

Never silently upgrade. Never silently downgrade.

## Specialist triggers

Specialists launch only from an explicit trigger below. "It might be relevant"
is not a trigger.

| Specialist | Fires when |
| --- | --- |
| **systems architecture** | mandatory at `architecture`+; at `standard` when S1 ≥ 2 |
| **data architecture** | S5 ≥ 2; or a new persistent store; or an ownership boundary moves |
| **security / privacy** | S6 ≥ 2 |
| **SRE / reliability** | S7 ≥ 2 or S8 ≥ 2 |
| **performance / cost** | a stated latency/throughput/cost target exists; or per-request fan-out increases; or a new per-request external call; or unit cost changes materially |
| **delivery / migration** | S3 ≥ 2 or S5 ≥ 2; or a multi-phase rollout, dual-write, or dual-read is proposed |
| **behaviour / product** | mandatory at `architecture`+; at `standard` when user-visible behaviour or a published contract changes |

### Caps and tie-breaks

- **Priority order** — ordered by how irreversible the mistake is, not by how
  interesting the finding would be:

  `security/privacy` › `systems architecture` › `data architecture` ›
  `delivery/migration` › `SRE/reliability` › `performance/cost` ›
  `behaviour/product`

- `standard` runs **exactly one** specialist: the highest-priority trigger that
  fired. Every other fired trigger is named in the report under "not reviewed"
  as unreviewed risk — silently dropping them is how a cap turns into a lie.
- `architecture` runs systems architect + behaviour reviewer (both mandatory,
  and both therefore removed from the priority list) + **1–2** specialists by
  the same order. Unpicked triggers go under "not reviewed".
- When no behaviour/product reviewer runs, the primary reviewer fills the
  report's behaviour-contract section from the intent brief's must-not-change
  list, and marks it `unreviewed by a behaviour specialist`.
- Never run two specialists whose mandates overlap on the same finding surface
  (data architecture and delivery/migration overlap on backfills — pick the one
  matching the *decision under review*: shape → data, sequencing → delivery).

## Blocking ambiguity — stop conditions

Halt after stage 2 and ask the user when any of these hold:

- The problem statement and the proposed design solve different problems.
- A signal the router needs is `UNKNOWN` in three or more places.
- The TDD's central decision depends on a component, limit, or constraint whose
  existence nobody has verified.
- Two sections of the TDD contradict each other on the core mechanism.
- The blast radius cannot be bounded from the material supplied.

Ask at most five focused questions. Cheaper and more accurate than a panel
guessing in parallel.

## Initiative gates

Sequential. Each gate is a small review with its own exit criterion; a failed
gate stops the run and reports. Do not launch later gates speculatively.

| Gate | Question it answers | Roles | Exit criterion |
| --- | --- | --- | --- |
| **G1 Discovery** | Is this the right problem, and is the scope bounded? | initiative lead + behaviour/product | Problem, outcome, non-goals, and affected surfaces agreed |
| **G2 Architecture** | Is the target shape sound and are the one-way doors identified? | systems architect + 1–2 triggered specialists | Boundaries, ownership, and irreversible decisions named with rationale |
| **G3 Delivery / migration** | Can we get from here to there without a stranded state? | delivery/migration + data architecture (if S5 ≥ 2) | Phased plan with a rollback per phase, and no dual-ownership window left undefined |
| **G4 Launch readiness** | Will we know it is working, and can we turn it off? | SRE/reliability + behaviour/product | SLOs, alerts, kill switch, and the observable success signal defined |

**Independent challenge review** — allowed once, inserted after G2, and only
when G2 identifies a material irreversible decision. Scope it to that decision
only, cross-model-family where the platform allows. It is a falsification pass,
not a second opinion on the whole initiative.
