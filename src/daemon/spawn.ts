/**
 * Agent launch surface — thin compatibility shim over the hexagonal runtime
 * port in `src/runtime/`. New code should import from `../runtime/index.ts`.
 *
 * Kept so existing daemon/CLI imports (`buildClaudeCommand`, `SpawnSpec`,
 * `claudeSessionId`, …) continue to typecheck without a sweeping rename.
 */
import type { AgentRole } from "../schema.ts";
import type { LaunchSpec } from "../runtime/types.ts";

export type SpawnSpec = Omit<LaunchSpec, "sessionId"> & {
  /** Concise fleet-visible description of what this agent is trying to do. */
  goal?: string;
  /** @deprecated Prefer sessionId. */
  claudeSessionId?: string;
  sessionId?: string;
};

export {
  MAIN_AGENT_ID,
  MODEL_ALIASES,
  SPAWN_MODEL_FAMILIES,
  DEFAULT_MODEL_BY_ROLE,
  THINKING_BUDGETS,
  DEFAULT_THINKING_BY_ROLE,
  resolveModel,
  resolveSpawnModel,
  defaultModelForRole,
  suborchestratorModelForRuntime,
  defaultThinkingForRole,
  defaultThinkingTokens,
  reasoningEffortForRole,
  runtimeKindForModel,
  runtimeKindForRole,
  prettyModel,
  defaultPermissionMode,
  workflowEnabled,
  ensureDirectoryTrusted,
  ensureClaudeDirectoryTrusted,
  buildAgentCommand,
  buildClaudeCommand,
  newSessionId,
  newClaudeSessionId,
  getRuntime,
  type SpawnModelFamily,
  type RuntimeKind,
  type AgentRuntime,
} from "../runtime/index.ts";

export type { AgentRole };
