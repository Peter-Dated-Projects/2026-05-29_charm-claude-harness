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
  resolveModel,
  prettyModel,
} from "../runtime/index.ts";

const paths = charmPaths(mkdtempSync(join(tmpdir(), "charm-runtime-")));

test("resolveSpawnModel maps Claude and Codex families", () => {
  expect(resolveSpawnModel("sonnet")).toBe("claude-sonnet-5[1m]");
  expect(resolveSpawnModel("opus", false)).toBe("claude-opus-4-8");
  expect(resolveSpawnModel("sol")).toBe("gpt-5.6-sol");
  expect(resolveSpawnModel("terra", true)).toBe("gpt-5.6-terra");
  expect(resolveSpawnModel("luna")).toBe("gpt-5.6-luna");
});

test("runtimeKindForRole pins main on Claude; :so follows its model", () => {
  expect(runtimeKindForRole("main", "gpt-5.6-sol")).toBe("claude");
  expect(runtimeKindForRole("suborchestrator", "gpt-5.6-terra")).toBe("codex");
  expect(runtimeKindForRole("suborchestrator", "claude-opus-4-8")).toBe("claude");
  expect(runtimeKindForRole("worker", "gpt-5.6-sol")).toBe("codex");
  expect(runtimeKindForRole("worker", "claude-opus-4-8")).toBe("claude");
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
  expect(cmd).toContain("-s danger-full-access");
  expect(cmd).toContain('approval_policy="never"');
  expect(cmd).toContain("model_instructions_file=");
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
    model: "claude-opus-4-8",
  });
  expect(cmd).toContain("exec claude ");
  expect(cmd).toContain("export CLAUDE_CODE_SKIP_PROMPT_HISTORY=1");
  expect(cmd).toContain("--disallowed-tools");
  expect(cmd).toContain("Agent");
  expect(cmd).not.toContain("Workflow"); // Workflow stays enabled by default
});

test("suborchestrator defaults to Codex terra and keeps history", () => {
  const cmd = buildAgentCommand(paths, "suborchestrator-001", {
    role: "suborchestrator",
    ticket_id: null,
    prompt: "",
    interactive: true,
  });
  expect(cmd).toContain("exec codex ");
  expect(cmd).toContain("-m 'gpt-5.6-terra'");
  expect(cmd).toContain("model_reasoning_effort=high");
  expect(cmd).not.toContain("export CODEX_HOME="); // history kept for :so resume
  expect(cmd).not.toContain("CLAUDE_CODE_SKIP_PROMPT_HISTORY");
  const prompt = readFileSync(join(paths.runDir, "system-prompts", "suborchestrator-001.txt"), "utf8");
  expect(prompt).toContain("gpt-5.6-terra");
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
