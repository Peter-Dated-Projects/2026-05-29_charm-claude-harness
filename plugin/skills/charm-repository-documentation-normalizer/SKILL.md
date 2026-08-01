---
name: charm-repository-documentation-normalizer
description: Create, bootstrap, refresh, or validate lean, evidence-backed repository documentation and tool-neutral agent working policies. Use when establishing documentation for a codebase or monorepo; generating AGENTS.md, CLAUDE.md, GEMINI.md, Cursor, or GitHub Copilot adapters; documenting a subsystem or runtime flow; checking documentation freshness; or designing documentation automation and safe agent workflows.
---

# Charm Repository Documentation Normalizer

Create a small, navigable repository knowledge layer. Keep instruction adapters thin; keep canonical knowledge in versioned documentation; use source, schemas, tests, and configuration as implementation evidence.

## Choose a mode

| Mode | Use it for | Output |
| --- | --- | --- |
| `bootstrap` | A repository has no normalized knowledge layer. | Inventory, documentation plan, initial docs, manifests, policy, and adapters. |
| `targeted` | One subsystem, workflow, or contract needs documentation. | Only its documents, manifest entry, and affected indexes. |
| `refresh` | Code changed after documentation was established. | Documentation impact review and minimal updates. |
| `validate` | CI, handoff, or pre-merge checking. | Structural, reference, freshness, adapter, and size results. |

Read [documentation-model.md](references/documentation-model.md) before writing normalized documents. Read [bootstrap-swarm.md](references/bootstrap-swarm.md) before delegating bootstrap work. Read [automation-and-adapters.md](references/automation-and-adapters.md) before installing platform files. Read [sourced-practices.md](references/sourced-practices.md) when explaining or revisiting this design.

## Operating rules

1. Read the repository's existing instructions and documentation before creating anything. Preserve high-quality, existing material and link to it rather than replacing it.
2. Establish an evidence ledger before claiming architecture. Label each important statement **Verified**, **Inferred**, **Declared**, or **Unknown**. Code, schemas, configuration, and tests show current implementation; accepted decisions and policies show intended direction. Surface conflicts.
3. Mirror meaningful workspace boundaries in a monorepo, not every source directory. Use a root manifest to route into workspace manifests, then load only the nearest relevant index, flow, and contracts.
4. Put one canonical fact in one canonical document. Link instead of duplicating. Do not turn source code into a prose shadow copy.
5. Install the tool-neutral policy at `docs/repository/agent-policy.md`. Generate tool-specific adapters from it; never hand-maintain architectural facts in several adapters.
6. Use the access gate below before loading deep documentation. A task may legitimately need no repository documents.
7. Do not write semantic documentation merely to satisfy a check. Record `reviewed-no-change` when code changes do not alter the documented claim.
8. Never mark a command verified unless it was run successfully in the relevant environment or is explicitly labelled unverified.

## Documentation access gate

Skip normalized docs when all are true: the edit is localized; the local pattern is clear; no public/API, authorization, tenancy, persistence, event/job, shared-package, cache, transaction, or deployment boundary changes; and targeted tests are obvious.

Otherwise, route before editing:

```bash
python3 .charm-docs/route_docs.py --root . --task "<task>" --paths <changed-or-planned-paths>
```

If `.charm-docs/` is not installed, run the copy from this skill. Load the root manifest, then exactly the routed workspace manifest and required documents. Load architecture and decision documents only for ownership, topology, or major dependency decisions. If the route is insufficient, search the codebase and update the manifest only after establishing the missing boundary.

## Bootstrap workflow

1. Run `python3 <skill>/scripts/bootstrap_inventory.py --root <repo> --output <repo>/.charm-docs-inventory.json`.
2. Read existing instructions, build files, CI, test configuration, source entry points, migrations, and durable decisions. Identify workspace and ownership boundaries.
3. Decide whether the scope merits a swarm. Follow [bootstrap-swarm.md](references/bootstrap-swarm.md); do not parallelize a small repository, a poorly bounded system, or work that requires a shared runtime trace.
4. Create `docs/repository/` from [templates](assets/templates/): root index, root manifest, tool-neutral policy, shared contracts, and one mirrored documentation subtree per meaningful workspace. Create child manifests only when the root routing list would become unwieldy. Copy this skill's `scripts/*.py` and `assets/templates/` to `.charm-docs/` when repository-local routing or CI enforcement is requested; keep those copies generated from the skill.
5. Add documents by conceptual boundary: `index`, `architecture`, `contract`, `flow`, `procedure`, `decision`, and `reference`. Omit empty sections. Use short source links rather than copied implementation.
6. Generate platform adapters only after the policy and root manifest exist:

```bash
python3 .charm-docs/generate_adapters.py --root . --templates .charm-docs/templates --check
python3 .charm-docs/generate_adapters.py --root . --templates .charm-docs/templates --write
```

The generator derives adapters from `adapter.md`, embeds the current canonical-policy and template hashes, and refuses to overwrite non-generated adapters without `--force`.

7. Validate, fix objective findings, and report remaining semantic uncertainty:

```bash
python3 .charm-docs/validate_docs.py --root . --changed
```

## Refresh and CI workflow

1. Compare the changed paths with manifest `update.triggers` and document `scope`/`source_paths`.
2. For each match, choose: `updated`, `reviewed-no-change`, `possibly-stale`, or `unknown-impact`.
3. Update the smallest affected documents and their `last_verified_commit` where evidence supports it.
4. Run `validate_docs.py --changed` locally and in CI. Fail objective defects such as malformed manifests, broken references, and stale adapters. Report freshness impacts as warnings by default. After maintainers calibrate triggers, add `--enforce-freshness`; acknowledge an evidence-backed no-change review with `--reviewed-no-change <document-id>`.

Use `--base <git-revision>` in CI when the default diff base is not correct. See [evidence-and-freshness.md](references/evidence-and-freshness.md).

## Content limits

- Keep root adapters about 10–25 actionable lines; do not use them as architecture documents.
- Keep indexes and manifests navigational; deeper documents are on demand.
- Use snippets only for verified commands, stable requests/responses, compact interface shapes, or non-obvious integration patterns. Keep each under about 20 lines and cite its source path.
- Use Mermaid selectively for cross-boundary structure, runtime flows, events, deployment, or trust boundaries. Prefer a small labelled diagram plus a textual interpretation; avoid class diagrams and dependency hairballs.
- Record uncertainty. A polished but unsupported sentence is worse than a short unknown.

## Completion report

Report: mode; documents and adapters added or changed; evidence and unresolved conflicts; routing/size budget; validation result; and exact follow-up ownership for anything not verified. Clearly separate sourced practices from design choices when presenting the system.
