# Normalized documentation model

Use this as a design reference, not as a mandate to create every document type.

## Tree and manifests

**Design inference:** Mirror meaningful workspaces and runtime ownership boundaries. Do not mirror every implementation directory.

```text
docs/repository/
  index.md
  manifest.yaml
  agent-policy.md
  _shared/
    architecture.md
    contracts/
  apps/web/
    index.md
    manifest.yaml
    flows/
  services/api/
    index.md
    manifest.yaml
    contracts/
  packages/auth/
    index.md
```

The root manifest routes to a workspace. A workspace manifest routes to a small set of documents. Put cross-cutting contracts in `_shared`; link to them from workspaces. Add a child manifest only when the scope has several documents or submodules worth routing independently.

Route a child manifest from its parent with a `workspaces` entry:

```yaml
workspaces:
  - scope: apps/web
    manifest: docs/repository/apps/web/manifest.yaml
    summary: Web application documentation
```

## Document types

| Kind | Purpose | Must answer |
| --- | --- | --- |
| `index` | Orientation and routing | What is owned here, what is not, and what should I read next? |
| `architecture` | Stable structural view | Which runtime boundaries, dependencies, data owners, and extension points matter? |
| `contract` | Rules callers and changes must preserve | What invariants, compatibility, isolation, and error behavior apply? |
| `flow` | Cross-boundary operation | What triggers it, which steps and side effects occur, and how does it fail? |
| `procedure` | Verified operational work | Which prerequisites, commands, ordering, and checks make this work? |
| `decision` | Durable rationale | What was chosen, instead of what, with which consequences and revisit condition? |
| `reference` | Compact stable facts | Which ports, environment names, interfaces, generated locations, or owners are relevant? |

Avoid tutorials unless human onboarding genuinely needs them. They are usually poorer task-time context than a contract, flow, or procedure.

## Frontmatter

Every normalized document starts with a stable identifier and scope. Use `status: verified`, `possibly-stale`, `incomplete`, or `deprecated`. Put source and update globs beside the claim, not only in a central registry.

```yaml
---
id: packages.auth.authorization
kind: contract
status: verified
scope:
  - packages/auth/**
source_paths:
  - packages/auth/src/authorize.ts
last_verified_commit: abc1234
related:
  - flow.sign-in
update:
  triggers:
    - packages/auth/src/authorize.ts
  policy: required-review
---
```

## Evidence vocabulary

- **Verified** — directly supported by current code, configuration, schema, test, or accepted repository record. Include paths.
- **Inferred** — a careful conclusion from incomplete evidence. State the basis and missing proof.
- **Declared** — a policy or decision that may not be mechanically enforced.
- **Unknown** — not safely established. State the next evidence source or owner.

Never elevate an inference to a fact to complete a template. When implementation and an accepted decision disagree, record both as a conflict.

## Snippets and diagrams

Prefer a source link over copied implementation. Use a snippet only when it supplies stable integration information that source navigation cannot convey quickly: a verified command, HTTP/event example, compact type shape, or non-obvious sequence. Keep it under about 20 lines and name its source.

Use a Mermaid diagram only when cross-boundary relationships are easier to understand visually. Keep it small, label every edge, then explain its implication in prose. Good uses: service boundaries, event flow, trust boundary, deployment flow. Bad uses: class inventories, folder trees, local functions, or generated dependency graphs.

## Writing rules

Write the system relationship and why it matters, not a retelling of individual implementation lines. Omit empty template sections. Keep one canonical fact in one location. Make documents easy to scan: short opening, focused headings, source evidence, and explicit unknowns.
