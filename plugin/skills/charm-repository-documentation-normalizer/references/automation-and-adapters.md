# Tool-neutral policy and generated adapters

The canonical policy is `docs/repository/agent-policy.md`. It defines how an agent gathers evidence, decides whether to load docs, makes a change, verifies it, refreshes docs, and escalates risk. It contains no tool-specific syntax.

## Generated surfaces

| Surface | Generated file | Scope design |
| --- | --- | --- |
| Generic / Codex | `AGENTS.md` | Root router; use nested files only for a truly local policy. |
| Claude Code | `CLAUDE.md` | Root router; keep it thin because it is loaded as project memory. |
| Gemini CLI | `GEMINI.md` | Root router; rely on its hierarchical and just-in-time discovery for local instructions. |
| Cursor | `.cursor/rules/charm-repository-docs.mdc` | `alwaysApply` only for the short router; create scoped rules only from scoped policy. |
| GitHub Copilot | `.github/copilot-instructions.md` | Root guidance; generate `.github/instructions/*.instructions.md` only for path-specific policy. |

These adapters intentionally repeat only the non-negotiable routing rules, then point to the policy and documentation tree. They must not duplicate architecture, feature-specific rules, or changing commands. The generator reads `assets/templates/adapter.md` and embeds short policy/template hashes, so `--check` detects either source changing.

## Adapter safety

Run `generate_adapters.py --check` in CI. Its default write behavior refuses to overwrite a hand-authored adapter. Decide deliberately whether to migrate a hand-authored file into the canonical policy, retain it outside generation, or force replacement after review. Do not silently erase local team instructions. Vendor the skill's scripts and templates into `.charm-docs/` when CI or non-global agents need them.

Use thin, directory-scoped instruction files only when a subtree has distinct constraints. A path-specific adapter should point to the nearest workspace manifest and describe the path boundary; it should not reproduce its index or contracts.

## Access policy

The root router says when documentation can be skipped. For a routine local edit, agents should proceed with source and tests only. For unfamiliar modules or ambiguous extension points, agents load the nearest index. For API, auth, data, jobs, external integrations, shared packages, compatibility, cache, or transaction changes, they load routed contracts and flows. Architectural documents and decisions are reserved for ownership/topology/dependency decisions.

This is a design choice based on tool capabilities, not a claim that every model implements relevance selection identically. Test adapters in each enabled tool and treat the local behavior as authoritative.
