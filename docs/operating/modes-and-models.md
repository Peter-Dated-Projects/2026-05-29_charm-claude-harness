# Modes and models

Charm runs the entire fleet — the main orchestrator and every sub-agent it spawns — on one
model at a time. You pick that model either indirectly (a mode, which sets a sensible
default) or directly (a model pin, which overrides the mode).

## Modes

A mode is a default posture for the fleet, chosen at `start`:

| Mode | Flag | Fleet default |
|---|---|---|
| Research | `--research` | Sonnet |
| Development | `--development` (alias `--dev`) | Opus |

Research mode biases toward cheaper, faster Sonnet — good for exploration, summarization, and
work where breadth matters more than depth. Development mode defaults to Opus for heavier
implementation work. If you pass neither, `start` prompts you to pick.

## Pinning a model

`-m, --model <model>` pins the whole fleet to a specific model, honored in **any** mode and
overriding the mode default. Accepted values:

```
sonnet-4.6   sonnet-4.6-1m
opus-4.6
opus-4.7     opus-4.7-1m
opus-4.8     opus-4.8-1m
```

You can also pass a raw `claude-*` model id. The `-1m` variants select the 1M-token context
window for that model.

```sh
charm start -m opus-4.8 "your goal"        # pin the fleet to Opus 4.8, any mode
charm start --research -m opus-4.7 "..."   # research mode, but force Opus 4.7
```

The pin applies to the orchestrator and every sub-agent equally — there is no per-agent model
selection.

**Accepted raw model IDs.** In addition to the short aliases listed above, `-m` accepts any
raw `claude-*` model identifier (e.g. `claude-haiku-4-5-20251001`). This is useful for
low-cost runs: the [preflight sweep](../developing/preflight.md) uses `haiku-4.5` to smoke-test
the harness cheaply.

## Per-role model defaults

When no `-m` pin is given, model defaults differ by role:

| Role | Development mode | Research mode |
|---|---|---|
| Orchestrator (main agent) | `opus-4.8` | `sonnet-4.6` |
| Sub-agents (investigator, worker, tester) | `sonnet-4.6` | `sonnet-4.6` |

The orchestrator always stays on the heavier model in development mode — it holds the full
session plan and coordinates all sub-agent spawns, so the extra capability is consistently
worthwhile. Sub-agents default to Sonnet regardless of mode because their scopes are tighter.
The `:dev` / `:research` swap commands and any `-m` pin override all of the above for new
spawns.

## Swapping mid-session

Inside a running session, the `:` command prompt swaps the fleet's model without restarting:

- `:dev` — switch the fleet to the development-mode model.
- `:research` — switch the fleet to the research-mode model.

This re-points new agents at the chosen model; use it when a research-mode run hits work that
deserves Opus, or vice versa. The full keymap is in [Console keybindings](keybindings.md).
