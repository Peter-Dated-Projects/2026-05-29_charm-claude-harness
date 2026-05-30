---
id: problem-decomposition
root: conventions
type: convention
status: current
summary: "How to write prompts that decompose complex problems into orthogonal, well-scoped sub-tasks for parallel worker dispatch."
related:
  - architecture/spawn-model
created: 2026-05-30
updated: 2026-05-30
---

# Problem Decomposition in Orchestration Skill Design

This note captures principles, failure modes, and concrete prompt patterns for decomposing
a complex task into sub-tasks that can be dispatched to independent worker agents. These
apply to any skill whose orchestrator must fan out work rather than do it inline.

---

## 1. What makes a good decomposition?

A decomposition is good when every atom satisfies four properties:

**Orthogonal** -- atoms do not overlap. Two workers can run simultaneously without touching
the same file, concept, or system state. When you can't guarantee this, the dep-solver must
serialize them, eliminating the parallelism the decomposition was supposed to enable.

**Atom-sized** -- each sub-task is independently completable in one agent context window.
If finishing atom A requires knowing the output of atom B, they are not really separate atoms;
merge them or reorder them. A good atom has a single clear artifact as output.

**Explicitly scoped** -- the atom names the exact files, endpoints, schema fields, or concerns
it touches. Vague scope ("update the auth layer") is not a scope; it's a theme. A scope is a
list: "modify `src/auth/session.ts`, `src/auth/types.ts`".

**Independently verifiable** -- you can test whether atom A succeeded without first running
atom B. If verification requires a running integration of A+B+C, the atoms were not really
independent.

---

## 2. The scout-agent pattern

Never let the decomposing agent also execute. Separate the roles:

- **Scout agent**: receives the full brief; produces *only* a manifest of sub-tasks. It does
  not write code, call APIs, or take side-effects.
- **Worker agents**: each receives one atom from the manifest; does not see the full brief.

Why this matters: a single agent trying to decompose *and* execute will collapse atoms
prematurely, start executing before the decomposition is complete, and lose global view of
scope conflicts it would have caught if it had been forced to enumerate everything first.

The scout's prompt should end with a hard constraint: "Do not implement anything. Your only
output is the structured task manifest."

---

## 3. Schema-driven decomposition

Force the scout to emit a typed manifest, not prose. When the decomposition is a typed
object the orchestrator can validate, you catch scope ambiguities at manifest time rather
than at worker runtime.

Minimal useful schema (adapt as needed):

```json
{
  "tasks": [
    {
      "id": "T-NNN",
      "title": "...",
      "touches": ["path/to/file.ts", "path/to/other.ts"],
      "depends_on": ["T-MMM"],
      "acceptance": "One sentence: what does done look like?"
    }
  ]
}
```

Key fields:
- `touches` -- enforced by the daemon as the hard scope layer. Workers that violate it are
  blocked.
- `depends_on` -- used by the dep-solver to sequence atoms that cannot run in parallel.
- `acceptance` -- forces the scout to articulate a verifiable outcome for each atom.

If the scout cannot fill in `touches` for an atom, that atom is not yet well-defined.
Reject the manifest and ask the scout to refine.

---

## 4. Dimensions of decomposition

Choose the dimension that minimizes cross-atom dependencies. Common choices:

**By data partition** -- atom A handles records 1-1000, atom B handles 1001-2000. Natural
for batch jobs; scope conflicts are impossible by construction. Useless when sub-tasks must
share schema.

**By concern / dimension** -- one atom per quality dimension (security, performance,
correctness, accessibility). Each reviewer is blind to what others found; useful for
adversarial review where you want independent perspectives. Works poorly when fixing a
security issue requires changing the same line as fixing a perf issue.

**By phase** -- atom A produces an artifact, atom B consumes it. Strictly sequential but
useful when a later phase cannot start without the output of an earlier one (e.g. generate
schema -> implement against schema). Keep the phase boundary explicit in the manifest.

**By stakeholder / lens** -- one atom per perspective (backend, frontend, data, ops). Used
in design-review workflows. Risk: atoms tend to have hidden cross-cutting dependencies that
only become visible during execution.

Pick the dimension before writing the scout prompt -- the prompt should name it explicitly so
the scout decomposes along that dimension consistently.

---

## 5. Anti-patterns

**Under-specified decomposition** -- atoms without explicit `touches`, without acceptance
criteria, or with titles that are themes rather than tasks ("improve error handling"). A worker
receiving this atom cannot know when it is done or whether it is in scope.

**Overlapping atoms** -- two atoms that touch the same file. They cannot run in parallel.
If the dep-solver must serialize everything, the fan-out bought nothing. Catch this at
manifest validation, not at runtime.

**Hidden dependencies** -- atom B depends on a type or export produced by atom A, but
`depends_on` is empty. The worker for B will fail or produce incorrect code. The scout must
derive dependencies from the `touches` lists, not from intuition.

**Fake decomposition** -- the scout produces N atoms that all touch "the whole feature" with
vague scope lists. This is the original task relabeled N times. Reject manifests where the
union of all `touches` lists contains duplicates across atoms.

**God-scope atoms** -- one atom with a `touches` list of 40 files. An agent cannot reliably
implement a 40-file change in one context window. The scout should be prompted to prefer
small atoms: "if an atom touches more than 5 files, split it."

**Decomposition drift** -- the scout is allowed to revise the manifest mid-execution. Lock
the manifest before spawning workers. Any scope change after workers start requires stopping
affected workers, revising, and respawning.

---

## 6. Self-decomposing prompts

A skill spec can be written so the orchestrator *discovers* the work list dynamically rather
than receiving it pre-computed. This is useful when the input space is unknown at prompt-write
time (e.g., "review every changed file in this PR").

Pattern:

```
Step 1 (scout): List all files changed in this PR. For each file, produce one review atom
with fields: {file, concerns: string[], touches: [file]}. Output only the manifest -- no
review yet.

Step 2 (validate): Check that no file appears in more than one atom's touches. If duplicates
exist, merge the conflicting atoms.

Step 3 (fan-out): Dispatch one worker per atom from the validated manifest.
```

The skill spec encodes the *shape* of the decomposition (one atom per file, concern-dimension
review) without knowing the specific files in advance. The scout fills in the content.

Self-decomposing prompts are powerful but fragile if validation is omitted. Always include a
manifest validation step between discovery and fan-out.

---

## 7. Prompt language patterns that produce good decompositions

Phrases that constrain the scout effectively:

- "Do not implement. Output only a JSON manifest matching this schema: ..."
- "Each task must name exactly which files it touches. If you cannot name the files, do not
  create the task -- split or reframe until you can."
- "No task may appear in more than one task's `touches`. If two tasks need the same file,
  add a `depends_on` edge instead."
- "Prefer tasks that touch 3 files or fewer. If a task would touch more, split it."
- "Each task must have a one-sentence acceptance criterion that can be verified without
  running other tasks."
- "After generating the manifest, check for cycles in `depends_on`. If any exist, restructure
  the affected atoms to remove the cycle."

Phrases that tend to produce bad decompositions:

- "Break this into logical pieces" -- "logical" is undefined; the scout will use its own
  heuristics, which vary by run.
- "Make sure the tasks cover everything" -- this encourages overlap rather than MECE coverage.
- "Use your judgment about scope" -- scope must be explicit, not inferred.

---

## 8. Validating a decomposition before dispatching workers

Run these checks on the manifest before spawning a single worker:

1. **Uniqueness of touches** -- build the union of all `touches` lists. Any file appearing
   in more than one atom's list is a scope conflict. Fail the manifest; ask the scout to
   resolve.
2. **Dependency acyclicity** -- topological sort the `depends_on` graph. A cycle means the
   decomposition is logically impossible; fail it.
3. **Acceptance coverage** -- every atom has a non-empty `acceptance` field. An atom without
   an acceptance criterion cannot be reviewed.
4. **Atom size** -- flag atoms with more than N files in `touches` (N is project-defined;
   5 is a reasonable default). These are candidates for splitting.
5. **Reachability** -- every atom is either independent (no `depends_on`) or has all its
   dependencies present in the manifest. An atom depending on a task ID that doesn't exist
   is a dangling reference.

These checks are mechanical and should be done in code (the dep-solver), not by the
orchestrating agent. Trust the schema validator, not the model's self-check.
