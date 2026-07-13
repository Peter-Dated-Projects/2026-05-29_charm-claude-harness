import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { charmPaths } from "../paths.ts";
import { buildClaudeCommand, resolveSpawnModel } from "./spawn.ts";

/**
 * The headless/interactive contract for buildClaudeCommand: `interactive: false`
 * adds the `-p` (one-shot print) flag, `interactive: true` omits it (a resumable
 * session). These pin that pure mapping regardless of role. NOTE: the daemon now
 * spawns ALL sub-agent roles — investigators and testers included — interactively, so
 * they can report_status('blocked') and be resumed via continue_agent when stuck;
 * the trade-off is that an interactive agent must self-report a terminal state so
 * the daemon reaps its otherwise-idle pane. The `false` cases below exercise
 * the flag mapping, not how any role is actually launched.
 */

const paths = charmPaths(tmpdir());

function cmd(role: "investigator" | "tester" | "worker", interactive: boolean): string {
  return buildClaudeCommand(paths, `${role}-001`, {
    role,
    ticket_id: "T-001",
    prompt: "do the thing",
    interactive,
  });
}

test("a headless (non-interactive) spawn launches claude with -p", () => {
  expect(cmd("investigator", false)).toContain("claude -p ");
  expect(cmd("tester", false)).toContain("claude -p ");
});

test("an interactive spawn does NOT pass -p", () => {
  // Worker (and any interactive role) opens a resumable session, not a one-shot
  // print run.
  expect(cmd("worker", true)).not.toContain("claude -p ");
});

test("every spawn carries the agent id and mints a session id", () => {
  const c = cmd("investigator", false);
  expect(c).toContain("CHARM_AGENT_ID='investigator-001'");
  expect(c).toContain("--session-id");
});

/**
 * Transcript persistence is role-gated: sub-agents (worker/investigator/tester/
 * researcher) run one bounded task and are never resumed, so charm suppresses
 * their Claude Code transcript via CLAUDE_CODE_SKIP_PROMPT_HISTORY=1. The
 * orchestrator (main/suborchestrator) and plain human windows must KEEP their
 * transcript — `charm resume` reattaches to the orchestrator's on disk.
 */
test("sub-agent spawns skip Claude Code transcript persistence", () => {
  for (const role of ["worker", "investigator", "tester"] as const) {
    expect(cmd(role, true)).toContain("export CLAUDE_CODE_SKIP_PROMPT_HISTORY=1");
  }
});

test("the orchestrator keeps its transcript (needed for resume)", () => {
  const main = buildClaudeCommand(paths, "main-001", { role: "main", interactive: true });
  const sub = buildClaudeCommand(paths, "suborchestrator-001", { role: "suborchestrator", interactive: true });
  expect(main).not.toContain("CLAUDE_CODE_SKIP_PROMPT_HISTORY");
  expect(sub).not.toContain("CLAUDE_CODE_SKIP_PROMPT_HISTORY");
});

test("a plain human window keeps its transcript", () => {
  const plain = buildClaudeCommand(paths, "worker-001", { role: "worker", plain: true, interactive: true });
  expect(plain).not.toContain("CLAUDE_CODE_SKIP_PROMPT_HISTORY");
});

/**
 * resolveSpawnModel maps the caller-facing families (sonnet/haiku/opus) to concrete
 * model ids, defaulting to the 1M-token window (the preferred window) and appending
 * `[1m]` only for families that offer one.
 */
test("resolveSpawnModel defaults to the 1M window for families that support it", () => {
  expect(resolveSpawnModel("sonnet")).toBe("claude-sonnet-5[1m]");
  expect(resolveSpawnModel("opus")).toBe("claude-opus-4-8[1m]");
});

test("resolveSpawnModel drops the 1M window when context1m is false", () => {
  expect(resolveSpawnModel("sonnet", false)).toBe("claude-sonnet-5");
  expect(resolveSpawnModel("opus", false)).toBe("claude-opus-4-8");
});

test("resolveSpawnModel never appends [1m] to a family without a 1M window", () => {
  // Haiku 4.5 has no 1M variant: a 1M request must NOT produce a bogus `...[1m]` id.
  expect(resolveSpawnModel("haiku")).toBe("claude-haiku-4-5-20251001");
  expect(resolveSpawnModel("haiku", true)).toBe("claude-haiku-4-5-20251001");
  expect(resolveSpawnModel("haiku", false)).toBe("claude-haiku-4-5-20251001");
});

/**
 * Project-brief injection: buildClaudeCommand writes the assembled system prompt
 * to <runDir>/system-prompts/<agent_id>.txt and references it via
 * --system-prompt-file. These read that file back to pin that the brief reaches
 * the orchestrator's system prompt (not the kickoff message), is scoped to the
 * main agent only, and is skipped for a plain window.
 */
const BRIEF = { name: "Owner App", slug: "owner-app", body: "The standing operational context." };

function promptFor(role: "main" | "worker", opts: { plain?: boolean; brief?: typeof BRIEF }): string {
  const p = charmPaths(mkdtempSync(join(tmpdir(), "charm-brief-inject-")));
  const id = `${role}-001`;
  buildClaudeCommand(p, id, {
    role,
    ticket_id: role === "main" ? null : "T-001",
    prompt: "",
    interactive: true,
    plain: opts.plain,
    projectBrief: opts.brief,
  });
  return readFileSync(join(p.runDir, "system-prompts", `${id}.txt`), "utf8");
}

test("the project brief is injected into the orchestrator's system prompt", () => {
  const sp = promptFor("main", { brief: BRIEF });
  expect(sp).toContain("## Project brief (standing context)");
  expect(sp).toContain('project "Owner App"');
  expect(sp).toContain(".charm/project-briefs/owner-app.md");
  expect(sp).toContain("The standing operational context.");
});

test("the project brief is NOT injected for a sub-agent", () => {
  // Briefs are orchestrator-scoped; a worker gets scoped tickets instead.
  const sp = promptFor("worker", { brief: BRIEF });
  expect(sp).not.toContain("## Project brief (standing context)");
});

test("a plain window drops the project brief", () => {
  const sp = promptFor("main", { plain: true, brief: BRIEF });
  expect(sp).not.toContain("## Project brief (standing context)");
});
