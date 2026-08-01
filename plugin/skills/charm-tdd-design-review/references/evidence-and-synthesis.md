# Evidence rules and synthesis

The controls that keep a design review from generating confident fiction. These
apply identically on every platform and in every tier.

## Labels

Every material finding, and every claim inside one, carries exactly one label.

| Label | Means | Requires |
| --- | --- | --- |
| `EVIDENCE` | Stated in a source I can point at | An exact citation |
| `INFERENCE` | Follows from cited evidence | The premises, each cited, and the step between them |
| `ASSUMPTION` | I am treating this as true without a source | An explicit statement of what would confirm or refute it |
| `QUESTION` | I need an answer to review this | Who can answer, and what changes depending on the answer |
| `RECOMMENDATION` | What I would do | The finding it addresses, and its cost |

Unlabelled prose in a review is dropped by the synthesiser.

## Citation rules

A **citation** is one of: an exact TDD section (`§4.2 "Write path"`), a supplied
repository path with line (`apps/api/adapters/sql/provider.py:214`), a ticket
ID, a published contract or schema, or a linked document. "The codebase",
"standard practice", and "typically" are not citations.

- **A blocker requires `EVIDENCE`**, or an `INFERENCE` whose every premise is
  cited `EVIDENCE`. Anything weaker is a risk or a question, never a blocker.
- **Never assert existence without a citation.** A reviewer may say "the design
  assumes a rate limiter on this path; I have no evidence one exists — this is
  the risk if it does not" (`ASSUMPTION` + `QUESTION`). It may not say "the
  existing rate limiter will not cover this."
- **Absence of evidence is reportable, non-existence is not.** "The TDD does not
  describe what happens when the queue backs up" is `EVIDENCE` about the
  document. "There is no backpressure" is a claim about the system and needs a
  source.
- **Quote, don't paraphrase, on anything load-bearing.** If a blocker turns on
  the exact wording of a section, include the words.

## Repetition is not confirmation

Two agents asserting the same uncited claim produces **one** `ASSUMPTION`, not
an upgrade to fact. The synthesiser tracks provenance, not vote count:

- Same claim, both `EVIDENCE`, same citation → merge, keep one.
- Same claim, both `EVIDENCE`, different citations → merge, keep both citations;
  this is genuine corroboration.
- Same claim, `EVIDENCE` + `ASSUMPTION` → keep the `EVIDENCE`, drop the weaker
  duplicate.
- Same claim, both `ASSUMPTION` → **one** `ASSUMPTION`, flagged as convergent
  and unverified. Convergence between agents sharing an input packet is expected
  and carries no information.

## Findings block

Every reviewer returns exactly this. No preamble, no summary paragraph.

```markdown
## Role: <role name>

## Findings
### F1 — <one-line claim>
- **Label:** EVIDENCE | INFERENCE | ASSUMPTION | QUESTION | RECOMMENDATION
- **Severity:** blocker | risk | note
- **Cite:** <TDD §, path:line, ticket, contract, or "none — see label">
- **Impact:** <what concretely breaks, and for whom>
- **Resolve by:** <what evidence or decision would close this>

## Open questions for the author
<max 3, each with what it changes>

## Checked and fine
<surfaces inside my mandate that I examined and found sound — one line each>

## Confidence
<high | medium | low> — <what would raise it>
```

"Checked and fine" matters: it separates *not a problem* from *not looked at*,
and it is what lets the synthesiser report unreviewed surfaces honestly.

## Synthesis

Runs in the main thread. No extra agent.

1. **Normalise** — restate each finding as a claim about the design, stripped of
   phrasing. Two findings match when the claim matches, not the wording.
2. **Merge by provenance** using the repetition table above.
3. **Demote** — any blocker lacking a qualifying citation becomes a risk;
   any risk resting only on an `ASSUMPTION` becomes a question.
4. **Preserve dissent** — where reviewers disagree, record both positions, who
   held each, and **what evidence would resolve it**. Never average them, never
   pick the more confident one, never quietly drop the minority view.
5. **Attribute owners** — each blocker and risk names who decides, from the
   intent brief. `unassigned` is an acceptable and useful answer.
6. **Report coverage gaps** — triggered specialists that were not run under the
   tier cap, `UNKNOWN` signals, and surfaces no reviewer listed as checked.

### Verdicts

Exactly one of:

| Verdict | Means |
| --- | --- |
| `ready` | No blockers. Risks are named and accepted. The behaviour contract and validation plan are defined. |
| `ready with conditions` | No blockers **after** a bounded, enumerated set of conditions is met. Each condition is specific, checkable, and owned. |
| `needs design work` | At least one blocker, or a core decision cannot be reviewed on the evidence available. |

A design with an unresolved blocking ambiguity is `needs design work`, not
`ready with conditions` — "answer this question" is not a condition, it is
missing input.

## Asking instead of guessing

When uncertainty blocks confidence, stop and ask the user. Cheaper than another
agent and strictly more accurate. Good questions are:

- **Focused** — one decision each, answerable in a sentence.
- **Consequential** — state what changes depending on the answer.
- **Bounded** — at most five at a time.
- **Not lookups** — if the answer is in supplied material, go read it.
