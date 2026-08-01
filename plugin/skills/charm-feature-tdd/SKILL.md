---
name: charm-feature-tdd
description: Create evidence-backed, draft-first Feature TDDs for coding projects. Use when defining, investigating, feasibility-checking, designing, or documenting a feature, API, workflow, or behavior change before coding.
---

# Feature TDD

Use two stages. Do not code, create tickets, or finalize a TDD until asked.

## Rules

- Treat code/docs as evidence; never invent existing behavior or structure.
- Mark material statements **Verified**, **Decision**, **Assumption**, or **Open question**.
- Keep a compact temporary ledger outside the repo: goal, evidence, constraints, options, questions, reports.
- Search the repo before asking questions it can answer.
- The lead owns user communication, feasibility, and synthesis. Subagents only gather evidence.

## 1. Goal and feasibility

Refine the outcome with the user while inspecting the repo. Record users, trigger, desired behavior, success signal, affected surfaces, seams, risks, and dependencies.

### Mini-swarm

1. Localize first with targeted search and small file reads.
2. Use one scout by default; use at most three only for independent concerns (UI/state, data/contracts, analytics, tests/risk).
3. Give each scout one question, up to five starting paths, no full TDD/conversation, an eight-file budget, and a 250-word Markdown report:

   `Verdict: supported | supported with change | blocked | unknown`  
   `Evidence: <claim> — <path>:<symbol>`  
   `Seam | Risk | Next check`

4. Build a claim ledger. Verify only high-impact or conflicting claims; verifiers receive claims, not full reports. Read citations directly to resolve conflicts. Escalate only for a cross-boundary change, no credible seam, or unresolved conflict.

Present a **Ready for TDD** readout: goal, evidence-backed direction, tradeoff, risks, and remaining user decisions. Continue only when the user confirms or asks for a draft.

## 2. Draft and finalize the TDD

Produce a **Draft Feature TDD** for review. Save it only where the user requests after approval. Use only applicable sections:

1. Scope/context and exclusions
2. What we are doing: exact rules, states, thresholds, negative cases
3. Why: failure mode, outcome, metrics, guardrails
4. Contracts: flags, data/API, analytics, permissions, validation
5. Implementation plan: dependency order, PR stack, ownership, out-of-scope, rollout
6. Work-item details: owned files/symbols, behavior, tests, boundaries
7. Open questions, assumptions, risks

End with the consequential decisions and unanswered questions. Revise from user feedback; finalize only on request. Before finalizing, remove stale assumptions and ensure requirements are observable and testable.

## Quality

Specify conditions and failure behavior; avoid vague language. Cite files/symbols only when verified. Use tables for exact mappings and diagrams only when they clarify dependencies or state.
