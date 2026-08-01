# TDD-NNN: Title

## Status

`Proposed` | `Accepted` | `Deferred` | `Superseded by TDD-NNN`.

One line on what the status means right now — what is unvalidated, what gate it is waiting on,
or what evidence moved it to Accepted. A bare status word tells a reader nothing.

## Objective

What this subsystem provides, in two or three sentences, stated as a capability rather than a
component list.

**Decision:** Name the shared contracts this document does *not* own. Exact field lists,
schema IDs, wire shapes, and fixtures live in [TDD-000](TDD-000-contracts.md); this TDD owns
its own policy and behavior. Say which is which explicitly — the overlap is where competing
definitions get introduced.

## Inputs and outputs

| Direction | From/To | Contract |
| --- | --- | --- |
| In | | |
| Out | | |

Name the producing and consuming subsystems by TDD number. This table is what makes the
dependency graph in [tdds/README.md](README.md) checkable.

## Design

The substantive sections. Structure them to the subsystem rather than to a fixed outline — a
storage design and a protocol design do not want the same headings. Typical sections:

### Data representation

Identity, time, units, and ordering. State the canonical representation and what is forbidden
at the boundary (ambiguous numeric types, filenames as identity, implicit locale or timezone).

### Processing model

Stages, their dependencies, and what is parallel. A DAG block beats prose.

```text
stage → stage → stage
```

### Caching and invalidation

What each artifact key includes — input fingerprint, configuration, schema version, code
version — and which descendants a change invalidates. If the key is underspecified, the cache
silently serves stale results forever; make it explicit.

### Failure handling

What retries, what is idempotent, what is left partially written, and how a crash-then-retry
avoids producing a second contradictory record. Name the uniqueness key that prevents it.

### Observability

What is measured, at what granularity, and which number tells you the subsystem is unhealthy.

## Acceptance tests

- One line per test, each a falsifiable statement about observable behavior.
- Written so a reader can tell whether the test passed without reading the implementation.
- Cover the invariants the rest of the system depends on, not just the happy path.

These are the contract. A behavior nobody wrote a line for here is not guaranteed.

## Decision-ready risks

One record per consequential open question. A risk without options and a decision point is a
worry, not a risk record — either promote it here properly or leave it in the project's open
decisions.

### R-NNN-01: Short name of the decision

- **Decision owner:** role, plus whose approval is also required.
- **Latest decision point:** the concrete event after which deciding is too late.
- **Options:** each option with its cost in parentheses — the tradeoff is the content.
- **Consequences:** what the choice affects downstream, and what it forecloses.
- **Acceptance evidence:** the specific artifact, measurement, or test corpus that closes it.
  "We'll decide later" is not evidence.
- **Status:** `Open` / `Closed` plus the current default, and what it blocks if unresolved.
