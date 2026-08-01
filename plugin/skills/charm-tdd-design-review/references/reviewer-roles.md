# Reviewer roles

Every role is read-only, receives the same inputs (intent brief + evidence
packet + the TDD path for citation), and returns the same findings block
defined in [evidence-and-synthesis.md](evidence-and-synthesis.md#findings-block).
Roles differ only in mandate and in what they are forbidden to comment on.

The prompt bodies live in `agents/`. Spawn by path — never paste the body into
the spawn call, and never read a prompt file into the orchestrator's context.

| Role | Prompt file | Stage |
| --- | --- | --- |
| Preface interviewer | `agents/preface-interviewer.md` | 1 |
| Evidence extractor / router scorer | `agents/evidence-extractor.md` | 2 |
| Design reviewer (generalist primary) | `agents/design-reviewer.md` | 3 — quick, standard |
| Systems architect | `agents/systems-architect.md` | 3 — architecture, initiative |
| Behaviour / product reviewer | `agents/behaviour-product.md` | 3 — architecture+, triggered at standard |
| Data architect | `agents/data-architect.md` | 3 — triggered |
| Security / privacy reviewer | `agents/security-privacy.md` | 3 — triggered |
| SRE / reliability reviewer | `agents/sre-reliability.md` | 3 — triggered |
| Performance / cost reviewer | `agents/performance-cost.md` | 3 — triggered |
| Delivery / migration reviewer | `agents/delivery-migration.md` | 3 — triggered |
| Initiative lead | `agents/initiative-lead.md` | 3 — initiative G1 |
| Adversarial challenger | `agents/adversarial-challenger.md` | 3 — high risk, once |
| Codebase / implementation analyst | `agents/implementation-analyst.md` | 3 — where the platform has repo access (see Cursor profile) |

## Mandates

**Design reviewer** — the generalist primary for small and moderate changes.
Does the design solve the stated problem, is the decomposition sane, are the
interfaces and error paths defined, is the change testable, and what breaks that
the author has not mentioned. Escalates rather than improvising when a finding
needs a specialist's depth: names the specialist and the trigger.

**Systems architect** — boundaries, ownership, coupling, and one-way doors.
Is the seam in the right place; what does this make hard later; which decisions
are irreversible and are they made deliberately; does the design create a
distributed transaction, a shared mutable store, or a cycle. Does not review
code style, ticket sequencing, or copy.

**Behaviour / product reviewer** — the contract with users and callers. What
observable behaviour changes; what must stay identical; which consumers depend
on current behaviour; what the migration looks like from the caller's seat; is
the success signal observable. Owns the **behaviour contract** section of the
report. Does not review internal structure.

**Data architect** — schema shape, ownership, invariants, and lifecycle. Who
owns each field; what the source of truth is; are the invariants enforceable
where they are declared; is the migration reversible; what happens to in-flight
and historical rows; what the retention and deletion story is. Does not review
sequencing (that is delivery/migration).

**Security / privacy reviewer** — trust boundaries, authn/authz, data
classification, and blast radius of compromise. What crosses a boundary; what
the authorisation decision is and where it is made; what is logged; what is the
worst thing an authenticated attacker can reach. States threats as risks with
citations; does not assert the existence of controls it has not seen.

**SRE / reliability reviewer** — failure modes, dependency behaviour, and
operability. What happens when each dependency is slow, down, or wrong; where
retries amplify; what the timeout and backpressure story is; what the SLO is;
how it is turned off. Owns kill-switch and alerting findings.

**Performance / cost reviewer** — only where a target or a unit-cost change
exists. Per-request work, fan-out, N+1 shapes, cache behaviour, and the cost
model at the stated scale. Must state the scale assumption it is reasoning from
and label it `ASSUMPTION` when the TDD does not supply one.

**Delivery / migration reviewer** — the path from current to target state.
Phase boundaries, dual-write/dual-read windows, backfill mechanics, rollback per
phase, and stranded intermediate states. Asks what happens if the migration
stops halfway and stays there for a quarter.

**Initiative lead** — G1 only. Is this the right problem at the right altitude;
what is explicitly out of scope; which teams are affected and which are
assumed-but-unconsulted; what would make this initiative fail that is not
technical. Produces the scope contract the later gates review against.

**Adversarial challenger** — falsification, not opinion. Given one named
decision, tries to break it: fatal coupling, a missing failure mode, an
unstated assumption the design rests on, or a cheaper alternative that meets the
same stated outcome. Evidence-bound — it may argue a risk is unexamined, but may
not assert a component, limit, or behaviour exists without a citation. Returns
"no falsification found, here is what I tried" when that is the honest result.

## Scope discipline

A reviewer that strays outside its mandate produces duplicate findings, which is
the main source of fake consensus in synthesis. Each prompt states its
out-of-scope list explicitly, and the synthesiser drops out-of-mandate findings
unless no in-mandate reviewer covered that surface — in which case it is
recorded as an open question, not a finding.
