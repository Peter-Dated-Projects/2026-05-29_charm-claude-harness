# Parallelization Strategies for LLM Orchestration Skills

A reference for skill authors deciding how to structure multi-agent fan-out, pipeline stages, and dependency ordering. Written for the charm harness but applicable to any LLM orchestration framework.

---

## 1. Parallelizable vs. Sequential Work

**A task is parallelizable when:**

- Its inputs are fully determined before it starts (no dependency on another in-flight task's output).
- Its output does not affect the inputs of any task running concurrently with it.
- Running it multiple times with the same input produces the same observable result (idempotent), or side effects are isolated enough that concurrent runs cannot collide.
- Failure of one instance does not corrupt the state needed by sibling instances.

**A task must be sequential when:**

- It consumes the output of a prior task that hasn't finished yet.
- It mutates shared state (a file, a database row, a counter) that a sibling also writes.
- Ordering is semantically meaningful to downstream consumers (e.g., an append-only log where ordering implies causality).
- The task is a gate: it decides whether the rest of the work should proceed at all.

**Quick test:** draw the data-flow graph. If there's no edge from task A to task B, they can run in parallel. If there's an edge (A produces something B needs), B must start after A emits that output — either by waiting for A to finish (barrier) or by streaming output incrementally (pipeline).

---

## 2. Identifying Atoms of Parallel Work and Expressing Fan-Out

An "atom" is the smallest unit of work that can be dispatched independently. Getting atoms right is the core skill-design decision.

**How to identify atoms:**

- Take the full work-list (e.g., a list of files, tickets, dimensions, test cases) and ask: "could two of these be processed simultaneously without any shared mutable state?" If yes, each item is an atom.
- Atoms tend to be: one file, one ticket, one search query, one dimension of review, one hypothesis to verify.
- Atoms should not be: "half the codebase," "all the bugs found so far," or anything whose size is unbounded and whose sub-parts are themselves independent.

**Expressing fan-out in a skill spec:**

Use language like:

> "For each item in [list], spawn one agent. Agents are independent — they do not share state and do not need each other's output."

or:

> "Fan out over [dimensions]. Each dimension agent receives only its own slice of the input. Collect all results before the next stage."

Avoid vague language like "process these in parallel" without specifying what "these" are and what independence guarantee holds.

**Upper-bound the fan-out.** A skill spec should say "up to N agents" or "one per item, capped at K." Unbounded fan-out exhausts concurrency slots and produces noisy, hard-to-read progress trees.

---

## 3. Pipeline vs. Parallel (Barrier) — Concrete Criteria

### Pipeline (no barrier between stages)

- Each item flows through all stages independently.
- Item A can be in stage 3 while item B is still in stage 1.
- Wall-clock time = slowest single-item chain, not sum of slowest-per-stage.
- Use when: items are independent across stages, you want maximum throughput, and no stage N needs cross-item context from stage N-1.

**Use pipeline when:**

- Each item's stage-2 work depends only on that item's stage-1 output.
- You can label agents by item (e.g., `review:bugs`, `verify:bugs`) and they never need to see each other's output.
- You want to start verifying early findings while later findings are still being generated.

### Parallel with barrier

- All stage-N work completes before any stage-N+1 work begins.
- Use when stage N+1 genuinely needs the full set of stage-N results to do its work correctly.

**Use a barrier only when:**

- Deduplication requires the full set (you need to see all findings to remove duplicates before expensive downstream work).
- An early-exit decision depends on the total count across all stage-N outputs (e.g., "if zero bugs found, skip verification entirely").
- Stage N+1 prompts reference "the other findings" or "across all results" — language that implies cross-item context.
- You are synthesizing: writing a summary, ranking, or merging that requires seeing everything at once.

**The barrier smell test:** if your barrier is followed immediately by a `map`/`filter`/`flatten` that does not reference cross-item state, you added a barrier for code cleanliness, not correctness. Rewrite as a pipeline stage.

---

## 4. Dependency Graphs: Expressing "A and B in Parallel, C Waits for Both"

The standard dependency graph pattern for skill specs:

```
[A]--\
      +--> [C] --> [D]
[B]--/
```

Express this in prose as:

> "Spawn A and B in parallel. Once both complete, collect their outputs and pass the merged result to C. C must not start until both A and B have finished. D runs after C."

In code (charm/workflow harness):

```js
const [a, b] = await parallel([() => agent(promptA), () => agent(promptB)])
const c = await agent(promptC(a, b))
const d = await agent(promptD(c))
```

Key rules for dependency graph specs:

- Name every node explicitly. Anonymous "run these two things" steps hide dependencies.
- State the merge semantics. "Once both complete" is not enough — say what gets passed: "the union of their findings," "A's output as context and B's output as the primary input," etc.
- If C only needs A's output and B is a side-check, say so. You may not need a full barrier — C could start when A finishes, with B running independently as a verification that gets reconciled later.

---

## 5. Stage Barrier Justification: Cost vs. Benefit

Every barrier adds latency equal to `(slowest_stage_N_agent - fastest_stage_N_agent)`. On a heterogeneous work-list this can be substantial.

**Barrier cost:**

- Fast agents idle while slow agents finish.
- Errors in one agent can block all downstream work (fail-fast vs. skip-and-continue tradeoff).
- Context grows: all stage-N outputs must be held in memory simultaneously before stage N+1 begins.

**Barrier benefit:**

- Cross-item deduplication before expensive verification (avoids verifying the same finding twice).
- Reliable early-exit (avoids spawning N verification agents when zero findings exist).
- Synthesis quality (a summarizer sees the full picture rather than a partial one).

**Justification template for skill specs:**

> "We use a barrier after [stage name] because [stage N+1] requires [specific cross-item data]. Without it, [specific failure mode]. The latency cost is acceptable because [agents are fast / the list is small / the downstream work is expensive enough to justify deduplication]."

If you cannot fill in all three blanks, remove the barrier and use pipeline.

---

## 6. Common Pitfalls

### Over-parallelization

Spawning agents for work that is trivially fast or tightly coupled. Signs: agents are spawned for one-line operations, fan-out is over individual lines rather than logical units, agents constantly need each other's state.

Fix: raise the atom size. Merge trivially small items into one agent's scope.

### Barrier overuse

Adding barriers between every stage "to be safe." This turns a pipeline into a sequential chain and eliminates the throughput benefit of parallelism entirely.

Fix: audit every barrier. If you cannot write a one-sentence justification for why cross-item context is needed, remove it.

### Context leakage between parallel agents

One agent's output (or side effect) becomes visible to a sibling before the skill designer intended. Common in file-writing workflows where agents write to the same path, or in shared-counter scenarios.

Fix: give each parallel agent an isolated scope. Separate output paths, separate keys, separate databases. Merge at the barrier, not during the parallel phase.

### Deduplication bugs

Filtering against `confirmed` instead of `seen`. If a finding is generated but rejected by a verifier, it's not in `confirmed` — so it re-appears in the next discovery round and gets re-processed indefinitely, preventing convergence.

Fix: dedup against the full `seen` set (everything ever generated), not the filtered output set.

### Silent truncation

Bounding the work-list (top-N, no-retry, sampling) without surfacing the bound to downstream consumers or the final report. Reads as "we covered everything" when the skill silently skipped items.

Fix: `log()` every bound explicitly. "Capped at 20 findings; 7 were dropped." Let the synthesizer know.

### Prompt ambiguity in parallel dispatch

Using "process all of these" in a single agent's prompt when you meant fan-out. The agent either hallucinates parallel behavior or processes items sequentially inside a single context.

Fix: each agent receives exactly one item and one task. Use index or item label in the agent's prompt and label. See prompt fragments below.

---

## 7. Prompt Construction Patterns for Parallel Dispatch

### Single-item dispatch (the baseline)

> "Your input is item [index]: [item]. Process only this item. Do not reference or assume knowledge of other items. Return your result in the specified schema."

Key elements: explicit index, explicit scope boundary ("only this item"), explicit isolation ("do not reference other items").

### Dimension dispatch

> "Your dimension is [dimension name]. Review the provided artifact for issues in this dimension only: [dimension description]. Other dimensions are being reviewed by separate agents. Return findings as a JSON array matching the schema."

Key elements: name the dimension, name the exclusion ("other dimensions handled elsewhere"), structured output.

### Adversarial verification

> "A prior agent claimed: [finding]. Your job is to refute this claim. Default to refuted=true if you are uncertain. Only mark refuted=false if you can cite specific evidence in the provided context that confirms the claim is real. Return: {refuted: bool, evidence: string}."

Key elements: explicit default bias (refuted=true), cite-or-reject requirement, binary output.

### Synthesis after barrier

> "The following [N] findings were confirmed across [K] agents: [findings]. Synthesize them into a structured report. Do not add findings that are not in this list. Group by severity. Flag any that contradict each other."

Key elements: explicit count, explicit source ("confirmed across agents"), explicit constraint ("do not add"), grouping and conflict instructions.

### Loop-until-dry discovery

> "Find [things] in [scope] that have not already been found. Previously found: [seen list]. Return new items only. If you find nothing new, return an empty array."

Key elements: pass the `seen` list explicitly, instruct "return new only," empty array as the convergence signal.

### Fan-out with explicit merge instruction (for barrier-then-synthesize)

> "You are one of [N] agents scanning [scope]. Your slice is [slice description]. Return your findings as a JSON array. A separate synthesis agent will merge all [N] arrays after all agents complete."

Key elements: tell the agent it's one of N, describe the downstream merge step so the agent doesn't try to synthesize itself.

---

## Summary: Decision Heuristics

| Question | If yes | If no |
|---|---|---|
| Does item B need item A's output? | Sequential / pipeline (B after A) | Parallel |
| Does stage N+1 need the full set from stage N? | Barrier | Pipeline |
| Are agents writing to shared mutable state? | Isolate scopes | Fine as-is |
| Can you fill in the barrier justification template? | Keep barrier | Remove barrier |
| Is the atom size larger than one trivial operation? | Good | Raise atom size |
| Does the prompt say "only this item"? | Good | Add scope boundary |
| Is the dedup set `seen` (not `confirmed`)? | Good | Fix dedup |
| Is every truncation bound logged? | Good | Add log() call |
