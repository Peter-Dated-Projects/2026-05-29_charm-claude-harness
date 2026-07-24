import type { AgentRole } from "../schema.ts";
import type { CharmPaths } from "../paths.ts";

/** Which coding-agent CLI hosts a Charm pane. */
export type RuntimeKind = "claude" | "codex";

/**
 * Provider-agnostic launch request. Adapters turn this into a shell command that
 * tmux runs in a pane. Charm owns tickets, scopes, and MCP; the runtime only
 * hosts the model session.
 */
export type LaunchSpec = {
  role: AgentRole;
  ticket_id: string | null;
  prompt: string;
  interactive: boolean;
  /** Concrete model id after alias resolution (e.g. claude-opus-4-8[1m], gpt-5.6-sol). */
  model?: string;
  /** Force a runtime regardless of model id. Used to pin main on Claude. */
  runtime?: RuntimeKind;
  plain?: boolean;
  cwd?: string;
  projectBrief?: { name: string; slug: string; body: string };
  /**
   * Caller-owned session id when the runtime supports minting one (Claude).
   * Codex generates its own id; Charm still records a UUID for registry bookkeeping.
   */
  sessionId?: string;
  /** Resume an existing conversation instead of starting fresh. */
  resume?: { uuid: string } | "continue";
};

export type LaunchContext = {
  paths: CharmPaths;
  agentId: string;
  spec: LaunchSpec;
  /** Absolute path to the assembled system/instructions file written for this agent. */
  instructionsFile: string;
  /** Whether this agent should persist a resume-able transcript. */
  persistHistory: boolean;
  thinkingTokens: number;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh";
};

/** Port: one adapter per coding-agent CLI. */
export interface AgentRuntime {
  readonly kind: RuntimeKind;
  /** Build the shell command the tmux pane will exec. */
  buildCommand(ctx: LaunchContext): string;
  /** Pre-flight workspace trust / sandbox acceptance for this runtime. */
  ensureWorkspaceReady(dir: string): void;
  /** Compact model label for the pane status bar. */
  prettyModel(id: string): string;
}
