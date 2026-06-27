import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CharmPaths } from "../paths.ts";
import type { AgentRole } from "../schema.ts";

/** The orchestrator always runs under this fixed agent id. It is spawned directly by
 *  `charm start` (not through the registry's auto-incrementing sub-agent sequence), so
 *  no investigator/worker/tester can ever collide with it. The kill path treats this id as
 *  protected: no caller — not the orchestrator itself, not a sub-agent, not the human
 *  operator — may terminate it via kill_agent. */
export const MAIN_AGENT_ID = "main-001";

export type SpawnSpec = {
  role: AgentRole;
  ticket_id: string | null;
  prompt: string;
  interactive: boolean;
  /** Resolved Claude Code model id (e.g. "claude-opus-4-7", "claude-sonnet-4-6[1m]").
   *  When set, passed via `--model` and surfaced to the agent in its system prompt
   *  so it knows which model it is running as. */
  model?: string;
  /** When true, omit the role-specific system prompt: a "plain" Claude window
   *  that's still wired to the charm MCP config and output rules, but carries
   *  no orchestration instructions. Used by `charm start` with no goal. */
  plain?: boolean;
  /** Working directory for this agent. Defaults to repo root (shared tree). Set to a worktree-copy path to isolate the agent in its own standalone repo clone. */
  cwd?: string;
  /** Claude-side session UUID, passed to `claude --session-id <uuid>` so charm
   *  owns (rather than discovers) the conversation id. Recorded on the registry
   *  entry and — for the orchestrator — persisted to its own run-dir file so the
   *  operator can later `charm resume` that conversation. When omitted,
   *  buildClaudeCommand mints a fresh one; callers that need to record the id
   *  should pass it in explicitly (see newClaudeSessionId). */
  claudeSessionId?: string;
  /** Relaunch an EXISTING conversation instead of starting a fresh one (used by
   *  `charm resume`). When set, the command swaps `--session-id <new>` for a
   *  resume flag and drops the positional prompt (the conversation already has
   *  its history), while keeping every other flag — model, permission mode,
   *  --mcp-config, --append-system-prompt — identical to the original spawn:
   *    - { uuid }     -> `claude --resume <uuid>`   (resume a specific session)
   *    - "continue"   -> `claude --continue`        (resume the most recent) */
  resume?: { uuid: string } | "continue";
};

/** Mint a fresh Claude-side session UUID for a spawn. Callers generate this up
 *  front (rather than letting buildClaudeCommand default it internally) when they
 *  need to record the id on the registry / in meta.json — the value passed to
 *  `--session-id` must match the one charm stores for `charm resume` to work. */
export function newClaudeSessionId(): string {
  return randomUUID();
}

/** User-facing aliases resolved to Claude Code model ids. */
export const MODEL_ALIASES: Record<string, string> = {
  "sonnet-4.6": "claude-sonnet-4-6",
  "sonnet-4.6-1m": "claude-sonnet-4-6[1m]",
  "opus-4.6": "claude-opus-4-6",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.7-1m": "claude-opus-4-7[1m]",
  "opus-4.8": "claude-opus-4-8",
  "opus-4.8-1m": "claude-opus-4-8[1m]",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
};

/** A charm "mode" sets the DEFAULT model family for the whole fleet (main +
 *  investigators + workers + testers) and the orchestrator's behavioral framing:
 *    research    -> Sonnet  (fast, cheap; exploration and research workflows)
 *    development -> Opus     (most capable; for writing and shipping code)
 *  This is a default, not a hard pin — `charm start -m/--model` (CHARM_MODEL)
 *  overrides the model for any mode, so research can run on Opus and development
 *  on Sonnet. Selected at `charm start` via --research / --development (alias
 *  --dev) or the interactive startup prompt, then propagated as CHARM_MODE. */
export type CharmMode = "research" | "development";

export const MODE_MODEL: Record<CharmMode, string> = {
  research: "sonnet-4.6",
  development: "opus-4.8",
};

export function isMode(v: string | undefined | null): v is CharmMode {
  return v === "research" || v === "development";
}

/** Default model per agent role, used only when no mode and no per-role override
 *  is set. Override per-spawn by setting `spec.model` explicitly, globally via the
 *  CHARM_MODEL_<ROLE> env vars (e.g. CHARM_MODEL_WORKER=opus-4.7), or for the whole
 *  fleet via the charm mode (CHARM_MODE=research|development).
 *
 *  The main agent runs investigation kickoff and the synthesis/planning that turns
 *  findings into worker tickets — the most reasoning-intensive work in the
 *  workflow. It defaults to Opus. Sub-agents (investigators, workers, testers)
 *  follow the fleet mode; their default is Sonnet. */
export const DEFAULT_MODEL_BY_ROLE: Record<AgentRole, string> = {
  main: "opus-4.8",
  investigator: "sonnet-4.6",
  worker: "sonnet-4.6",
  tester: "sonnet-4.6",
  suborchestrator: "opus-4.8",
};

/** Resolve the model for a spawned agent role. Precedence, highest first:
 *    1. CHARM_MODEL_<ROLE> env override (power-user, per-role)
 *    2. CHARM_MODEL fleet-wide override (`charm start -m/--model`) — wins over the
 *       mode, so ANY mode can run ANY model (e.g. Opus in research mode).
 *    3. CHARM_MODE default (research -> Sonnet, development -> Opus)
 *    4. DEFAULT_MODEL_BY_ROLE static fallback
 *  Mode is a DEFAULT, not a hard pin: it only decides the model when no explicit
 *  override (1 or 2) is set. */
export function defaultModelForRole(role: AgentRole): string {
  const roleOverride = process.env[`CHARM_MODEL_${role.toUpperCase()}`];
  if (roleOverride) return resolveModel(roleOverride);
  const fleetOverride = process.env.CHARM_MODEL;
  if (fleetOverride) return resolveModel(fleetOverride);
  const mode = process.env.CHARM_MODE;
  if (isMode(mode)) return resolveModel(MODE_MODEL[mode]);
  return resolveModel(DEFAULT_MODEL_BY_ROLE[role]);
}

/** Thinking-token budgets passed as MAX_THINKING_TOKENS to each claude process.
 *
 *  "max" is reserved for the main agent (investigation synthesis + planning): the
 *  graph decomposition problem benefits from the largest available reasoning budget.
 *  Sub-agents default to "high". Override globally with CHARM_THINKING or
 *  per-role with CHARM_THINKING_<ROLE> (e.g. CHARM_THINKING_WORKER=medium). */
export const THINKING_BUDGETS: Record<string, number> = {
  off: 0,
  low: 4000,
  medium: 10000,
  high: 32000,
  max: 64000,
};

/** Per-role thinking defaults. main gets "max"; everything else gets "high". */
export const DEFAULT_THINKING_BY_ROLE: Record<AgentRole, string> = {
  main: "max",
  investigator: "high",
  worker: "high",
  tester: "high",
  suborchestrator: "max",
};

/** Global thinking floor from CHARM_THINKING (applies to roles that don't have a
 *  per-role override). "high" if not set. */
export function defaultThinkingTokens(): number {
  const level = (process.env.CHARM_THINKING ?? "high").toLowerCase();
  return THINKING_BUDGETS[level] ?? THINKING_BUDGETS.high!;
}

/** Resolve thinking-token budget for a specific role. Precedence:
 *    1. CHARM_THINKING_<ROLE> env override (e.g. CHARM_THINKING_MAIN=high)
 *    2. DEFAULT_THINKING_BY_ROLE (main=max, others=high)
 *  The global CHARM_THINKING env var is NOT consulted here — use CHARM_THINKING_<ROLE>
 *  to tune individual roles without affecting the fleet default. */
export function defaultThinkingForRole(role: AgentRole): number {
  const override = (process.env[`CHARM_THINKING_${role.toUpperCase()}`] ?? "").toLowerCase();
  const level = override || DEFAULT_THINKING_BY_ROLE[role] || "high";
  return THINKING_BUDGETS[level] ?? THINKING_BUDGETS.high!;
}

/** Permission modes accepted by `claude --permission-mode`. Spawned agents run unattended
 *  in tmux panes, so they default to `auto` (skips permission prompts). Override per
 *  environment via CHARM_PERMISSION_MODE; an unrecognized value falls back to `auto`. */
export const PERMISSION_MODES = [
  "auto",
  "acceptEdits",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
] as const;

export function defaultPermissionMode(): string {
  const mode = (process.env.CHARM_PERMISSION_MODE ?? "auto").trim();
  return (PERMISSION_MODES as readonly string[]).includes(mode) ? mode : "auto";
}

/** Resolve a user-supplied --model value to a real Claude model id.
 *  Accepts either an alias from MODEL_ALIASES or a literal `claude-*` id. */
export function resolveModel(input: string): string {
  const v = input.trim();
  if (MODEL_ALIASES[v]) return MODEL_ALIASES[v]!;
  if (v.startsWith("claude-")) return v;
  const choices = Object.keys(MODEL_ALIASES).join(", ");
  throw new Error(`unknown --model "${input}". Use one of: ${choices} (or a raw claude-* id)`);
}

/** Build the shell command that the tmux pane will run.
 *  CHARM_AGENT_ID is exported so the MCP shim can identify the agent. */
export function buildClaudeCommand(paths: CharmPaths, agent_id: string, spec: SpawnSpec): string {
  // Resolve the role's system prompt. Every role but `main` loads a single
  // `<role>.md`. The orchestrator (`main`) has no `main.md`: it runs the staged
  // pipeline in one session, so its prompt IS the orchestrator frame followed by
  // the planner (which carries the two stages it runs directly: kicking off
  // investigation, then synthesizing findings into worker tickets), concatenated.
  // orchestrator.md is the top-level frame — it states the full gated pipeline
  // and the hard rule that no worker fan-out happens before the investigation
  // findings are synthesized and the plan approved; without it the agent reads a
  // standalone planner file and can skip straight to ticket fan-out. Assembling
  // them here is what makes these files live — without this, `main.md` is missing
  // and the orchestrator falls back to a useless one-line stub.
  let rolePrompt: string;
  if (spec.plain) {
    rolePrompt = "";
  } else if (spec.role === "main") {
    const stages = ["orchestrator.md", "planner.md"]
      .map((f) => join(paths.promptsDir, f))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, "utf8").trim());
    rolePrompt = stages.length
      ? stages.join("\n\n---\n\n")
      : "You are the orchestrator (main agent) running the charm investigate -> plan -> fan-out workflow.";
  } else {
    const promptFile = join(paths.promptsDir, `${spec.role}.md`);
    rolePrompt = existsSync(promptFile) ? readFileSync(promptFile, "utf8") : `You are a ${spec.role}.`;
  }
  // The charm renders agent-produced markdown (COORDINATION.md, tickets/*.md)
  // inside an Ink TUI. Terminal emoji rendering inflates row
  // height inconsistently across fonts/terminals, which breaks the layout —
  // so forbid emojis in every artifact agents write.
  const CHARM_RULES = [
    "",
    "## Charm output rules (override any contrary instruction)",
    "- Do NOT use emoji or pictographic characters anywhere in your output, in tool arguments, or in files you write (COORDINATION.md, tickets/*.md, code comments, commit messages — anywhere). This includes ✅ ❌ ⚠️ 🚀 ⭐ 📝 etc. Use ASCII instead: [x], [ ], (!), ->, *, etc.",
    "- Do NOT use box-drawing or other wide Unicode decoration in markdown output. ASCII only for status indicators, bullets, and dividers.",
    "- You have NO built-in subagent tool (no Agent/Task tool). The ONLY way to create agents is the charm MCP tools (create_tickets, spawn_investigators, spawn_workers, request_review). Never attempt to spawn a subagent any other way.",
  ].join("\n");
  // Operator skills router — injected only for the main agent (orchestrator).
  // Restart/reset-kb are operator actions; a worker or investigator must never run
  // them. The router lists trigger -> SKILL.md; the agent reads the full file on
  // demand. Sub-agents (and plain windows) never see this section.
  const skillsIndex = join(paths.skillsDir, "INDEX.md");
  const CHARM_SKILLS =
    (spec.role === "main" || spec.role === "suborchestrator") && !spec.plain && existsSync(skillsIndex)
      ? "\n## Charm operator skills (read on demand)\n" +
        "When the user asks you to perform one of the operator actions below, FIRST read the listed SKILL.md " +
        "(path relative to the project root) and follow it exactly — including any confirmation gates — before acting.\n\n" +
        readFileSync(skillsIndex, "utf8").trim() +
        "\n"
      : "";
  // The shared workspace guardrails (.charm/CHARM.md) are NOT appended here. They
  // reach every agent file-based instead: `charm init` makes the project's root
  // CLAUDE.md import `@.charm/CHARM.md`, and Claude Code natively loads that root
  // CLAUDE.md for any session whose cwd is the repo root — which every charm spawn
  // is. Appending here too would double-inject the same content into each agent's
  // context, so we rely solely on the import.
  // Shared coordination ethos for every sub-agent (worker / investigator / tester) —
  // NOT the orchestrator (which carries the other side of this in orchestrator.md)
  // and NOT plain windows. Injected from this single place so the three roles stay
  // in sync rather than drifting across their separate prompt files. It does two
  // things on purpose: (1) gives explicit psychological safety to escalate —
  // surfacing a blocker/failure early is the job, not a failure of it — because the
  // system's main failure mode is an agent burying a problem and rubber-stamping
  // broken work forward; (2) sets a clarity norm for talking to the orchestrator so
  // escalations are terse and decision-first. The "clarity is not silence" line
  // reconciles the two so "be terse" never collapses into "stay quiet."
  const CHARM_COORDINATION =
    spec.role !== "main" && !spec.plain
      ? "\n\n" +
        [
          "## Working with the orchestrator",
          "You are one agent in a fleet. The orchestrator (the `main` agent) scoped your ticket and handed it to you with the best context it had. Your job is to do that work well and to tell the orchestrator what it could not have known.",
          "- Surfacing a problem early is doing your job well, not failing it. The orchestrator WANTS your blockers, ambiguities, and bad news the moment you have them — a clear early signal saves a wasted downstream run. Never bury a problem or rubber-stamp work to avoid bothering it.",
          "- When you report to the orchestrator (a status note, a block, a failure), be clear and terse: lead with the decision you need or the fact it is missing, give the one specific detail that matters, then stop. Do not make it dig for the point.",
          "- Clarity is not silence. A precise, early blocker respects the orchestrator's time far more than a quiet rubber-stamp that pushes broken work forward.",
        ].join("\n") +
        "\n"
      : "";
  const modelLine = spec.model
    ? `\n## Runtime model\nYou are running as \`${spec.model}\`. If a task exceeds your capabilities or context window, surface it rather than silently truncating.\n`
    : "";
  const systemPrompt = rolePrompt + CHARM_RULES + CHARM_COORDINATION + CHARM_SKILLS + modelLine;
  const flags: string[] = [];
  if (!spec.interactive) flags.push("-p");
  // Conversation identity. A fresh spawn launches under a charm-owned
  // `--session-id <uuid>` so the id can be resumed later; a resume relaunch
  // instead reattaches to an existing conversation (`--resume <uuid>` or
  // `--continue`) and must NOT pass --session-id (claude rejects creating a
  // session that already exists). Either way every other flag below is identical,
  // which is the whole point — a resumed orchestrator keeps the same MCP config,
  // system prompt, model, and permission mode it was first spawned with.
  if (spec.resume) {
    if (spec.resume === "continue") flags.push("--continue");
    else flags.push("--resume", shellQuote(spec.resume.uuid));
  } else {
    const claudeSessionId = spec.claudeSessionId ?? newClaudeSessionId();
    flags.push("--session-id", shellQuote(claudeSessionId));
  }
  if (spec.model) flags.push("--model", shellQuote(spec.model));
  // Spawned agents run unattended in tmux panes, so they must not stall on permission
  // prompts. Default to `auto` (skips prompts); overridable via CHARM_PERMISSION_MODE.
  flags.push("--permission-mode", shellQuote(defaultPermissionMode()));
  // `--mcp-config` is variadic (`<configs...>`) — commander slurps every
  // following positional until the next flag. Put it FIRST so the next flag
  // (`--disallowed-tools`) terminates the list, otherwise the user prompt
  // gets eaten as a phantom MCP config path.
  flags.push("--mcp-config", shellQuote(paths.sessionMcpConfig));
  // Strip every built-in tool that can spawn agents OUTSIDE charm's orchestration,
  // so all fan-out must go through the charm MCP tools (spawn_workers /
  // spawn_investigators / request_review) the daemon needs for dependency +
  // file-scope enforcement:
  //   - Agent       — the native subagent tool (current name in Claude Code).
  //   - Task        — its older alias; harmless to keep listed for older CLIs.
  //   - Workflow    — multi-agent orchestration that fans out subagents via
  //                   agent()/parallel()/pipeline(); a SECOND spawn path that
  //                   `--disallowed-tools Agent` alone does NOT remove. Verified
  //                   against Claude Code 2.1.161: blocked agents otherwise
  //                   offer to "run it as a Workflow instead", bypassing charm.
  // `--disallowed-tools` is variadic, so the next flag (`--append-system-prompt`)
  // terminates the list. This is a hard, API-level removal (the tools leave the
  // schema), not a prompt request — the model cannot call them even if told to.
  // NOTE: this does not close the Bash escape hatch (an agent can still run
  // `claude` itself via Bash); that is only closable by sandboxing Bash, which
  // workers need. The flag covers the built-in tools, which is the real exposure.
  flags.push("--disallowed-tools", shellQuote("Agent"), shellQuote("Task"), shellQuote("Workflow"));
  flags.push("--append-system-prompt", shellQuote(systemPrompt));
  // An empty prompt means a blank interactive window (e.g. `charm start` with
  // no goal): omit the positional so Claude opens waiting for user input. A
  // resume relaunch also omits it — the conversation already carries its history,
  // so re-injecting the original goal would re-run it.
  if (spec.prompt && !spec.resume) flags.push(shellQuote(spec.prompt));
  // export agent id, then exec claude
  const thinking = defaultThinkingForRole(spec.role);
  return [
    `export CHARM_AGENT_ID=${shellQuote(agent_id)}`,
    `export CHARM_SOCKET=${shellQuote(paths.socket)}`,
    // Disable Claude Code's per-project prompt history — otherwise the previous
    // charm-start prompt gets pre-populated into the input box and re-submitted
    // after the current prompt begins processing.
    `export CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`,
    `export MAX_THINKING_TOKENS=${thinking}`,
    `exec claude ${flags.join(" ")}`,
  ].join(" && ");
}

/** Pre-approve a directory in ~/.claude.json so Claude Code skips the
 *  "Do you trust this directory?" dialog for interactive sessions. */
export function ensureDirectoryTrusted(dir: string): void {
  const claudeJson = join(homedir(), ".claude.json");
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(readFileSync(claudeJson, "utf8"));
  } catch {
    // file missing or malformed — start fresh
  }
  if (!data.projects) data.projects = {};
  const entry = data.projects[dir] ?? {};
  if (entry.hasTrustDialogAccepted) return;
  entry.hasTrustDialogAccepted = true;
  data.projects[dir] = entry;
  writeFileSync(claudeJson, JSON.stringify(data, null, 2) + "\n");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
