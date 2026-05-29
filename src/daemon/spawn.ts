import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { HarnessPaths } from "../paths.ts";
import type { AgentRole } from "../schema.ts";

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
   *  that's still wired to the harness MCP config and output rules, but carries
   *  no orchestration instructions. Used by `harness start` with no goal. */
  plain?: boolean;
};

/** User-facing aliases resolved to Claude Code model ids. */
export const MODEL_ALIASES: Record<string, string> = {
  "sonnet-4.6": "claude-sonnet-4-6",
  "sonnet-4.6-1m": "claude-sonnet-4-6[1m]",
  "opus-4.6": "claude-opus-4-6",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.7-1m": "claude-opus-4-7[1m]",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
};

/** Default model per agent role. Every role runs on Sonnet 4.6 (the most recent
 *  Sonnet) by default. Override per-spawn by setting `spec.model` explicitly, or
 *  globally via the HARNESS_MODEL_<ROLE> env vars (e.g. HARNESS_MODEL_WORKER=opus-4.7). */
export const DEFAULT_MODEL_BY_ROLE: Record<AgentRole, string> = {
  main: "sonnet-4.6",
  reviewer: "sonnet-4.6",
  worker: "sonnet-4.6",
  tester: "sonnet-4.6",
};

export function defaultModelForRole(role: AgentRole): string {
  const envKey = `HARNESS_MODEL_${role.toUpperCase()}`;
  const override = process.env[envKey];
  return resolveModel(override ?? DEFAULT_MODEL_BY_ROLE[role]);
}

/** Thinking-token budgets. Claude Code reads MAX_THINKING_TOKENS from the
 *  environment. "high" is our default; drop to "medium"/"low" via HARNESS_THINKING
 *  for lighter reasoning. */
export const THINKING_BUDGETS: Record<string, number> = {
  off: 0,
  low: 4000,
  medium: 10000,
  high: 32000,
};

export function defaultThinkingTokens(): number {
  const level = (process.env.HARNESS_THINKING ?? "high").toLowerCase();
  return THINKING_BUDGETS[level] ?? THINKING_BUDGETS.high!;
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
 *  HARNESS_AGENT_ID is exported so the MCP shim can identify the agent. */
export function buildClaudeCommand(paths: HarnessPaths, agent_id: string, spec: SpawnSpec): string {
  const promptFile = join(paths.promptsDir, `${spec.role}.md`);
  const rolePrompt = spec.plain
    ? ""
    : existsSync(promptFile)
      ? readFileSync(promptFile, "utf8")
      : `You are a ${spec.role}.`;
  // The harness renders agent-produced markdown (PROJECT.md, COORDINATION.md,
  // tickets/*.md) inside an Ink TUI. Terminal emoji rendering inflates row
  // height inconsistently across fonts/terminals, which breaks the layout —
  // so forbid emojis in every artifact agents write.
  const HARNESS_RULES = [
    "",
    "## Harness output rules (override any contrary instruction)",
    "- Do NOT use emoji or pictographic characters anywhere in your output, in tool arguments, or in files you write (PROJECT.md, COORDINATION.md, tickets/*.md, code comments, commit messages — anywhere). This includes ✅ ❌ ⚠️ 🚀 ⭐ 📝 etc. Use ASCII instead: [x], [ ], (!), ->, *, etc.",
    "- Do NOT use box-drawing or other wide Unicode decoration in markdown output. ASCII only for status indicators, bullets, and dividers.",
  ].join("\n");
  const modelLine = spec.model
    ? `\n## Runtime model\nYou are running as \`${spec.model}\`. If a task exceeds your capabilities or context window, surface it rather than silently truncating.\n`
    : "";
  const systemPrompt = rolePrompt + HARNESS_RULES + modelLine;
  const flags: string[] = [];
  if (!spec.interactive) flags.push("-p");
  if (spec.model) flags.push("--model", shellQuote(spec.model));
  // `--mcp-config` is variadic (`<configs...>`) — commander slurps every
  // following positional until the next flag. Put it FIRST so the next flag
  // (`--append-system-prompt`) terminates the list, otherwise the user prompt
  // gets eaten as a phantom MCP config path.
  flags.push("--mcp-config", shellQuote(paths.mcpConfig));
  flags.push("--append-system-prompt", shellQuote(systemPrompt));
  // An empty prompt means a blank interactive window (e.g. `harness start` with
  // no goal): omit the positional so Claude opens waiting for user input.
  if (spec.prompt) flags.push(shellQuote(spec.prompt));
  // export agent id, then exec claude
  const thinking = defaultThinkingTokens();
  return [
    `export HARNESS_AGENT_ID=${shellQuote(agent_id)}`,
    `export HARNESS_SOCKET=${shellQuote(paths.socket)}`,
    // Disable Claude Code's per-project prompt history — otherwise the previous
    // harness-start prompt gets pre-populated into the input box and re-submitted
    // after the current prompt begins processing.
    `export CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`,
    `export MAX_THINKING_TOKENS=${thinking}`,
    `exec claude ${flags.join(" ")}`,
  ].join(" && ");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
