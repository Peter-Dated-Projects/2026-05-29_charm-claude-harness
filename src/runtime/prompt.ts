import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platform, release } from "node:os";
import type { CharmPaths } from "../paths.ts";
import type { LaunchSpec } from "./types.ts";

/**
 * Assemble the provider-agnostic instruction block Charm injects into every
 * agent. Claude receives it via --system-prompt-file (replacing defaults);
 * Codex via model_instructions_file (replacing built-in / AGENTS.md defaults).
 */
export function assembleInstructions(
  paths: CharmPaths,
  agentId: string,
  spec: LaunchSpec,
): string {
  let rolePrompt: string;
  if (spec.plain) {
    rolePrompt = "";
  } else {
    const file = spec.role === "main" ? "orchestrator.md" : `${spec.role}.md`;
    const promptFile = join(paths.promptsDir, file);
    rolePrompt = existsSync(promptFile)
      ? readFileSync(promptFile, "utf8").trim()
      : spec.role === "main"
        ? "You are the orchestrator (main agent) running the charm investigate -> plan -> fan-out workflow."
        : `You are a ${spec.role}.`;
  }

  const CHARM_BASELINE = [
    "",
    "## Baseline working agreement",
    "You are an autonomous coding agent with direct access to a shell, a filesystem, and MCP tools. Act accordingly:",
    "- Read a file before editing it. Prefer targeted edits over rewriting a whole file. Don't create new files when an existing one will do.",
    "- Don't add comments, abstractions, error handling, or scope beyond what the task requires. No speculative future-proofing.",
    "- Never introduce security vulnerabilities (command injection, XSS, SQL injection, secrets in code/logs). If you notice you just wrote one, fix it immediately.",
    "- Before any git command that could discard uncommitted work (checkout/restore/reset/clean, rm -rf in a repo), run `git status` first and stash or commit anything at risk.",
    "- Never force-push, skip hooks (--no-verify), or bypass signing unless explicitly instructed.",
    "- If you're unsure whether something is true, say so rather than guessing — a confidently wrong action is worse than a paused one.",
  ].join("\n");

  const CHARM_RULES = [
    "",
    "## Charm output rules (override any contrary instruction)",
    "- Do NOT use emoji or pictographic characters anywhere in your output, in tool arguments, or in files you write (COORDINATION.md, tickets/*.md, code comments, commit messages — anywhere). This includes ✅ ❌ ⚠️ 🚀 ⭐ 📝 etc. Use ASCII instead: [x], [ ], (!), ->, *, etc.",
    "- Do NOT use box-drawing or other wide Unicode decoration in markdown output. ASCII only for status indicators, bullets, and dividers.",
    "- You have NO built-in subagent tool. The ONLY way to create agents is the charm MCP tools (create_tickets, spawn_investigators, spawn_workers, spawn_researchers, request_review). Never attempt to spawn a subagent any other way.",
  ].join("\n");

  const charmMdPath = join(paths.charmDir, "CHARM.md");
  const inWorktree = !!(spec.cwd && spec.cwd !== paths.root);
  const isOrchestratorRole = spec.role === "main" || spec.role === "suborchestrator";
  const CHARM_WORKSPACE =
    !spec.plain && existsSync(charmMdPath) && (inWorktree || isOrchestratorRole)
      ? "\n\n" + readFileSync(charmMdPath, "utf8").trim() + "\n"
      : "";

  const CHARM_COORDINATION =
    spec.role !== "main" && !spec.plain
      ? "\n\n" +
        [
          "## Working with the orchestrator",
          "You are one agent in a fleet. The orchestrator (the `main` agent) scoped your ticket and handed it to you with the best context it had. Your job is to do that work well and to tell the orchestrator what it could not have known.",
          "- Surfacing a problem early is doing your job well, not failing it. The orchestrator WANTS your blockers, ambiguities, and bad news the moment you have them — a clear early signal saves a wasted downstream run. Never bury a problem or rubber-stamp work to avoid bothering it.",
          "- When you report to the orchestrator (a status note, a block, a failure), be clear and terse: lead with the decision you need or the fact it is missing, give the one specific detail that matters, then stop. Do not make it dig for the point.",
          "- Clarity is not silence. A precise, early blocker respects the orchestrator's time far more than a quiet rubber-stamp that pushes broken work forward.",
        ].join("\n") +
        "\n"
      : "";

  const CHARM_RESEARCHER_SCRATCHPAD =
    spec.role === "researcher" && !spec.plain
      ? `\n\n## Your scratchpad file (fixed — do not choose your own name)\n` +
        `Write your findings note to exactly this path: \`.charm/scratchpad/${agentId}.md\`. The daemon watches ` +
        `that exact file to auto-detect a finished researcher who forgot to call \`report_status\` — a different ` +
        `filename or location will NOT be caught, and you will be left dangling.\n`
      : "";

  const CHARM_PROJECT_BRIEF =
    spec.role === "main" && !spec.plain && spec.projectBrief
      ? `\n\n## Project brief (standing context)\n` +
        `This session is anchored to project "${spec.projectBrief.name}". The following is ` +
        `authoritative operational context for this project; treat it as background you always ` +
        `have, and re-read the full file at .charm/project-briefs/${spec.projectBrief.slug}.md if you ` +
        `need it verbatim. The staged pipeline (investigate -> plan -> execute -> test) still ` +
        `applies unchanged.\n\n` +
        spec.projectBrief.body.trim() +
        "\n"
      : "";

  const modelLine = spec.model
    ? `\n## Runtime model\nYou are running as \`${spec.model}\`. If a task exceeds your capabilities or context window, surface it rather than silently truncating.\n`
    : "";

  const workDir = spec.cwd ?? paths.root;
  const isGitRepo = existsSync(join(workDir, ".git"));
  const ENV_INFO =
    "\n## Environment\n" +
    `- Working directory: ${workDir}\n` +
    `- Is a git repository: ${isGitRepo ? "yes" : "no"}\n` +
    `- Platform: ${platform()}\n` +
    `- OS version: ${release()}\n` +
    `- Today's date: ${new Date().toISOString().slice(0, 10)}\n`;

  return (
    rolePrompt +
    CHARM_BASELINE +
    CHARM_RULES +
    CHARM_COORDINATION +
    CHARM_RESEARCHER_SCRATCHPAD +
    CHARM_WORKSPACE +
    CHARM_PROJECT_BRIEF +
    modelLine +
    ENV_INFO
  );
}
