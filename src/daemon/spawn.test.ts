import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { charmPaths } from "../paths.ts";
import { buildClaudeCommand } from "./spawn.ts";

/**
 * The headless/interactive contract for buildClaudeCommand: `interactive: false`
 * adds the `-p` (one-shot print) flag, `interactive: true` omits it (a resumable
 * session). These pin that pure mapping regardless of role. NOTE: the daemon now
 * spawns ALL sub-agent roles — reviewers and testers included — interactively, so
 * they can report_status('blocked') and be resumed via continue_agent when stuck;
 * the trade-off is that an interactive agent must self-report a terminal state so
 * the orchestrator reaps its otherwise-idle pane. The `false` cases below exercise
 * the flag mapping, not how any role is actually launched.
 */

const paths = charmPaths(tmpdir());

function cmd(role: "reviewer" | "tester" | "worker", interactive: boolean): string {
  return buildClaudeCommand(paths, `${role}-001`, {
    role,
    ticket_id: "T-001",
    prompt: "do the thing",
    interactive,
  });
}

test("a headless (non-interactive) spawn launches claude with -p", () => {
  expect(cmd("reviewer", false)).toContain("claude -p ");
  expect(cmd("tester", false)).toContain("claude -p ");
});

test("an interactive spawn does NOT pass -p", () => {
  // Worker (and any interactive role) opens a resumable session, not a one-shot
  // print run.
  expect(cmd("worker", true)).not.toContain("claude -p ");
});

test("every spawn carries the agent id and mints a session id", () => {
  const c = cmd("reviewer", false);
  expect(c).toContain("CHARM_AGENT_ID='reviewer-001'");
  expect(c).toContain("--session-id");
});
