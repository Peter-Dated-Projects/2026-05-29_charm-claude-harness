import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { charmPaths } from "../paths.ts";
import {
  buildAgentCommand,
  buildClaudeCommand,
  resolveSpawnModel,
  runtimeKindForModel,
  runtimeKindForRole,
  suborchestratorModelForRuntime,
  resolveModel,
  prettyModel,
} from "../runtime/index.ts";

const paths = charmPaths(mkdtempSync(join(tmpdir(), "charm-runtime-")));

test("resolveSpawnModel maps Claude and Codex families", () => {
  expect(resolveSpawnModel("sonnet")).toBe("claude-sonnet-5[1m]");
  expect(resolveSpawnModel("opus", false)).toBe("claude-opus-5");
  expect(resolveSpawnModel("sol")).toBe("gpt-5.6-sol");
  expect(resolveSpawnModel("terra", true)).toBe("gpt-5.6-terra");
  expect(resolveSpawnModel("luna")).toBe("gpt-5.6-luna");
});

test("runtimeKindForRole pins main on Claude; :so follows its model", () => {
  expect(runtimeKindForRole("main", "gpt-5.6-sol")).toBe("claude");
  expect(runtimeKindForRole("suborchestrator", "gpt-5.6-terra")).toBe("codex");
  expect(runtimeKindForRole("suborchestrator", "claude-opus-5")).toBe("claude");
  expect(runtimeKindForRole("worker", "gpt-5.6-sol")).toBe("codex");
  expect(runtimeKindForRole("worker", "claude-opus-5")).toBe("claude");
});

test("runtimeKindForModel classifies ids", () => {
  expect(runtimeKindForModel("gpt-5.6-luna")).toBe("codex");
  expect(runtimeKindForModel("claude-sonnet-5[1m]")).toBe("claude");
  expect(runtimeKindForModel(resolveModel("sol"))).toBe("codex");
});

test("prettyModel labels Codex ids", () => {
  expect(prettyModel("gpt-5.6-sol")).toBe("sol-5.6");
  expect(prettyModel("gpt-5.6-terra")).toBe("terra-5.6");
  expect(prettyModel("gpt-5.6-luna")).toBe("luna-5.6");
});

test("a Codex worker launch uses codex with Charm MCP and no native multi-agent", () => {
  const cmd = buildAgentCommand(paths, "worker-001", {
    role: "worker",
    ticket_id: "T-001",
    prompt: "do the thing",
    interactive: true,
    model: "gpt-5.6-sol",
  });
  expect(cmd).toContain("exec codex ");
  expect(cmd).toContain("-m 'gpt-5.6-sol'");
  expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(cmd).toContain(`projects."${paths.root}".trust_level="trusted"`);
  expect(cmd).toContain("model_instructions_file=");
  expect(cmd).toContain('service_tier="default"');
  expect(cmd).toContain("--disable fast_mode");
  expect(cmd).toContain("mcp_servers.charm.command=");
  expect(cmd).toContain("--disable multi_agent");
  expect(cmd).not.toContain("agents.enabled=");
  expect(cmd).not.toContain(" -a ");
  expect(cmd).toContain("CHARM_AGENT_ID='worker-001'");
  expect(cmd).toContain("export CODEX_HOME=");
  expect(cmd).not.toContain("exec claude ");
  expect(existsSync(join(paths.runDir, "system-prompts", "worker-001.txt"))).toBe(true);
});

test("a Claude worker launch still uses claude and skips history", () => {
  const cmd = buildClaudeCommand(paths, "worker-002", {
    role: "worker",
    ticket_id: "T-001",
    prompt: "do the thing",
    interactive: true,
    model: "claude-opus-5",
  });
  expect(cmd).toContain("exec claude ");
  expect(cmd).toContain("export CLAUDE_CODE_SKIP_PROMPT_HISTORY=1");
  expect(cmd).toContain("--dangerously-skip-permissions");
  expect(cmd).toContain("--disallowed-tools");
  expect(cmd).toContain("Agent");
  expect(cmd).not.toContain("Workflow"); // Workflow stays enabled by default
  // Live model reporting: per-agent --settings installs a statusLine hook that
  // calls `charm report-model` so /model switches update the pane border.
  expect(cmd).toContain("--settings");
  const settingsPath = join(paths.runDir, "agent-settings", "worker-002.json");
  expect(existsSync(settingsPath)).toBe(true);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(settings.statusLine?.type).toBe("command");
  expect(String(settings.statusLine?.command)).toContain("report-model");
  expect(settings.statusLine?.refreshInterval).toBe(2);
});

test("suborchestrator defaults to Claude Sonnet and keeps history", () => {
  const cmd = buildAgentCommand(paths, "suborchestrator-001", {
    role: "suborchestrator",
    ticket_id: null,
    prompt: "",
    interactive: true,
  });
  expect(cmd).toContain("exec claude ");
  expect(cmd).toContain("--model 'claude-sonnet-5[1m]'");
  expect(cmd).not.toContain("CLAUDE_CODE_SKIP_PROMPT_HISTORY");
  const prompt = readFileSync(join(paths.runDir, "system-prompts", "suborchestrator-001.txt"), "utf8");
  expect(prompt).toContain("claude-sonnet-5[1m]");
});

test("suborchestrator runtime selection maps Claude to Sonnet and GPT to Terra", () => {
  expect(suborchestratorModelForRuntime()).toBe("claude-sonnet-5[1m]");
  expect(suborchestratorModelForRuntime("claude")).toBe("claude-sonnet-5[1m]");
  expect(suborchestratorModelForRuntime("codex")).toBe("gpt-5.6-terra");
});

test("runtimeKindForRole always hosts the cursor role on the Cursor runtime", () => {
  expect(runtimeKindForRole("cursor", "cursor")).toBe("cursor");
  // Even if some concrete model id leaks in, the cursor role stays on Cursor.
  expect(runtimeKindForRole("cursor", "claude-opus-5")).toBe("cursor");
  expect(runtimeKindForRole("cursor", "gpt-5.6-terra")).toBe("cursor");
});

test("a Cursor specialist launch is a bare Cursor CLI with workspace trust and no Charm wiring", () => {
  const cmd = buildAgentCommand(paths, "cursor-001", {
    role: "cursor",
    ticket_id: null,
    prompt: "",
    interactive: true,
  });
  // Launches the Cursor CLI (agent, with cursor-agent fallback) in the root,
  // trusting the workspace.
  expect(cmd).toContain("exec agent ");
  expect(cmd).toContain("exec cursor-agent ");
  expect(cmd).toContain(`--workspace '${paths.root}'`);
  expect(cmd).toContain("--trust");
  // Cursor uses its own default model — no --model is pinned.
  expect(cmd).not.toContain("--model");
  // Crucially: NONE of Charm's fleet wiring reaches the Cursor session.
  expect(cmd).not.toContain("--mcp-config");
  expect(cmd).not.toContain("mcp_servers.charm");
  expect(cmd).not.toContain("--approve-mcps");
  expect(cmd).not.toContain("--system-prompt-file");
  expect(cmd).not.toContain("model_instructions_file");
  expect(cmd).not.toContain(paths.socket);
  expect(cmd).not.toContain("CHARM_AGENT_ID");
  expect(cmd).not.toContain("CHARM_SOCKET");
  expect(cmd).not.toContain("CHARM_AGENT_ROLE");
  // Not a Claude/Codex process.
  expect(cmd).not.toContain("exec claude ");
  expect(cmd).not.toContain("exec codex ");
});

test("Codex headless uses exec --ephemeral", () => {
  const cmd = buildAgentCommand(paths, "tester-001", {
    role: "tester",
    ticket_id: "T-001",
    prompt: "validate",
    interactive: false,
    model: "gpt-5.6-luna",
  });
  expect(cmd).toContain("exec codex exec --ephemeral");
});
