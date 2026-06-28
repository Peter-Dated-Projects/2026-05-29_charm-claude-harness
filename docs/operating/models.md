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
| Tester (review) | `request_review` | `sonnet-4.6` | 200K |
| Researcher | `spawn_researchers` | `sonnet-4.6` | **1M** |

The reasoning-heavy roles (orchestration, investigation, coding) run on Opus; the higher-volume,
tighter-scope roles (review, broad research) run on Sonnet. Coding and research get the 1M-token
context window because their inputs (a large diff to write, a wide surface to survey) are the
ones most likely to need the headroom.

## Overriding the model

Two overrides, highest precedence first:

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
sonnet-4.6   sonnet-4.6-1m
opus-4.6
opus-4.7     opus-4.7-1m
opus-4.8     opus-4.8-1m
```

You can also pass a raw `claude-*` model id (e.g. `claude-haiku-4-5-20251001`) — useful for
low-cost runs: the [preflight sweep](../developing/preflight.md) uses `haiku-4.5` to smoke-test
the harness cheaply. The `-1m` variants select the 1M-token context window for that model.
