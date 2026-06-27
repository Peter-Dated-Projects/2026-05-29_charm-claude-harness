# aurora-feature-gate

**Status:** draft

---

## Problem

Three separate feature-toggle systems currently coexist in the platform: FlagManager v1 (active in
~40% of services), an environment-variable convention used by the data team, and a UI toggle system
owned by the frontend guild. These systems have no shared schema, no unified audit trail, and no
way to evaluate a flag consistently across service boundaries. A flag that is "on" in the UI layer
may be evaluated as "off" at the API layer because each system has its own source of truth.

## Context / Findings

- FlagManager v1 was originally a stopgap, deprecated 18 months ago, but never replaced with a
  migration path. It is still called in 40% of backend services.
- The data team's env-var approach requires a full redeployment to change a flag value, making
  rapid rollbacks impossible.
- The frontend UI toggle system has no concept of user cohorts — it is global-only, so targeted
  experiments (A/B tests, beta rollouts) are not supported.
- SRE has flagged (pun intended) that the lack of a kill-switch with sub-60-second propagation is
  a production risk for high-traffic features.

## Proposal

Introduce the Aurora Gate Service: a lightweight gRPC evaluation service backed by a versioned
etcd config store. Client SDKs (Go v1, TypeScript v1) wrap a simple `Evaluate(flagKey, userCtx)`
call. Results are cached at the edge with a 30-second TTL and a write-through invalidation path
for kill-switch operations.

**What this gives us:**
- A single source of truth for all flag definitions, with full version history and rollback.
- Cohort-scoped evaluation: flags can target by user ID, organization, percentage rollout, or
  arbitrary attribute predicates.
- A kill-switch path with guaranteed sub-60-second propagation via push invalidation.
- An Aurora Dashboard operator console for flag management without code changes.

**Scope for v1:** Go SDK + TypeScript SDK + Gate Service + etcd backing store + Aurora Dashboard
MVP. FlagManager v1 migration tooling ships in v1.1.

## Alternatives Considered

**LaunchDarkly / third-party SaaS**: Evaluated and rejected. The data residency requirements from
legal prevent sending user context to an external evaluation service. A self-hosted option was
considered but adds operational burden without meaningful cost savings over building in-house.

**Extend FlagManager v1**: FlagManager v1 is architected around a single global flag store with
no cohort primitives. Adding cohort support would require a near-total rewrite of its evaluation
core — at which point it is effectively a new system. Better to build Aurora cleanly and migrate.

**Config-file-per-service approach**: Simpler operationally but doesn't solve the cross-service
consistency problem — each service would still have its own source of truth.

## Open Questions

1. **Fail mode during network partition**: fail-open (return last known value) vs. fail-closed
   (return the configured default). Growth prefers fail-open; SRE prefers fail-closed.
2. **Push vs. pull for the SDK**: push (SSE/WebSocket) reduces lag for kill-switch operations;
   pull (polling) is simpler. Decision deferred to implementation phase.
3. **Hard deprecation date for FlagManager v1**: Without a date, teams won't migrate. Needs
   alignment from engineering leadership before Aurora v1 ships.

## Status

draft
