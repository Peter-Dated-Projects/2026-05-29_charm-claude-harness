# Bootstrap swarm architecture

Use a swarm only when the repository is large enough that independent evidence-gathering lanes materially reduce time without creating competing truth. The coordinator owns all write decisions until reconciliation.

## Gate

Parallelize when there are at least two independently inspectable workspaces or bounded concerns, the repository has a stable base revision, and the coordinator can give each worker a non-overlapping path and output contract. Prefer three to five lanes; more usually increases synthesis cost.

Do not parallelize when the repository is small; the boundary is not yet known; a single runtime trace is needed to understand the system; sensitive credentials or production state are involved; the same files must be interpreted by multiple workers; or coordinating output would cost more than one focused pass.

## Roles and partitioning

| Role | Reads | Produces | Does not do |
| --- | --- | --- | --- |
| Coordinator | Existing instructions, inventory, all lane briefs | Scope map, final manifests, reconciliation log | Delegate unbounded "document the repo" work |
| Topology scout | Root config, workspace declarations, CI, deploy config | Workspace map, commands, candidate boundaries, evidence paths | Assert runtime behavior from filenames |
| Workspace analyst (one per independent workspace) | Assigned source subtree and immediate interfaces | Draft index/architecture, flows, source evidence, unknowns | Edit shared contracts or other workspaces |
| Contract analyst | Schemas, public routes, auth, data access, event definitions | Cross-cutting contracts, compatibility risks, explicit conflicts | Infer intended policy from a single caller |
| Procedure analyst | Build/test/tooling config and CI | Verified/unverified command procedures | Claim execution unless commands were run |
| Reconciler | All candidate artifacts plus source of record | Canonical placement, deduplication, conflict list, final vocabulary | Average incompatible conclusions |
| Verifier | Generated docs, manifests, adapter output, targeted source paths | Validation report and sampled claim checks | Rewrite semantics without reporting the issue |

Give each worker a bounded task: paths, questions, output paths, evidence requirement, and explicit shared-files prohibition. Let workers write only isolated drafts such as `work/docs-bootstrap/<lane>/`; the coordinator alone promotes material into `docs/repository/`.

## Lane handoff contract

Require each lane to return:

1. Scope inspected and commit/revision.
2. Claims, each marked Verified, Inferred, Declared, or Unknown.
3. Evidence paths and exact reason they support the claim.
4. Candidate document IDs and relationships.
5. Conflicts, gaps, and questions for another lane.
6. Commands executed and their result.

Use fixed labelled Markdown, not a prose essay or a giant repository summary.

## Merge and reconciliation

1. Freeze the discovery revision and collect drafts without merging them into canonical files.
2. Build a claim ledger keyed by canonical document ID and source evidence.
3. Deduplicate claims, choose one home for each fact, and replace copied explanations with links.
4. Resolve a disagreement by re-reading the authoritative source. If evidence remains ambiguous, preserve it as an Unknown or documented conflict; never vote or blend claims.
5. Write root/workspace manifests last, after document IDs and relationships stabilize.
6. Generate adapters from the final canonical policy and run validation.

## Verification

The verifier checks document IDs, source links, manifest references, source-path trigger coverage, adapter drift, and sampled high-risk claims (authorization, data ownership, public API, migration, event delivery). The coordinator independently samples at least one claim from each lane and every cross-workspace contract. Treat structural validation as necessary but insufficient: it cannot prove a semantic claim.

## Scale-down alternative

For a medium repository, use a two-pass sequence instead: one inventory/topology pass, then one targeted document pass. For a small repository, a single agent should inventory, document, and validate serially; it retains the context needed to recognize real boundaries.
