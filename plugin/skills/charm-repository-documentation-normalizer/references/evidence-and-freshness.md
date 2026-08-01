# Evidence, freshness, and CI

## Freshness model

A calendar date alone cannot show that documentation matches code. Store `last_verified_commit`, source paths, and update triggers with each document. A source change is a signal to review, not proof that prose must change.

Use one outcome for every triggered document:

| Outcome | Meaning |
| --- | --- |
| `updated` | The documented behavior or structure changed and the document was revised. |
| `reviewed-no-change` | Evidence was checked and the claim remains accurate. Record the review in the PR or repository mechanism. |
| `possibly-stale` | Relevant source changed but the claim was not confirmed. |
| `unknown-impact` | The path changed but its relationship to the document is not understood. |

## CI posture

Start with warnings for semantic impact and errors for objective failures. Escalate a document or contract to required review only after its owners accept the trigger set. Enable strict enforcement with `--enforce-freshness`; use `--reviewed-no-change <document-id>` only after checking the cited evidence.

Always check:

- unique IDs and valid manifest paths;
- broken links or nonexistent source references;
- required canonical policy and root manifest;
- valid generated adapters, if adapters are enabled;
- a bounded size policy for always-loaded routers;
- changed trigger paths and recorded review outcome.

Optionally check Mermaid syntax, command execution in a safe environment, CODEOWNERS coverage, and generated documentation publication. Do not let a validator rewrite semantic documentation: it cannot verify the meaning of an architecture claim.

## Evidence ledger example

```markdown
| Claim | Confidence | Evidence | Follow-up |
| --- | --- | --- | --- |
| API checks organization membership before a write. | Verified | `services/api/src/routes/orders.ts`; integration test | Recheck on auth middleware changes. |
| Worker consumes `order.created` in production. | Unknown | Handler exists, no deployment evidence found. | Confirm with operations owner. |
```

Make a conflict explicit when current code and a decision record disagree. The agent should report the conflict, avoid broad repair without authority, and update the status to `possibly-stale` or `incomplete` until resolved.
