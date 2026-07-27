# Models

Each agent charm spawns runs on a model chosen by its **type** — the kind of work it does.
There is no fleet-wide "mode" to pick; the per-type defaults below apply out of the box, and
you only reach for an override when you want something other than the default.

Charm hosts agents on three runtimes behind a hexagonal port (`src/runtime/`):

- **Claude Code** (`claude`) — default for most roles; required for the main orchestrator
- **Codex CLI** (`codex`) — selected for suborchestrators with `:so g` (terra); also available when a spawn picks `sol` / `terra` / `luna`
- **Cursor CLI** (`cursor`) — the operator-only Cursor specialist pane (`:cursor` / `:so u`). Launched bare (workspace trust only) with Cursor's own default model. It is **not** wired to Charm MCP, prompts, tickets, or coordination — it is a grid pane for the human, not a fleet subagent, and is not spawnable through the Charm MCP tools.

## Per-type model defaults

| Agent | Spawned by | Model | Runtime | Context |
|---|---|---|---|---|
| Orchestrator (main) | `charm start` | `sonnet-5` | Claude | **1M** |
| Suborchestrator | `:so` / `:so c` | `sonnet-5` | Claude | **1M** |
| Suborchestrator | `:so g` | `terra` (GPT-5.6) | Codex | — |
| Cursor specialist | `:cursor` / `:so u` | Cursor default | Cursor | — |
| Investigator | `spawn_investigators` | `opus-5` | Claude | 200K |
| Worker (coding) | `spawn_workers` | `opus-5` | Claude | **1M** |
| Tester (review) | `request_review` | `sonnet-5` | Claude | 200K |
| Researcher | `spawn_researchers` | `sonnet-5` | Claude | **1M** |

The reasoning-heavy sub-agent roles (investigation, coding) run on Opus; the higher-volume,
tighter-scope roles (review, broad research) run on Sonnet. The orchestrator itself runs on
Sonnet 5 with the 1M-token window — a long-lived coordinator session, not a one-shot deep-reasoning
pass. Coding, research, and the orchestrator get the 1M-token context window because their inputs
(a large diff to write, a wide surface to survey, an entire session's history) are the ones most
likely to need the headroom.

## Overriding the model

### Per spawn (orchestrator)

The orchestrator can override the model for a single `spawn_*` / `request_review` call — no env
vars, no restart — by passing two optional params:

- `model`: the family —
  - Claude: `sonnet` (Sonnet 5), `haiku` (Haiku 4.5), `opus` (Opus 5)
  - Codex: `sol`, `terra`, `luna` (all GPT-5.6)
  Omit it to keep the role's default (Claude).
- `context_1m`: use the 1M-token window (default `true`, the preferred window). Only applies when
  `model` is a Claude family that offers one — ignored for Haiku and all Codex families.

Picking `sol` / `terra` / `luna` routes that agent through the Codex adapter (same Charm MCP
tools, unattended permissions, instruction injection, native subagent tools disabled). The
main orchestrator always stays on Claude. `:so` defaults to Claude Sonnet; `:so g`
selects Codex Terra.

### Fleet / role (operator)

Two operator-level overrides, highest precedence first:

1. **Per-role**, via the `CHARM_MODEL_<ROLE>` env var — overrides one role's model:

   ```sh
   CHARM_MODEL_WORKER=sol charm start --project   # workers on GPT-5.6 Sol (Codex)
   ```

2. **Whole fleet**, via `-m, --model <model>` on `charm start` — replaces the per-type defaults
   for spawnable agents. For `:so`, the command's runtime selection wins, but a same-runtime
   override still changes its model. Main always resolves to a Claude model:

   ```sh
   charm start -m opus-5 --project   # Claude fleet on Opus 5
   charm start -m sol --project        # Codex Sol for :so g + sub-agents; bare :so stays Claude
   ```

Accepted `<model>` values:

```
sonnet-5   sonnet-5-1m
haiku-4.5
opus-4.7   opus-4.7-1m
opus-4.8   opus-4.8-1m
opus-5     opus-5-1m
fable-5
sol        terra        luna          # Codex GPT-5.6 (aliases: sol-5.6, terra-5.6, luna-5.6)
```

You can also pass a raw `claude-*` or `gpt-5.6-*` model id. The `haiku-4.5` alias is handy for
low-cost Claude runs — the [preflight sweep](../developing/preflight.md) uses it to smoke-test
the harness cheaply. The `-1m` variants select the 1M-token context window for Claude families
that offer one.

## Runtime notes

- Non-orchestrator agents do not keep chat history (Claude: `CLAUDE_CODE_SKIP_PROMPT_HISTORY`;
  Codex: isolated per-agent `CODEX_HOME` under the session run dir).
- Claude's built-in Workflow tool stays enabled by default (`CHARM_WORKFLOW_ENABLE=0` opts out).
  Codex native multi-agent / `spawn_agent` tools are disabled so Charm MCP owns fan-out.
- Claude panes report their live model via a per-agent `statusLine` hook (`charm report-model`),
  so mid-session `/model` switches update the tmux pane border and the Agents console within a
  couple of seconds. Codex/Cursor panes keep the model stamped at spawn.
- See `src/runtime/` for the port (`AgentRuntime`) and the Claude / Codex / Cursor adapters.
