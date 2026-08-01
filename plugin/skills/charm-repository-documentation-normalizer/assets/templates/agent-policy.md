---
id: repository.agent-policy
kind: policy
status: verified
source_paths:
  - AGENTS.md
  - CLAUDE.md
  - GEMINI.md
  - .cursor/rules/**
  - .github/**
update:
  triggers:
    - docs/repository/agent-policy.md
  policy: required-review
---

# Canonical agent working policy

## Authority and evidence

- Follow repository-scoped instructions first, then this policy, then local conventions.
- Treat code, schemas, tests, and deployed configuration as evidence of current implementation. Treat accepted decisions and documented policies as intended architecture. Name conflicts; do not silently resolve them.
- Do not invent commands, ownership, interfaces, data guarantees, or deployment behavior. Label unverified claims and ask or investigate before relying on them.

## Context and documentation

- Do not preload repository documentation. Use the documentation access gate in the root index; route only work that crosses a documented boundary or lacks a clear local pattern.
- Start with the smallest relevant manifest and index. Load contracts before changing their boundary. Confirm critical claims in the present code.
- If code changes a documented flow, contract, procedure, decision, or public boundary, update it or record `reviewed-no-change` with evidence.

## Change discipline

- Make the smallest coherent change that solves the request. Keep behavior changes separate from broad refactors unless the repository owner explicitly requests both.
- Follow the nearest established implementation and test pattern. Preserve authorization, tenancy, validation, idempotency, compatibility, transaction, and error-handling boundaries unless the task explicitly changes them.
- Do not modify generated output by hand. Change the generator or its source template and regenerate.
- Do not overwrite unrelated local changes. Stop and surface ambiguity when a safe merge cannot be established.

## Verification and handoff

- Run the narrowest relevant formatter, type check, tests, and integration verification available. State what was run, what was not run, and why.
- For externally visible, data-writing, asynchronous, or permission-sensitive changes, trace the relevant runtime path and test failure behavior as well as the happy path.
- Report changed paths, behavioral impact, documentation impact, verification, and remaining uncertainty. Do not claim completion based only on compilation or screenshots.

## Escalation

- Request direction before destructive data operations, security-sensitive policy changes, public compatibility breaks, production deployment, or an architectural decision with material trade-offs.
- If documentation and executable evidence conflict, preserve both facts, identify the owner, and avoid presenting the mismatch as settled.
