# Models

Each agent charm spawns runs on a model chosen by its **type** — the kind of work it does.
There is no fleet-wide "mode" to pick; the per-type defaults below apply out of the box, and
you only reach for an override when you want something other than the default.

## Per-type model defaults

| Agent | Spawned by | Model | Context |
|---|---|---|---|
| Orchestrator (main) | `charm start` | `opus-4.8` | 200K |
| Suborchestrator | `:so` | `opus-4.8` | 200K |
| Investigator | `spawn_investigators` | `opus-4.8` | 200K |
| Worker (coding) | `spawn_workers` | `opus-4.8` | **1M** |
| Tester (review) | `request_review` | `sonnet-5` | 200K |
| Researcher | `spawn_researchers` | `sonnet-5` | **1M** |

The reasoning-heavy roles (orchestration, investigation, coding) run on Opus; the higher-volume,
tighter-scope roles (review, broad research) run on Sonnet. Coding and research get the 1M-token
context window because their inputs (a large diff to write, a wide surface to survey) are the
ones most likely to need the headroom.

## Overriding the model

### Per spawn (orchestrator)

The orchestrator can override the model for a single `spawn_*` call — no env vars, no restart —
by passing two optional params on `spawn_workers`, `spawn_investigators`, or `spawn_researchers`:

- `model`: the family — `sonnet` (Sonnet 5), `haiku` (Haiku 4.5), or `opus` (Opus 4.8). Omit it to
  keep the role's default.
- `context_1m`: use the 1M-token window (default `true`, the preferred window). Only applies when
  `model` is set, and is ignored for families with no 1M variant (Haiku), which always resolve to
  their base id rather than a bogus `...[1m]`.

This applies to that one batch only; it does not change the role defaults or the fleet override.

### Fleet / role (operator)

Two operator-level overrides, highest precedence first:

1. **Per-role**, via the `CHARM_MODEL_<ROLE>` env var — overrides one role's model:

   ```sh
   CHARM_MODEL_WORKER=opus-4.7 charm start "your goal"   # workers on Opus 4.7, everything else default
   ```

2. **Whole fleet**, via `-m, --model <model>` on `charm start` — replaces the per-type defaults
   for the orchestrator *and* every sub-agent:

   ```sh
   charm start -m opus-4.8 "your goal"   # every agent on Opus 4.8
   ```

Accepted `<model>` values:

```
sonnet-5   sonnet-5-1m
haiku-4.5
opus-4.7   opus-4.7-1m
opus-4.8   opus-4.8-1m
fable-5
```

You can also pass a raw `claude-*` model id (e.g. `claude-haiku-4-5-20251001`). The `haiku-4.5`
alias is handy for low-cost runs — the [preflight sweep](../developing/preflight.md) uses it to
smoke-test the harness cheaply. The `-1m` variants select the 1M-token context window for that
model; only families that offer one (Sonnet, Opus) have a `-1m` variant.
