# Output templates

One canonical report shape for every tier. Small reviews omit empty sections;
they never change the section order or invent new ones.

## Canonical report

```markdown
# TDD review — <design title>

**Verdict:** ready | ready with conditions | needs design work
**Tier:** quick | standard | architecture | initiative — <routed, or "requested X, routed Y">
**Reviewers:** <role @ model, …>
**Signals:** S1..S9 scores, one line

## Decisions reviewed
1. <decision> — <the choice made, in the author's terms>

## Blockers
### B1 — <claim>
- **Cite:** <exact source>
- **Impact:** <what breaks, for whom>
- **Resolve by:** <specific thing that closes it>
- **Owner:** <name or unassigned>

## Non-blocking risks
- **R1** [ASSUMPTION] <claim> — cite: <…> — accept or resolve by: <…> — owner: <…>

## Behaviour contract
- **Changes:** <observable change, per consumer>
- **Must not change:** <existing behaviour held fixed>
- **Consumers affected:** <who, and how they find out>

## Test and validation plan
- <what must be proven, and how it is observed — not a test list, a proof list>

## Architecture consequences
- <what this makes easy later> / <what it makes hard> / <what becomes irreversible>

## Owners
| Item | Owner | Decision needed by |

## Open questions
1. <question> — <what it changes>

## Dissent register
- <claim>: <reviewer A position> vs <reviewer B position>. Resolved by: <evidence>

## Not reviewed
- <triggered-but-capped specialists, UNKNOWN signals, unexamined surfaces>
```

---

## Example 1 — small isolated feature (`quick`, 1 reviewer)

*Add a CSV export button to an existing admin list view.*

```markdown
# TDD review — Admin CSV export

**Verdict:** ready with conditions
**Tier:** quick (routed; Σ=3, max=1)
**Reviewers:** design reviewer @ Sonnet
**Signals:** S1=1 S2=1 S3=0 S4=1 S5=0 S6=0 S7=0 S8=0 S9=0

## Decisions reviewed
1. Render the export synchronously in the request rather than via the job queue.

## Blockers
None.

## Non-blocking risks
- **R1** [INFERENCE] Synchronous export is unbounded — §3 says "stream all rows
  matching the current filter" and §2 states no row cap. A large tenant filter
  holds a request open for the full scan. Cite: §2, §3. Resolve by: a row cap or
  a documented worst-case row count. Owner: author.

## Behaviour contract
- **Changes:** a new button on the admin list; a new `GET …/export.csv` route.
- **Must not change:** the list view's own filtering and pagination behaviour.
- **Consumers affected:** internal operators only.

## Test and validation plan
- Export output matches the on-screen filter for a multi-page result set.
- Behaviour at the row cap is defined and observable (truncation is visible).

## Architecture consequences
- Introduces the first synchronous long-running admin endpoint; if a second
  appears, the queue decision should be revisited deliberately.

## Owners
| Item | Owner | Decision needed by |
| R1 row cap | author | before merge |

## Open questions
1. What is the largest tenant's row count today? Determines whether R1 is a cap
   or a queue.

## Dissent register
None — single reviewer.
```

---

## Example 2 — cross-service feature (`standard`, 2 reviewers)

*Move billing-status checks from the web app into the payments service.*

```markdown
# TDD review — Billing status via payments service

**Verdict:** needs design work
**Tier:** standard (routed; Σ=8, max=2)
**Reviewers:** design reviewer @ Sonnet (primary) + systems architect @ Sonnet
**Signals:** S1=2 S2=1 S3=1 S4=1 S5=0 S6=0 S7=2 S8=0 S9=1
**Specialist selected:** systems architecture (S1=2), highest-priority trigger.
**Not reviewed:** SRE/reliability (S7=2) and behaviour/product (contract change)
also fired and were capped out. The serving-path dependency in B1 is the top
unreviewed surface — it is reported below from the primary's mandate only.

## Decisions reviewed
1. Web app calls payments synchronously on every page render.
2. Payments becomes the source of truth for `is_delinquent`.

## Blockers
### B1 — A page render now fails when payments is unavailable
- **Cite:** §4 "the web app blocks on the status call"; §6 lists no fallback.
- **Impact:** payments availability becomes an upper bound on web availability
  for every authenticated page, not just billing pages.
- **Resolve by:** a stated fallback (cached last-known status, or fail-open with
  a defined window) or a decision to accept the coupling with an SLO to match.
- **Owner:** unassigned.

## Non-blocking risks
- **R1** [EVIDENCE] Two sources of truth exist during rollout — §7 keeps the web
  app's own flag "until cleanup". No cleanup owner or date. Resolve by: naming
  both. Owner: author.

## Behaviour contract
*Unreviewed by a behaviour specialist — filled by the primary from the intent
brief's must-not-change list.*
- **Changes:** delinquency now reflects payments state within one request.
- **Must not change:** the grace-period rules users see (§2 asserts this; no
  reviewer could verify where grace-period logic lives today — see open Q1).
- **Consumers affected:** web app; the nightly dunning job reads the same flag.

## Test and validation plan
- Grace-period behaviour is identical before and after, proven against the
  current implementation's cases, not against the TDD's description of them.
- Page render under payments timeout has a defined, tested outcome.

## Architecture consequences
- Establishes payments as an on-serving-path dependency for the web tier. Every
  later "just ask payments" feature inherits this coupling.

## Owners
| Item | Owner | Decision needed by |
| B1 fallback | unassigned | before implementation |
| R1 cleanup | author | at rollout |

## Open questions
1. Where does grace-period logic live today? Determines whether the "must not
   change" claim is testable.
2. Does the dunning job read the flag directly from the web DB?

## Dissent register
- Severity of the dual-source window: primary called it a risk (bounded by
  rollout); systems architect called it a blocker (an ownership split with no
  cleanup owner is permanent by default). Recorded as R1 with the disagreement
  noted. Resolved by: naming a cleanup owner and date — that single fact
  settles it.
```

---

## Example 3 — new microservice (`architecture`, 4 reviewers)

*Extract notifications into a new service with its own datastore.*

```markdown
# TDD review — Notifications service extraction

**Verdict:** needs design work
**Tier:** architecture (Σ=18, S1=3 new service, S5=3 ownership move; S9=1 keeps
it below `initiative`)
**Reviewers:** systems architect @ Opus + behaviour/product @ Sonnet +
data architect @ Sonnet + delivery/migration @ Sonnet
**Signals:** S1=3 S2=2 S3=2 S4=2 S5=3 S6=1 S7=2 S8=2 S9=1

## Decisions reviewed
1. Notifications owns delivery state; the monolith keeps user preferences.
2. Communication is via an events topic, not a synchronous API.
3. Cutover is a dual-write window followed by a backfill.

## Blockers
### B1 — Preference and delivery state split across two owners with one invariant
- **Cite:** §3 "preferences stay in the monolith"; §5 "notifications enforces
  do-not-disturb at send time".
- **Impact:** the do-not-disturb invariant is enforced by a service that does
  not own the data it enforces on. Any preference write racing a send produces a
  violation with no single place to fix it.
- **Resolve by:** move preferences with delivery, or make DND a value carried on
  the send event and drop the read.
- **Owner:** notifications tech lead.

### B2 — The dual-write window has no defined end state on failure
- **Cite:** §8 describes entering the window; no section describes exiting it
  partially.
- **Impact:** if the backfill stalls, the system sits with two writers and no
  reconciliation, indefinitely and silently.
- **Resolve by:** a reconciliation check and an explicit abort path per phase.
- **Owner:** delivery owner.

## Non-blocking risks
- **R1** [INFERENCE] Event-only communication removes the synchronous "was it
  sent" answer the support tool relies on (§4 lists the tool as a consumer; §6
  offers no query API). Resolve by: confirming the tool's actual read pattern.
- **R2** [ASSUMPTION] Ordering is assumed per-user on the topic. Nothing cited
  establishes it. Resolve by: the topic's partitioning key.

## Behaviour contract
- **Changes:** delivery becomes asynchronous; send acknowledgement no longer
  means delivered.
- **Must not change:** DND semantics; per-channel opt-out; the support tool's
  visible delivery history.
- **Consumers affected:** monolith send-sites, support tool, analytics ingest.

## Test and validation plan
- DND is proven under a preference-write/send race, not just in isolation.
- A halted backfill is exercised and the reconciliation path is observed.
- Support-tool delivery history is compared old-vs-new on real traffic shape.

## Architecture consequences
- First service owning state extracted from the monolith — it sets the pattern
  for the next three. The ownership-split decision in B1 will be copied.
- Event-only is a one-way door for the support tool's read path.

## Owners
| Item | Owner | Decision needed by |
| B1 ownership split | notifications tech lead | before implementation |
| B2 abort path | delivery owner | before dual-write starts |

## Open questions
1. What is the topic's partition key? (settles R2)
2. Does the support tool read delivery state live, or from analytics? (settles R1)

## Dissent register
- B1 remedy: systems architect prefers moving preferences; data architect
  prefers carrying DND on the event as lower-risk. Both agree the current split
  is a blocker. Resolved by: the preference write rate and whether preferences
  have other readers — neither is in the TDD.

## Not reviewed
- SRE/reliability (S7=2) and operational surface (S8=2) — capped at 4 reviewers.
  Retry amplification on the new topic is unexamined.
```

---

## Example 4 — company initiative (`initiative`, phased gates)

*Standardise identity across all products on one provider.*

```markdown
# TDD review — Unified identity initiative

**Verdict:** ready with conditions (G1–G2 passed; G3 conditional; G4 not run)
**Tier:** initiative (S9=3 company-wide mandate)
**Gates run:** G1 discovery ✓ · G2 architecture ✓ · challenge review ✓ · G3 delivery ⚠ · G4 not reached
**Reviewers:** initiative lead @ Opus (G1) · systems architect @ Opus + security
@ Sonnet (G2) · adversarial challenger, cross-family (post-G2) · delivery/
migration + data architect @ Sonnet (G3)
**Signals:** S1=3 S2=3 S3=3 S4=3 S5=2 S6=3 S7=3 S8=3 S9=3

## Decisions reviewed
1. One external identity provider for all products (irreversible — vendor and
   user-identifier shape).
2. Per-product migration, product-by-product, over three quarters.
3. Legacy sessions honoured for 90 days per product.

## Gate outcomes
- **G1 Discovery — pass.** Problem, outcome, and non-goals agreed. Two teams
  listed as affected were assumed, not consulted (see Q1).
- **G2 Architecture — pass with one irreversible decision named:** the external
  user-identifier format is embedded in exported analytics and partner webhooks
  (§5, §11). Changing providers later means rewriting both.
- **Challenge review — one finding survived.** Provider outage becomes a
  company-wide login outage; §9's "provider SLA" is cited as mitigation but an
  SLA is a contract, not a fallback. Evidence-bound and unrefuted.
- **G3 Delivery — conditional.** Per-product phasing is sound; the 90-day
  legacy-session window overlaps across products with no defined behaviour for a
  user who holds sessions in two products mid-migration.

## Blockers
None outstanding at the gates run. G3's condition below must close before G4.

## Conditions
1. Define cross-product session behaviour during overlapping legacy windows.
   Owner: identity lead. Before: first product cutover.
2. Define the login-path fallback for provider unavailability, or accept it
   explicitly at the exec level with the outage cost stated. Owner: CTO.
3. Consult the two assumed-affected teams and re-run G1 scope if they dissent.

## Behaviour contract
- **Changes:** login surface and session lifetime, per product, at its cutover.
- **Must not change:** existing user identifiers exposed to partners (§11 asserts
  this; G2 found it is what makes the provider choice irreversible).
- **Consumers affected:** all products, partner webhook subscribers, analytics.

## Test and validation plan
- One product migrated end-to-end as a real gate, not a pilot — including its
  partner webhooks — before the second is scheduled.
- Overlapping-session behaviour exercised across two migrated products.
- Provider-unavailable path exercised in production configuration.

## Architecture consequences
- Vendor choice becomes load-bearing on partner-visible identifiers. This is the
  one-way door; everything else in the plan is reversible per product.
- Company-wide single point of failure on the login path is created here.

## Owners
| Item | Owner | Decision needed by |
| Cross-product sessions | identity lead | before first cutover |
| Outage fallback | CTO | before first cutover |
| Team consultation | initiative lead | before G4 |

## Open questions
1. Have the two assumed-affected teams agreed to the scope?
2. What is the actual partner-webhook identifier contract — published, or
   de-facto?

## Dissent register
- Challenger vs systems architect on the outage risk: architect treats the
  provider SLA as sufficient; challenger holds that an SLA has no runtime
  behaviour. Both agree on the facts. Resolved by: an explicit exec-level
  acceptance of login-outage exposure, or a fallback design — this is a business
  decision, not a technical one.

## Not reviewed
- G4 launch readiness — not reached. SLOs, alerting, and kill switch are
  undefined and must be reviewed before the first cutover.
```
