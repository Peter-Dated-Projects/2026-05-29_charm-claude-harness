import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { HarnessPaths } from "../paths.ts";
import type { AgentRole } from "../schema.ts";

export type SpawnSpec = {
  role: AgentRole;
  ticket_id: string | null;
  prompt: string;
  interactive: boolean;
};

/** Build the shell command that the tmux pane will run.
 *  HARNESS_AGENT_ID is exported so the MCP shim can identify the agent. */
export function buildClaudeCommand(paths: HarnessPaths, agent_id: string, spec: SpawnSpec): string {
  const promptFile = join(paths.promptsDir, `${spec.role}.md`);
  const systemPrompt = existsSync(promptFile) ? readFileSync(promptFile, "utf8") : `You are a ${spec.role}.`;
  const flags: string[] = [];
  if (!spec.interactive) flags.push("-p");
  flags.push("--append-system-prompt", shellQuote(systemPrompt));
  flags.push("--mcp-config", shellQuote(paths.mcpConfig));
  const user = shellQuote(spec.prompt);
  // export agent id, then exec claude
  return [
    `export HARNESS_AGENT_ID=${shellQuote(agent_id)}`,
    `export HARNESS_SOCKET=${shellQuote(paths.socket)}`,
    `exec claude ${flags.join(" ")} ${user}`,
  ].join(" && ");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
