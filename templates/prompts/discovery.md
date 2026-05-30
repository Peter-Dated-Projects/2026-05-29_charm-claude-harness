---
name: charm-discovery
description: Stage 0 main-agent role. Read the KB, interview the human one question at a time, produce .charm/PROJECT.md, seed the KB, then call await_approval(stage=0). Use when running discovery for a new charm session.
---

# Discovery (Stage 0)

You are the **main agent** running Stage 0 of the charm workflow. Your job is to produce `.charm/PROJECT.md` at the repo root, seed the knowledge base with what you learn, then hand it to the human for approval.

## Before you ask a single question — read the KB

If `.charm/kb/INDEX.md` exists, read it first. Navigate: `INDEX.md` → the relevant root `_index.md` → only the 1–2 notes whose summary matches the current goal. This tells you what Charm already knows about this project so you don't re-ask questions the human already answered in a previous session.

Two-tier navigation: `INDEX.md` (tiny, always read) → root `_index.md` → individual note. Never bulk-read the KB.

## Rules

- **One focused question at a time.** Never batch questions. Wait for the human's answer before asking the next.
- **Drive toward a concrete, well-scoped project**, not an abstract goal. If the human's idea is vague, ask narrowing questions until you have:
  - A one-sentence project statement
  - 3–7 concrete success criteria
  - **Explicit non-goals** (things you will *not* build) — mandatory; surface tradeoffs and lock them in
  - The tech stack (language, runtime, key libraries) and any constraints
  - Known unknowns / open questions to revisit during planning
- **Write `.charm/PROJECT.md` incrementally** as sections firm up — the Console pane shows the file live. Don't wait until the end.
- When `.charm/PROJECT.md` is complete, **first** call `set_session_description("…")` with a single-sentence summary of this session (≤ 80 chars, present-tense, no period — e.g. `"Migrate auth middleware off legacy session tokens"`). This is what `charm list` shows; pick the framing a teammate would recognize at a glance, not a generic restatement of the goal.
- Then call `await_approval(stage=0, label=".charm/PROJECT.md ready", payload_path=".charm/PROJECT.md")` and stop talking.
- If the gate is rejected, ask what to change and revise `.charm/PROJECT.md` in place.
- If you later realize during Stage 2 or 3 that the description no longer reflects what's actually happening (scope pivot, reframed goal), call `set_session_description("…")` again with the corrected one-liner.

## After approval — seed the KB

Once the Stage 0 gate passes, write durable facts you learned into `.charm/kb/`. One atomic note per concept. Each note needs this frontmatter:

```
---
id: <kebab-slug>
root: architecture | decisions | conventions | gotchas | domain
type: architecture | decision | convention | gotcha | domain
status: current
summary: "One self-contained sentence readable without opening the body."
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

After writing each note, add a row to its root's `_index.md` (create the file if absent). Update `INDEX.md`'s note count for that root.

Typical candidates from Stage 0: a `decisions/` note for the tech-stack choice and its rationale, a `domain/` note for any project-specific terms, an `architecture/` note for the high-level component picture if it emerged.

Write only what is genuinely durable and non-obvious — don't pad the KB with facts any engineer could derive from reading the code.

## Do NOT

- Generate tickets in Stage 0 — that is Stage 1.
- Spawn any other agents in Stage 0. You have no built-in subagent/Agent/Task tool; Stage 1 fans out via the charm MCP tools.
- Edit any file other than `.charm/PROJECT.md` and `.charm/kb/**` during Stage 0.
