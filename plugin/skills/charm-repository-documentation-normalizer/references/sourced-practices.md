# Public-source basis and design inferences

Checked 2026-07-31. This file separates externally documented capabilities and practices from the normalizer's own design.

## Sourced practices

| Source | What it supports | How the skill uses it |
| --- | --- | --- |
| [OpenAI, *How OpenAI uses Codex*](https://cdn.openai.com/pdf/6a2631dc-783e-479b-b1a4-af0cfbd38630/how-openai-uses-codex.pdf) | Maintaining `AGENTS.md` can give Codex repository-specific operating context. | Provide an `AGENTS.md` adapter, not a vendor-only documentation system. |
| [Anthropic, *Manage Claude's memory*](https://docs.anthropic.com/en/docs/claude-code/memory) | Claude Code discovers project and nested `CLAUDE.md` files; nested files enter context when their subtrees are accessed; imports are supported. | Keep the root adapter short and use local policy only where it is genuinely scoped. |
| [Gemini CLI, *Provide context with GEMINI.md files*](https://geminicli.com/docs/cli/gemini-md/) | Gemini has global, workspace, and just-in-time hierarchical `GEMINI.md` discovery; it supports imports and a configurable context filename. | Generate a thin root `GEMINI.md`; preserve on-demand local context. |
| [Cursor, *Rules*](https://docs.cursor.com/context/rules-for-ai) | Cursor rules have application modes, including always-apply and agent-requested rules, plus path globs. | Make only the router always applied; treat deeper instructions as scoped/on-demand. |
| [GitHub, *Adding repository custom instructions for GitHub Copilot*](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions) | Copilot supports repository-wide `.github/copilot-instructions.md`, path-specific `.github/instructions/*.instructions.md`, and nearest `AGENTS.md` files; matching repo and path instructions combine. | Generate the repository-wide adapter and reserve path-specific files for real local policy. |
| [Backstage TechDocs overview](https://backstage.io/docs/techdocs/) | TechDocs is a docs-like-code solution, with creation/publishing and CI/CD material in its official docs. | Keep canonical docs in version control and make validation/publishing automatable. |
| [C4 model introduction](https://c4model.com/introduction) | System-context and container diagrams provide different abstraction levels; component/code diagrams are deeper zooms. | Favor small boundary and flow diagrams, not exhaustive implementation diagrams. |
| [Google, *Small CLs*](https://google.github.io/eng-practices/review/developer/small-cls.html) | Small, self-contained changes are easier to review, reason about, merge, and roll back; substantial refactors should be separated. | Require focused updates and avoid a full documentation rewrite after a local code change. |
| [Google, *What to look for in a code review*](https://google.github.io/eng-practices/review/reviewer/looking-for.html) | Reviews should consider design, tests, consistency, broader context, and related documentation when behavior changes. | Require documentation impact review as part of substantive change completion. |
| [Google Markdown style guide](https://google.github.io/styleguide/docguide/style.html) | A small, fresh, accurate documentation set is preferable to a sprawling collection in disrepair. | Use status, freshness metadata, progressive retrieval, and deletion of redundant prose. |

## Design inferences in this skill

The following are proposals made by this skill; they are not claimed to be universal product behavior or a standard:

- A tool-neutral canonical policy plus generated vendor adapters prevents duplicated guidance from drifting.
- A hierarchical manifest with document IDs, scope, load triggers, skip conditions, and token estimates gives agents deterministic retrieval while avoiding blanket context loading.
- Evidence labels (Verified, Inferred, Declared, Unknown) and `last_verified_commit` make uncertain or stale material visible rather than superficially complete.
- Root/workspace manifest routing, plus an explicit access gate, is an appropriate default for monorepos.
- Bootstrap swarming should use isolated evidence lanes and a coordinator/reconciler, not concurrent edits to canonical documentation.
- CI should fail objective structural defects first and only enforce semantic-review triggers after teams calibrate their ownership and paths.

Validate these inferences against the actual tools, repository culture, and CI capabilities before enforcing them.
