import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CharmPaths } from "../paths.ts";
import type { AgentRole } from "../schema.ts";
import type { AgentRuntime, LaunchSpec, RuntimeKind } from "./types.ts";
import { assembleInstructions } from "./prompt.ts";
import {
  defaultModelForRole,
  defaultThinkingForRole,
  prettyModel,
  reasoningEffortForRole,
  runtimeKindForModel,
  runtimeKindForRole,
} from "./models.ts";
import { ClaudeRuntime } from "./adapters/claude.ts";
import { CodexRuntime } from "./adapters/codex.ts";

export type { LaunchSpec, RuntimeKind, AgentRuntime, LaunchContext } from "./types.ts";
export {
  MODEL_ALIASES,
  SPAWN_MODEL_FAMILIES,
  DEFAULT_MODEL_BY_ROLE,
  THINKING_BUDGETS,
  DEFAULT_THINKING_BY_ROLE,
  resolveModel,
  resolveSpawnModel,
  defaultModelForRole,
  defaultThinkingForRole,
  defaultThinkingTokens,
  reasoningEffortForRole,
  runtimeKindForModel,
  runtimeKindForRole,
  prettyModel,
  type SpawnModelFamily,
} from "./models.ts";
export {
  defaultPermissionMode,
  workflowEnabled,
  ensureClaudeDirectoryTrusted,
  claudeConversationExists,
} from "./adapters/claude.ts";

const claudeRuntime = new ClaudeRuntime();
const codexRuntime = new CodexRuntime();

export function getRuntime(kind: RuntimeKind): AgentRuntime {
  return kind === "codex" ? codexRuntime : claudeRuntime;
}

/**
 * Build the shell command that the tmux pane will run.
 *
 * Hexagonal entry: assemble shared instructions, pick the runtime adapter from
 * the resolved model (main is forced onto Claude; `:so` defaults to Codex terra),
 * write the instructions file, and let the adapter produce the CLI invocation.
 */
export function buildAgentCommand(paths: CharmPaths, agentId: string, spec: LaunchSpec): string {
  const model = spec.model ?? defaultModelForRole(spec.role);
  const kind = spec.runtime ?? runtimeKindForRole(spec.role, model);
  // Main is Claude-only. If a Codex model slipped through for main, fall back
  // to the Claude role default.
  const effectiveModel =
    spec.role === "main" && runtimeKindForModel(model) === "codex"
      ? defaultModelForRole(spec.role)
      : model;

  const resolved: LaunchSpec = { ...spec, model: effectiveModel, runtime: kind };
  const instructions = assembleInstructions(paths, agentId, resolved);
  const promptDir = join(paths.runDir, "system-prompts");
  mkdirSync(promptDir, { recursive: true });
  const instructionsFile = join(promptDir, `${agentId}.txt`);
  writeFileSync(instructionsFile, instructions);

  const isOrchestratorRole = resolved.role === "main" || resolved.role === "suborchestrator";
  const persistHistory =
    isOrchestratorRole ||
    !!resolved.plain ||
    process.env.CHARM_SAVE_SUBAGENT_HISTORY === "1";

  const runtime = getRuntime(kind);
  return runtime.buildCommand({
    paths,
    agentId,
    spec: resolved,
    instructionsFile,
    persistHistory,
    thinkingTokens: defaultThinkingForRole(resolved.role),
    reasoningEffort: reasoningEffortForRole(resolved.role),
  });
}

/** Pre-approve a working directory for the runtime that will host the agent. */
export function ensureDirectoryTrusted(dir: string, kind: RuntimeKind = "claude"): void {
  getRuntime(kind).ensureWorkspaceReady(dir);
}

export function newSessionId(): string {
  return randomUUID();
}

/** @deprecated Prefer newSessionId — kept for callers that still say "Claude". */
export function newClaudeSessionId(): string {
  return newSessionId();
}

/**
 * Back-compat alias used throughout the daemon/CLI before the hexagonal split.
 * Prefer buildAgentCommand.
 */
export function buildClaudeCommand(paths: CharmPaths, agentId: string, spec: LaunchSpec & { claudeSessionId?: string }): string {
  const { claudeSessionId, ...rest } = spec;
  return buildAgentCommand(paths, agentId, {
    ...rest,
    sessionId: rest.sessionId ?? claudeSessionId,
    // Explicit Claude pin when callers use the legacy name — but still honor
    // Codex models on non-orchestrator roles via runtimeKindForRole.
  });
}

export const MAIN_AGENT_ID = "main-001";

/** Re-export role type for spawn callers. */
export type { AgentRole };
