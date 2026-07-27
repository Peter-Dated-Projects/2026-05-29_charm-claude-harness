import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRuntime, LaunchContext } from "../types.ts";
import { shellQuote } from "../shell.ts";
import { prettyModel } from "../models.ts";
import { resolveCharmCliArgv } from "../charm-cli.ts";

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

/** Whether Claude's built-in Workflow tool stays enabled (default: yes). */
export function workflowEnabled(): boolean {
  return process.env.CHARM_WORKFLOW_ENABLE !== "0";
}

export function ensureClaudeDirectoryTrusted(dir: string): void {
  const claudeJson = join(homedir(), ".claude.json");
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(readFileSync(claudeJson, "utf8"));
  } catch {
    // missing / malformed — start fresh
  }
  if (!data.projects) data.projects = {};
  const entry = data.projects[dir] ?? {};
  if (entry.hasTrustDialogAccepted) return;
  entry.hasTrustDialogAccepted = true;
  data.projects[dir] = entry;
  writeFileSync(claudeJson, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Write a per-agent Claude settings file that only installs Charm's statusLine
 * reporter. Passed via `claude --settings` so it does not rewrite the project
 * `.claude/settings.json`. refreshInterval keeps the pane border in sync when
 * the operator runs `/model` without waiting for the next assistant turn.
 */
export function writeClaudeAgentSettings(pathsRunDir: string, agentId: string): string {
  const dir = join(pathsRunDir, "agent-settings");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${agentId}.json`);
  const cli = resolveCharmCliArgv();
  const command = [...cli, "report-model"].map(shellQuote).join(" ");
  const settings = {
    statusLine: {
      type: "command",
      command,
      // Event triggers alone miss mid-session /model switches until the next
      // assistant message; a short interval keeps the border/console current.
      refreshInterval: 2,
      padding: 0,
    },
  };
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return file;
}

export class ClaudeRuntime implements AgentRuntime {
  readonly kind = "claude" as const;

  prettyModel(id: string): string {
    return prettyModel(id);
  }

  ensureWorkspaceReady(dir: string): void {
    ensureClaudeDirectoryTrusted(dir);
  }

  buildCommand(ctx: LaunchContext): string {
    const { paths, agentId, spec, instructionsFile, persistHistory, thinkingTokens } = ctx;
    const flags: string[] = [];
    if (!spec.interactive) flags.push("-p");

    if (spec.resume) {
      if (spec.resume === "continue") flags.push("--continue");
      else flags.push("--resume", shellQuote(spec.resume.uuid));
    } else {
      const sessionId = spec.sessionId ?? randomUUID();
      flags.push("--session-id", shellQuote(sessionId));
    }
    if (spec.model) flags.push("--model", shellQuote(spec.model));
    flags.push("--permission-mode", shellQuote(defaultPermissionMode()));
    flags.push("--dangerously-skip-permissions");
    flags.push("--mcp-config", shellQuote(paths.sessionMcpConfig));

    const settingsFile = writeClaudeAgentSettings(paths.runDir, agentId);
    flags.push("--settings", shellQuote(settingsFile));

    const disallowedTools = ["Agent", "Task"];
    // Workflow stays enabled by default so Charm matches Claude Code's
    // orchestration surface; CHARM_WORKFLOW_ENABLE=0 strips it.
    if (!workflowEnabled()) disallowedTools.push("Workflow");
    flags.push("--disallowed-tools", ...disallowedTools.map((t) => shellQuote(t)));
    flags.push("--system-prompt-file", shellQuote(instructionsFile));
    if (spec.prompt && !spec.resume) flags.push(shellQuote(spec.prompt));

    return [
      `export CHARM_AGENT_ID=${shellQuote(agentId)}`,
      `export CHARM_AGENT_ROLE=${shellQuote(spec.role)}`,
      `export CHARM_SOCKET=${shellQuote(paths.socket)}`,
      ...(persistHistory ? [] : ["export CLAUDE_CODE_SKIP_PROMPT_HISTORY=1"]),
      `export MAX_THINKING_TOKENS=${thinkingTokens}`,
      `exec claude ${flags.join(" ")}`,
    ].join(" && ");
  }
}

/** True when Claude Code has persisted a conversation for `uuid`. */
export function claudeConversationExists(uuid: string): boolean {
  const base = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(base);
  } catch {
    return false;
  }
  return dirs.some((d) => existsSync(join(base, d, `${uuid}.jsonl`)));
}
