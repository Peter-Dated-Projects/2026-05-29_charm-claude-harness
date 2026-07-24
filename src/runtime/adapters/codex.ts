import type { AgentRuntime, LaunchContext } from "../types.ts";
import { shellQuote } from "../shell.ts";
import { prettyModel } from "../models.ts";
import { resolveMcpLaunch } from "../../mcp-bin.ts";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Codex CLI adapter. Mirrors Claude's Charm session surface:
 *   - unattended: bypass approvals and sandbox
 *   - workspace trust: explicitly trust the launch cwd, including worktrees
 *   - instructions: model_instructions_file (replaces built-ins)
 *   - per-session Charm MCP via -c mcp_servers.charm.*
 *   - native multi-agent tools off (Charm MCP owns fan-out), matching
 *     Claude's Agent/Task strip; Claude Workflow remains separately enabled
 *   - non-orchestrator history isolated via a per-agent CODEX_HOME
 */
export class CodexRuntime implements AgentRuntime {
  readonly kind = "codex" as const;

  prettyModel(id: string): string {
    return prettyModel(id);
  }

  ensureWorkspaceReady(_dir: string): void {
    // Workspace trust is supplied as a per-launch config override in
    // buildCommand. This also covers isolated CODEX_HOME directories and
    // ephemeral worktree paths without mutating the operator's config.
  }

  buildCommand(ctx: LaunchContext): string {
    const { paths, agentId, spec, instructionsFile, persistHistory, reasoningEffort } = ctx;
    const { command: mcpCommand, args: mcpArgs } = resolveMcpLaunch();
    const workDir = spec.cwd ?? paths.root;

    // Shared flags valid on both `codex` (interactive) and `codex exec`.
    const sharedFlags: string[] = [
      "-m",
      shellQuote(spec.model ?? "gpt-5.6-terra"),
      "-C",
      shellQuote(workDir),
      "--dangerously-bypass-approvals-and-sandbox",
      // Recent Codex versions show the directory-trust screen even in dangerous
      // mode. Every isolated CODEX_HOME starts without project state, and
      // worktrees have unique paths, so trust the exact launch cwd in the merged
      // in-memory config. This suppresses the prompt without modifying ~/.codex.
      `-c ${shellQuote(`projects.${tomlString(workDir)}.trust_level="trusted"`)}`,
      `-c ${shellQuote(`model_instructions_file=${instructionsFile}`)}`,
      `-c ${shellQuote(`model_reasoning_effort=${reasoningEffort}`)}`,
      // Charm MCP — same socket/agent identity Claude gets via --mcp-config + env.
      `-c ${shellQuote(`mcp_servers.charm.command=${mcpCommand}`)}`,
      `-c ${shellQuote(`mcp_servers.charm.args=${JSON.stringify(mcpArgs)}`)}`,
      `-c ${shellQuote(
        `mcp_servers.charm.env={CHARM_SOCKET=${tomlString(paths.socket)},CHARM_AGENT_ID=${tomlString(agentId)},CHARM_AGENT_ROLE=${tomlString(spec.role)}}`,
      )}`,
      `-c ${shellQuote("mcp_servers.charm.required=true")}`,
      // Strip Codex native spawn_agent / multi-agent tools so fan-out stays on Charm MCP
      // (parity with Claude --disallowed-tools Agent Task).
      // Use --disable multi_agent (features.multi_agent=false). Do NOT pass
      // -c agents.enabled=false: Codex deserializes [agents] as a map of named
      // AgentRoleToml roles, so a boolean `enabled` key fails with
      // "invalid type: boolean … expected struct AgentRoleToml".
      "--disable",
      "multi_agent",
    ];

    const exports = [
      `export CHARM_AGENT_ID=${shellQuote(agentId)}`,
      `export CHARM_AGENT_ROLE=${shellQuote(spec.role)}`,
      `export CHARM_SOCKET=${shellQuote(paths.socket)}`,
    ];

    // Non-orchestrator agents: isolate CODEX_HOME so transcripts do not land in
    // the operator's ~/.codex/sessions history. Auth is symlinked from the real home.
    if (!persistHistory) {
      const home = prepareIsolatedCodexHome(paths.runDir, agentId);
      exports.push(`export CODEX_HOME=${shellQuote(home)}`);
    }

    if (spec.resume) {
      // Interactive resume path.
      if (spec.resume === "continue") {
        return [...exports, `exec codex resume --last ${sharedFlags.join(" ")}${spec.prompt ? " " + shellQuote(spec.prompt) : ""}`].join(" && ");
      }
      return [
        ...exports,
        `exec codex resume ${shellQuote(spec.resume.uuid)} ${sharedFlags.join(" ")}${spec.prompt ? " " + shellQuote(spec.prompt) : ""}`,
      ].join(" && ");
    }

    if (!spec.interactive) {
      // Headless one-shot — always ephemeral (Charm does not resume testers launched -p).
      const prompt = spec.prompt ? " " + shellQuote(spec.prompt) : "";
      return [
        ...exports,
        `exec codex exec --ephemeral --skip-git-repo-check ${sharedFlags.join(" ")}${prompt}`,
      ].join(" && ");
    }

    // Interactive TUI (workers / investigators / researchers / :so).
    const prompt = spec.prompt ? " " + shellQuote(spec.prompt) : "";
    return [...exports, `exec codex ${sharedFlags.join(" ")}${prompt}`].join(" && ");
  }
}

/** Quote a string for embedding inside a TOML inline table value passed to -c. */
function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Create a per-agent CODEX_HOME under the session run dir with auth symlinked
 * from the operator's real ~/.codex, and an empty sessions/ so history is not
 * shared with the user's Codex picker.
 */
function prepareIsolatedCodexHome(runDir: string, agentId: string): string {
  const home = join(runDir, "codex-homes", agentId);
  mkdirSync(join(home, "sessions"), { recursive: true });
  const realHome = join(homedir(), ".codex");
  for (const name of ["auth.json", "models_cache.json", "version.json", "installation_id"]) {
    const src = join(realHome, name);
    const dst = join(home, name);
    if (existsSync(src) && !existsSync(dst)) {
      try {
        symlinkSync(src, dst);
      } catch {
        // best-effort — auth may already exist from a prior spawn attempt
      }
    }
  }
  // Minimal config so Codex does not inherit the operator's MCP servers /
  // sandbox defaults; Charm passes everything it needs via -c.
  const cfgPath = join(home, "config.toml");
  if (!existsSync(cfgPath)) {
    writeFileSync(
      cfgPath,
      [
        "# Generated by charm — per-agent isolated CODEX_HOME (no session history).",
        "approval_policy = \"never\"",
        "sandbox_mode = \"danger-full-access\"",
        "",
      ].join("\n"),
    );
  }
  return home;
}
