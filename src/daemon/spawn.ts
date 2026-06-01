import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CharmPaths } from "../paths.ts";
import type { AgentRole } from "../schema.ts";

/** The orchestrator always runs under this fixed agent id. It is spawned directly by
 *  `charm start` (not through the registry's auto-incrementing sub-agent sequence), so
 *  no reviewer/worker/tester can ever collide with it. The kill path treats this id as
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
};

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

/** A charm "mode" pins every agent role to a single model family, so the whole
 *  fleet (main + reviewers + workers + testers) runs on one model:
 *    research    -> Sonnet  (fast, cheap; exploration and research workflows)
 *    development -> Opus     (most capable; for writing and shipping code)
 *  Selected at `charm start` via --research / --development (alias --dev) or the
 *  interactive startup prompt, then propagated to the daemon as CHARM_MODE. */
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
 *  The main agent runs both Stage 0 (discovery) and Stage 1 (planning) — the most
 *  reasoning-intensive work in the workflow. It defaults to Opus. Sub-agents
 *  (reviewers, workers, testers) follow the fleet mode; their default is Sonnet. */
export const DEFAULT_MODEL_BY_ROLE: Record<AgentRole, string> = {
  main: "opus-4.8",
  reviewer: "sonnet-4.6",
  worker: "sonnet-4.6",
  tester: "sonnet-4.6",
};

/** Resolve the model for a spawned agent role. Precedence, highest first:
 *    1. CHARM_MODEL_<ROLE> env override (power-user, per-role)
 *    2. CHARM_MODE (research -> Sonnet, development -> Opus) — the fleet-wide mode
 *    3. DEFAULT_MODEL_BY_ROLE static fallback */
export function defaultModelForRole(role: AgentRole): string {
  const override = process.env[`CHARM_MODEL_${role.toUpperCase()}`];
  if (override) return resolveModel(override);
  const mode = process.env.CHARM_MODE;
  if (isMode(mode)) return resolveModel(MODE_MODEL[mode]);
  return resolveModel(DEFAULT_MODEL_BY_ROLE[role]);
}

/** Thinking-token budgets passed as MAX_THINKING_TOKENS to each claude process.
 *
 *  "max" is reserved for the main agent (discovery + planning): the graph
 *  decomposition problem benefits from the largest available reasoning budget.
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
  reviewer: "high",
  worker: "high",
  tester: "high",
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

/** A platform-agnostic description of how to launch one `claude` agent process:
 *  the argv to exec and the environment to set. This is the source of truth that
 *  every multiplexer backend consumes — the tmux/POSIX backend serializes it to a
 *  shell string (buildClaudeCommand), while argv-based backends (WezTerm, ConPTY)
 *  pass argv + env straight to the process. Building argv instead of a quoted
 *  string also removes a whole class of shell-quoting bugs (notably the multiline
 *  --append-system-prompt payload, which is just one argv element here). */
export type ClaudeLaunch = { argv: string[]; env: Record<string, string> };

/** Build the structured launch spec (argv + env) for a `claude` agent.
 *  CHARM_AGENT_ID is set so the MCP shim can identify the agent. */
export function buildClaudeLaunch(paths: CharmPaths, agent_id: string, spec: SpawnSpec): ClaudeLaunch {
  // Resolve the role's system prompt. Every role but `main` loads a single
  // `<role>.md`. The orchestrator (`main`) has no `main.md`: it runs Stage 0
  // (discovery) then Stage 1 (planning) in one session, so its prompt IS those
  // two stage files concatenated. Assembling them here is what makes discovery.md
  // and planner.md live — without this, `main.md` is missing and the orchestrator
  // falls back to a useless one-line stub.
  let rolePrompt: string;
  if (spec.plain) {
    rolePrompt = "";
  } else if (spec.role === "main") {
    const stages = ["discovery.md", "planner.md"]
      .map((f) => join(paths.promptsDir, f))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, "utf8").trim());
    rolePrompt = stages.length
      ? stages.join("\n\n---\n\n")
      : "You are the orchestrator (main agent) running the charm discovery -> planning -> fan-out workflow.";
  } else {
    const promptFile = join(paths.promptsDir, `${spec.role}.md`);
    rolePrompt = existsSync(promptFile) ? readFileSync(promptFile, "utf8") : `You are a ${spec.role}.`;
  }
  // The charm renders agent-produced markdown (PROJECT.md, COORDINATION.md,
  // tickets/*.md) inside an Ink TUI. Terminal emoji rendering inflates row
  // height inconsistently across fonts/terminals, which breaks the layout —
  // so forbid emojis in every artifact agents write.
  const CHARM_RULES = [
    "",
    "## Charm output rules (override any contrary instruction)",
    "- Do NOT use emoji or pictographic characters anywhere in your output, in tool arguments, or in files you write (PROJECT.md, COORDINATION.md, tickets/*.md, code comments, commit messages — anywhere). This includes ✅ ❌ ⚠️ 🚀 ⭐ 📝 etc. Use ASCII instead: [x], [ ], (!), ->, *, etc.",
    "- Do NOT use box-drawing or other wide Unicode decoration in markdown output. ASCII only for status indicators, bullets, and dividers.",
    "- You have NO built-in subagent tool (no Agent/Task tool). The ONLY way to create agents is the charm MCP tools (create_tickets, spawn_review_agents, spawn_workers, request_review). Never attempt to spawn a subagent any other way.",
    "",
    "## Charm MCP tools (full catalog — available to every agent)",
    "You are connected to the `charm-mcp` server. Every charm agent has all of these tools available. Call the ones your task needs; the daemon enforces the hard constraints noted below.",
    "- create_tickets — create one or more tickets (each: title, body, depends_on, touches file globs).",
    "- spawn_review_agents — spawn one headless reviewer agent per ticket id.",
    "- spawn_workers — spawn interactive worker agents; the daemon defers any ticket whose deps or `touches` conflict with running work.",
    "- request_review — spawn a tester agent on one finished ticket id.",
    "- await_approval — block until a human approves or rejects a gate (stage 0, 2, or 4) in the Console pane.",
    "- set_session_description — set or update the one-sentence (<=80 char) session description shown by `charm list`.",
    "- update_plan — record your current plan before editing files. The daemon appends it to your ticket's activity log (.charm/tickets/<id>.md). Self-scoped to your ticket.",
    "- read_coordination — return the live coordination board: one row per not-yet-complete ticket (open, in-flight, or failed) with its stage, status, and the sub-agent on it (or '-' if unassigned). For a ticket's full plan/status/message history, read its file directly.",
    "- list_tickets — query the ticket index (sqlite) for ticket state; optional `statuses` filter (e.g. [\"ready\"], [\"failed\"]), omit for all tickets. Structured, filterable counterpart to read_coordination; use it for triage/scheduling.",
    "- report_status — report your own AGENT state (spawning|running|blocked|done|failed) with an optional note. Self-scoped; drives pane reaping and orchestrator pings.",
    "- set_ticket_status — drive your OWN ticket's lifecycle: status (running/blocked/complete/failed) and/or stage (in_progress->review->testing). Self-scoped. `cancelled` is operator-only, not settable here.",
    "- list_agents — list every live sub-agent (id, role, state, ticket_id). The orchestrator is not listed.",
    "- kill_agent — terminate an agent's tmux pane. The orchestrator may kill any sub-agent by id; a sub-agent may kill only itself (omit agent_id). A self-kill marks the ticket `failed`; the orchestrator/operator killing another agent marks it `cancelled`. The orchestrator can never be killed.",
    "- continue_agent — orchestrator-only: resume a blocked sub-agent by sending it a message (your guidance or the unblock info) and flipping it back to running. Use this once you've resolved what a blocked agent was waiting on, instead of killing and respawning it.",
    "- cancel_ticket — orchestrator/operator-only: call off a ticket that is no longer wanted (descoped/superseded). Marks it `cancelled`, drops it from the board, and tears down any agent on it. NOT for retrying a stuck agent — kill_agent (-> `failed`, stays for reassignment) is that path.",
    "- open_graph — open the animated force-directed graph viewer in its own tmux window; if one is already open it is brought to the foreground.",
  ].join("\n");
  // Operator skills router — injected only for the main agent (orchestrator).
  // Restart/reset-kb are operator actions; a worker or reviewer must never run
  // them. The router lists trigger -> SKILL.md; the agent reads the full file on
  // demand. Sub-agents (and plain windows) never see this section.
  const skillsIndex = join(paths.skillsDir, "INDEX.md");
  const CHARM_SKILLS =
    spec.role === "main" && !spec.plain && existsSync(skillsIndex)
      ? "\n## Charm operator skills (read on demand)\n" +
        "When the user asks you to perform one of the operator actions below, FIRST read the listed SKILL.md " +
        "(path relative to the project root) and follow it exactly — including any confirmation gates — before acting.\n\n" +
        readFileSync(skillsIndex, "utf8").trim() +
        "\n"
      : "";
  const modelLine = spec.model
    ? `\n## Runtime model\nYou are running as \`${spec.model}\`. If a task exceeds your capabilities or context window, surface it rather than silently truncating.\n`
    : "";
  const systemPrompt = rolePrompt + CHARM_RULES + CHARM_SKILLS + modelLine;
  // argv[0] is the claude binary; the multiplexer backend resolves it on PATH
  // (claude / claude.cmd / claude.ps1 on Windows). Each flag value is a distinct
  // argv element — no quoting here; quoting is a serialization concern handled
  // per-backend (buildClaudeCommand for shell).
  const argv: string[] = ["claude"];
  if (!spec.interactive) argv.push("-p");
  if (spec.model) argv.push("--model", spec.model);
  // Spawned agents run unattended in panes, so they must not stall on permission
  // prompts. Default to `auto` (skips prompts); overridable via CHARM_PERMISSION_MODE.
  argv.push("--permission-mode", defaultPermissionMode());
  // `--mcp-config` is variadic (`<configs...>`) — commander slurps every
  // following positional until the next flag. Keep it before the next flag
  // (`--disallowed-tools`) so the list terminates cleanly.
  argv.push("--mcp-config", paths.mcpConfig);
  // Remove Claude Code's native subagent tool (`Agent`, older alias `Task`) so agents
  // can't spawn subagents outside charm's orchestration. All fan-out must go through the
  // charm MCP tools (spawn_workers / spawn_review_agents / request_review), which the
  // daemon needs for dependency + file-scope enforcement. Also variadic, so the
  // next flag (`--append-system-prompt`) terminates the list.
  argv.push("--disallowed-tools", "Agent", "Task");
  argv.push("--append-system-prompt", systemPrompt);
  // An empty prompt means a blank interactive window (e.g. `charm start` with
  // no goal): omit the positional so Claude opens waiting for user input.
  if (spec.prompt) argv.push(spec.prompt);

  const env: Record<string, string> = {
    CHARM_AGENT_ID: agent_id,
    CHARM_SOCKET: paths.socket,
    // Disable Claude Code's per-project prompt history — otherwise the previous
    // charm-start prompt gets pre-populated into the input box and re-submitted
    // after the current prompt begins processing.
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
    MAX_THINKING_TOKENS: String(defaultThinkingForRole(spec.role)),
  };
  return { argv, env };
}

/** Serialize a ClaudeLaunch into a single POSIX `sh -c` string:
 *  `export K=V && … && exec claude <args…>`. Used by the tmux backend, which
 *  runs panes through `sh -c`. POSIX-only by construction (the `export`/`exec`
 *  syntax and single-quote escaping are bash-isms) — argv-based backends
 *  (WezTerm, ConPTY) consume buildClaudeLaunch directly and never call this. */
export function serializeLaunchForShell({ argv, env }: ClaudeLaunch): string {
  const exports = Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}`);
  const exec = `exec ${argv.map(shellQuote).join(" ")}`;
  return [...exports, exec].join(" && ");
}

/** Build the `sh -c` command string a tmux pane runs to launch one agent.
 *  Thin wrapper preserving the original API; the argv/env truth now lives in
 *  buildClaudeLaunch. */
export function buildClaudeCommand(paths: CharmPaths, agent_id: string, spec: SpawnSpec): string {
  return serializeLaunchForShell(buildClaudeLaunch(paths, agent_id, spec));
}

/** Single-quote a string for a PowerShell command. In a PS single-quoted literal
 *  only the quote itself is special (escaped by doubling); backslashes and `$`
 *  are literal — exactly what we want for Windows paths and named-pipe endpoints. */
function pwshQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Serialize a launch into a PowerShell `-Command` string:
 *  `$env:K='V'; …; & 'claude' 'arg' …`. The Windows analog of
 *  serializeLaunchForShell, used by the psmux backend (panes run pwsh, not sh).
 *  The `&` call operator resolves `claude` through PATHEXT (claude.cmd/.ps1), so
 *  no explicit .exe/.cmd resolution is needed here. Accepts any {argv, env}. */
export function serializeLaunchForPwsh({ argv, env }: ClaudeLaunch): string {
  const sets = Object.entries(env).map(([k, v]) => `$env:${k}=${pwshQuote(v)}`);
  const call = `& ${argv.map(pwshQuote).join(" ")}`;
  return [...sets, call].join("; ");
}

/** Serialize a launch as a standalone PowerShell *script* (one statement per
 *  line). Written to a `.ps1` the pane runs via `& '<path>'`, NOT inlined on the
 *  command line: an agent's `--append-system-prompt` carries double-quotes and
 *  newlines that shatter psmux's `powershell -Command "<...>"` wrapping, but in a
 *  script file those characters are inert — a single-quoted PowerShell string can
 *  even span newlines, and only `'` needs escaping (pwshQuote doubles it).
 *  Returned with a UTF-8 BOM prepended by the caller so Windows PowerShell 5.1
 *  (which otherwise reads scripts in the ANSI codepage) keeps any non-ASCII
 *  prompt text intact. */
export function serializeLaunchToPs1({ argv, env }: ClaudeLaunch): string {
  const lines = Object.entries(env).map(([k, v]) => `$env:${k} = ${pwshQuote(v)}`);
  lines.push(`& ${argv.map(pwshQuote).join(" ")}`);
  return lines.join("\r\n") + "\r\n";
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
