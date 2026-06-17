# Phasing and Sequencing Strategies for Orchestration Skill Design

> **Design note — non-normative.** This document captures rationale and research, not a
> specification of current harness behavior. Where anything here conflicts with the code or
> the operating docs, the code wins.

Covers principles, failure modes, and prompt fragments for defining phases in a skill spec.

---

## 1. Phase vs. Step: What Is the Difference?

A **step** is an atomic unit of work within a single agent's context window. The agent
reads some input, does something, and emits output — all in one pass. Steps are
sequential within one agent and share a live context.

A **phase** is a boundary that separates work *across agents or across context resets*.
Crossing a phase boundary means: the current agent's context is closed, a new context is
opened, and a well-defined artifact (not implicit state) is the only thing that passes
forward.

The distinction matters because the decision to add a phase has a hard cost: context is
lost, latency is added, and a serialization/handoff mechanism must work correctly. A
step inside one agent is free by comparison.

**When to use phases vs. sequential steps**

Use steps within a single agent when:
- The sub-tasks are small enough to fit in one context without crowding
- Each step directly uses the results of the prior step
- The agent can self-correct mid-sequence without needing fresh context
- There is no natural "gate" — no point where you'd want a human or another agent to
  inspect before continuing

Use phases (separate agents, separate contexts) when:
- The output type fundamentally changes (e.g., a list of files transitions to actual
  edits — different tools, different modes of reasoning)
- An earlier phase's result set is unbounded or unknown — you cannot write a single
  prompt that handles N cases where N is only known at runtime
- Independent verification is required before committing to the next stage
- Work fans out — the output of phase N is a manifest of K items to process in parallel
  in phase N+1
- Context contamination is a risk — a phase N agent that has seen its own partial
  failures may rationalize bad output; a fresh agent starting from a clean summary is
  more reliable

**Failure mode: treating every step as a phase.** Every phase boundary costs: latency,
a handoff artifact that must be correct, and the risk that something important is lost in
translation. Phases should earn their existence.

---

## 2. What Makes a Good Phase Boundary?

A phase boundary is justified when *all three* of the following hold:

1. **State change** — the nature of the artifact changes. "A list of candidate files" is
   qualitatively different from "the actual edit applied to those files." Crossing a
   boundary forces this to be explicit.

2. **Output type change** — the downstream agent needs a different schema. Phase 1 emits
   `{files: string[]}`. Phase 2 consumes that and emits `{patch: Diff}`. These are
   different types. An agent prompt that tries to do both often produces muddled output.

3. **Different agent types (or different reasoning modes)** — a scout (read-only, fast,
   broad) is a different agent from a fixer (write, slow, narrow). A verifier reasons
   adversarially, not constructively. These modes interfere when jammed into one context.

A boundary at which only *one* of the three holds is a candidate for elimination. Ask:
"could the downstream work be a step inside the upstream agent?" If yes, the boundary
probably should not exist.

**Additional signal that a boundary is correct:**
- A human reviewing the output of phase N would naturally pause before triggering phase
  N+1. The boundary corresponds to a natural review point.
- The output of phase N could be cached and replayed — it is a deterministic artifact,
  not just in-flight memory. If you cannot cache it, it may not be a real phase output.

---

## 3. Phase Design: Scope, Convergence Condition, and What Passes Forward

Every phase should be designed with three explicit properties:

### Scope

The phase's scope defines what it is allowed to do and what it must not do. Write it as
a constraint, not a goal:

- Goal (weak): "find all security issues in the codebase"
- Scope (strong): "read each file in `files[]`, emit a list of findings with
  `{file, line, severity, description}`; do not attempt fixes; do not read files outside
  `files[]`; stop if `files[]` is empty"

Scope answers: what inputs does this phase consume? What outputs does it produce? What
side effects (if any) are allowed? What is explicitly out of bounds?

An under-scoped phase produces agents that do "a little bit of the next phase's work"
and then inconsistently. Over-scoped phases produce agents that stall because they were
asked to do too much in one pass.

### Convergence Condition

The convergence condition is the predicate that must be true for the phase to be
considered done. It is not "the agent finished" — it is a property of the output.

Examples:
- "All files in `files[]` have been reviewed and each has a `findings[]` entry (possibly
  empty)"
- "The diff applies cleanly and all changed tests pass"
- "The verification agent returned `{confirmed: true}` for every finding in the prior
  phase's output"

A phase without a convergence condition cannot be retried correctly and cannot be
validated by a downstream gate.

### What Passes Forward (the Handoff Artifact)

The handoff is the only information that survives the phase boundary. Everything else
in the agent's context is discarded.

Design the handoff artifact to be:
- **Self-contained**: the next phase should not need to re-read inputs the prior phase
  read. If it does, those inputs belong in the handoff or should be re-fetched
  explicitly.
- **Typed**: define the schema before writing the phase prompt. An untyped handoff
  ("the agent will describe what it found") is a reliability failure waiting to happen.
- **Minimal but sufficient**: include what the next phase needs, nothing more. Bloated
  handoffs inflate context and bury the signal.

**Failure mode: implicit handoff.** "The agent will put its results in the response and
the next phase will parse them." This works until the response format drifts or the
agent adds prose context that confuses the parser. Always use a structured schema
(`schema: FINDINGS_SCHEMA`) for phase handoffs.

---

## 4. Common Phase Patterns

### Scout-Then-Fan-Out

```
Phase 1 (Scout): read a bounded set of entry points; emit a manifest of N items
Phase 2 (Workers): N parallel agents, one per manifest item; each works independently
Phase 3 (Synthesize): aggregate worker outputs; emit consolidated result
```

When to use: the work-list is not known statically. The scout discovers the scope before
any expensive work begins. Fan-out size is determined by the scout's output, not by the
prompt author.

Key design constraint: the scout must produce a *typed manifest* (`{items: Item[]}`).
If it produces prose, the fan-out stage cannot be written deterministically.

### Find-Verify-Fix

```
Phase 1 (Find): broad sweep; high recall, low precision acceptable; emit candidate list
Phase 2 (Verify): each candidate independently verified; adversarial stance; filter to confirmed
Phase 3 (Fix): one agent per confirmed finding; produce a patch per finding
Phase 4 (Apply): apply patches in order; run tests; report pass/fail
```

When to use: correctness matters more than speed. Verification is the most important
phase here — false positives from phase 1 that flow into phase 3 produce wrong patches
with no further check.

Note: phases 3 and 4 can be merged if N is small. Split them when N is large enough that
applying + testing together in one agent produces an unwieldy context.

### Read-Design-Implement-Review

```
Phase 1 (Read): understand current state; emit summary of relevant components
Phase 2 (Design): consume summary; emit a design doc / plan; no code written
Phase 3 (Implement): consume design; write code; emit diff
Phase 4 (Review): consume diff; emit verdict {approved: bool, issues: string[]}
```

When to use: the implementation risk is high enough to warrant an explicit design gate.
The review phase is adversarial — it is a different agent from the implementer, with a
skeptical posture.

**Failure mode: the implementer "also reviews" in phase 4.** An agent reviewing its own
output has a strong prior toward approval. Phase 4 must be a fresh agent.

### Loop-Until-Dry

```
Phase 1 (Find): run N finders in parallel; collect findings; dedup against seen-set
Phase 2 (Verify): verify each fresh finding
--- repeat until K consecutive rounds return 0 new findings ---
```

When to use: the search space is unknown and unbounded. Examples: "find all places this
pattern appears", "find all security issues." A fixed N-agent sweep with no loop misses
the tail.

Key discipline: dedup against a cumulative `seen` set, not just the current round's
output. Otherwise rejected findings re-appear in every round and the loop never
converges.

Convergence signal: K consecutive rounds with zero net-new findings after dedup (K=2 is
usually enough; K=3 for high-stakes). Not "the agents said they're done."

---

## 5. Information Flow Between Phases: Handoff Specs and Context Bloat

**The handoff spec is the interface between phases.** Write it before writing the
phase prompts — the two phases are coupled only through the handoff schema.

### Avoiding Context Bloat

Context bloat happens when a phase passes forward everything it saw (full file contents,
all intermediate reasoning, raw tool output) instead of a distilled artifact. Signs:
- Phase N+1 agents are told to "read the previous agent's output" and then given a 10k
  token dump
- Findings repeat the original source text verbatim instead of a structured reference
- Every downstream agent re-reads the same large files from scratch

Mitigations:
- The handoff artifact should reference source locations (`{file, line}`) rather than
  reproduce content. The downstream agent re-fetches only what it needs.
- If the handoff must include content (e.g., a file diff), keep it to the changed
  sections, not the full file.
- Synthesis agents should consume a *summary* handoff from each upstream agent, not
  concatenated raw outputs.

### What Belongs in the Handoff vs. What Should Be Re-Fetched

Belongs in the handoff:
- Findings, decisions, verdicts — the structured output of the phase
- Identifiers needed to resume work (`file`, `symbol`, `id`)
- Metadata required for the next phase to operate (`severity`, `scope`, `type`)

Should be re-fetched by the next phase:
- Full file contents — they may have changed, and including them inflates the handoff
- External API responses — same reasoning
- The original task description — put it in the system prompt, not the handoff

### Multi-Phase Context Economy

Design a mental budget for each phase:
- System prompt (constant across instances of this phase): ~2-4k tokens
- Handoff from prior phase: ~1-5k tokens
- Tools / schema: ~1-2k tokens
- Working context (files read, reasoning): ~20-50k tokens

If the working context budget is routinely exhausted before the phase can complete, the
phase scope is too broad. Split it.

---

## 6. Writing Phase Gates in a Skill Spec

A **phase gate** is an explicit precondition: what must be true before phase N+1 is
allowed to start. Gates prevent garbage-in-garbage-out propagation.

### Structural gate (check before spawning)

```
# Gate: Phase 1 -> Phase 2
- findings[] must be non-empty; if empty, short-circuit to "no issues found" and skip
  phases 2-4
- each finding must have {file, line, severity, description}; any finding missing a
  field is an error, not a warning
```

In code:
```javascript
const findings = await agent(phase1Prompt, {schema: FINDINGS_SCHEMA})
if (!findings.items.length) return {result: 'clean', findings: []}
```

### Verification gate (run a check agent)

```
# Gate: Phase 3 -> Phase 4
- spawn a gate-check agent with the diff output
- gate agent checks: does diff apply cleanly? do tests pass in a dry run?
- only proceed to phase 4 if gate returns {pass: true}
```

### Quality gate (adversarial verifier)

```
# Gate: Phase 2 -> Phase 3
- for each finding in phase 2 output, a verifier agent assesses: is this real?
- only findings where verifier returns {real: true} proceed to phase 3
- this is the same as the find-verify-fix pattern's verify phase
```

### Writing gates in a skill spec

The spec should name each gate explicitly and state:
1. What artifact it checks
2. The predicate that must be true
3. What happens on failure (abort, retry, short-circuit, escalate)

```markdown
## Phase gates

Gate A (after Find, before Verify):
  - Input: findings[] from Find phase
  - Predicate: findings[].length > 0
  - On failure: short-circuit, return {status: "no findings", result: []}

Gate B (after Verify, before Fix):
  - Input: verified_findings[] from Verify phase
  - Predicate: each item has {confirmed: true, file, line, description}
  - On failure: log warning, skip item, continue with remaining confirmed findings
```

---

## 7. When to Stop Adding Phases (Diminishing Returns Signal)

Each phase adds latency, a handoff artifact, and a context boundary where information
is lost. The marginal benefit must justify this cost.

**Signals that a phase is not earning its keep:**

1. **The gate is always passing.** If gate A has never fired in N runs, the phase it
   guards is either never producing bad output (good — the gate is overhead) or the gate
   predicate is wrong (bad — fix the predicate). Either way, investigate.

2. **The phase output is a simple transform of its input.** If phase N+1 does nothing
   except reformat or filter the phase N output, fold that transform into phase N as a
   step. A reformatting phase is usually a symptom of a poorly designed handoff schema.

3. **Agents in this phase fail at the same rate regardless of input quality from prior
   phases.** The phase boundary is not providing isolation — something structural is
   wrong. The phase is doing too much or the wrong thing.

4. **The human reviewer never looks at intermediate outputs.** Phases correspond to
   natural human review points. A phase that no human would ever pause at is probably a
   step.

5. **Total latency is dominated by phase overhead, not by work.** If the actual work of
   a phase takes 10 seconds but the orchestration overhead (spawning, handoff
   serialization, context loading) takes 8 seconds, the granularity is too fine.

**The right number of phases is the smallest number that makes the skill correct and
reviewable.** Start with 2-3. Add a phase only when you can name the exact failure mode
it prevents.

---

## 8. Prompt Construction Patterns for Phased Work

### Pattern: Explicit role declaration at the top

Each agent prompt opens with what role it is in the pipeline and what it is not:

```
You are the VERIFY agent in a find-verify-fix pipeline.
Your job: assess whether each finding in the input is a real issue.
Your job is NOT: to fix anything, to find new issues not in the input, to re-read
files beyond those referenced by each finding.
```

This constrains scope drift — without it, agents in verify phases often start "also
finding" or "also fixing."

### Pattern: Input schema declaration before instructions

```
Input you will receive:
  findings: Array<{file: string, line: number, severity: "high"|"medium"|"low",
                   description: string}>

For each finding, read the file at the given line and assess: is this a real issue?
```

Declaring the input schema before giving instructions anchors the agent to the handoff
format. An agent that doesn't know the shape of its input guesses — and guesses wrong
in edge cases.

### Pattern: Explicit convergence condition in the prompt

```
When you are done, your output must cover every item in findings[]. Do not stop early.
If findings[] is empty, return {verified: []}.
```

This prevents truncation: agents under context pressure often stop processing the list
early and emit a partial result. An explicit completeness requirement surfaces the failure
as a structural error rather than a silent omission.

### Pattern: Failure mode instructions

```
If you cannot read a file (not found, permission error), include the finding in output
with {real: false, reason: "file not readable: <path>"}. Do not abort.
```

Agents without failure mode instructions either abort on the first error or silently skip
errored items. Both are worse than a structured error record.

### Pattern: Forward-only instruction (prevent backsliding)

```
Do not revisit findings you have already classified. Process findings in order and emit
each classification immediately. If you realize you want to change an earlier
classification, add a {revision: true} record at the end — do not re-emit the original.
```

This matters in long-running phases where an agent's context grows large enough that it
starts second-guessing earlier output. A forward-only constraint keeps output stable.

### Pattern: Explicit handoff format as the final instruction

```
Produce your output as a single JSON object matching this schema:
{
  "verified": Array<{
    "original": <finding from input>,
    "real": boolean,
    "confidence": "high" | "medium" | "low",
    "reason": string
  }>
}
No prose. No commentary. The JSON object only.
```

Placing the output format as the final instruction (not the first) reduces the chance the
agent "forgets" it while processing a long list. The format is the last thing it read
before starting to emit.

---

## Failure Modes Summary

| Failure mode | Diagnosis | Fix |
|---|---|---|
| Phase without convergence condition | Retry logic doesn't know when to stop | Add explicit convergence predicate to the phase spec |
| Implicit handoff (prose only) | Downstream agent misparses or ignores structure | Define and enforce a typed schema for every handoff |
| Phase scope drift (agent does next phase's work) | Missing role declaration | Add explicit "your job is NOT" clause to the prompt |
| Context bloat via full-content handoff | Downstream context consumed by raw source | Pass references, not content; re-fetch at point of use |
| Gate never fires | Either gate is correct overhead or predicate is wrong | Log gate outcomes; remove if always-passing and safe to do so |
| Too many phases (orchestration overhead dominates) | Latency breakdown shows overhead > work | Merge phases that share the same agent type and output schema |
| Loop convergence on confirmed-only set | Rejected items re-appear each round | Dedup against cumulative seen set, not per-round output |
| Verifier uses same context as producer | Verify phase approves its own priors | Always spawn a fresh agent for verification; never reuse the producer's session |
| Partial output on large lists | Agent stops early under context pressure | Add completeness requirement to prompt; validate output length against input length |
| Phase boundary with no state change | Boundary is a step, not a phase | Fold into the upstream agent as a sequential step |
