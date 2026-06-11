import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { charmPaths } from "../paths.ts";
import { buildClaudeCommand } from "./spawn.ts";

/**
 * The headless/interactive contract. Reviewers and testers are one-shot roles
 * spawned headless (`-p`) so they run, report, and EXIT — an interactive spawn
 * would linger idle in its pane and never be seen `done` by the liveness sweep
 * (the original reviewer bug). Workers stay interactive so the orchestrator can
 * resume them with continue_agent. These pin that `interactive` maps to the
 * presence/absence of the `-p` flag in the launched command.
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
