import { join } from "node:path";
import { homedir, platform, release } from "node:os";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { CharmPaths } from "../paths.ts";
import type { AgentRole } from "../schema.ts";

/** The orchestrator always runs under this fixed agent id. It is spawned directly by
 *  `charm start` (not through the registry's auto-incrementing sub-agent sequence), so
 *  no investigator/worker/tester can ever collide with it. The kill path treats this id as
 *  protected: no caller — not the orchestrator itself, not a sub-agent, not the human
 *  operator — may terminate it via kill_agent. */
export const MAIN_AGENT_ID = "main-001";

export type SpawnSpec = {
  role: AgentRole;
  ticket_id: string | null;
  prompt: string;
  interactive: boolean;
  /** Resolved Claude Code model id (e.g. "claude-opus-4-8", "claude-sonnet-5[1m]").
   *  When set, passed via `--model` and surfaced to the agent in its system prompt
   *  so it knows which model it is running as. */
  model?: string;
  /** When true, omit the role-specific system prompt: a "plain" Claude window
   *  that's still wired to the charm MCP config and output rules, but carries
   *  no orchestration instructions. Used by `charm start` with no goal. */
  plain?: boolean;
  /** Working directory for this agent. Defaults to repo root (shared tree). Set to a worktree path to isolate the agent in its own `git worktree` (own working tree + branch, sharing the main repo's object store). */
  cwd?: string;
  /** Claude-side session UUID, passed to `claude --session-id <uuid>` so charm
   *  owns (rather than discovers) the conversation id. Recorded on the registry
   *  entry and — for the orchestrator — persisted to its own run-dir file so the
   *  operator can later `charm resume` that conversation. When omitted,
   *  buildClaudeCommand mints a fresh one; callers that need to record the id
   *  should pass it in explicitly (see newClaudeSessionId). */
  claudeSessionId?: string;
  /** Relaunch an EXISTING conversation instead of starting a fresh one (used by
   *  `charm resume`). When set, the command swaps `--session-id <new>` for a
   *  resume flag and drops the positional prompt (the conversation already has
   *  its history), while keeping every other flag — model, permission mode,
   *  --mcp-config, --system-prompt — identical to the original spawn:
   *    - { uuid }     -> `claude --resume <uuid>`   (resume a specific session)
   *    - "continue"   -> `claude --continue`        (resume the most recent) */
  resume?: { uuid: string } | "continue";
};

/** Mint a fresh Claude-side session UUID for a spawn. Callers generate this up
 *  front (rather than letting buildClaudeCommand default it internally) when they
 *  need to record the id on the registry / in meta.json — the value passed to
 *  `--session-id` must match the one charm stores for `charm resume` to work. */
export function newClaudeSessionId(): string {
  return randomUUID();
}

/** User-facing aliases resolved to Claude Code model ids. Kept aligned with the
 *  current lineup: Sonnet 5, Haiku 4.5, Opus 4.7/4.8, Fable 5. The `-1m` keys select
 *  the 1M-token window; only families that offer one have a `-1m` variant (Haiku and
 *  Fable don't). The bare `sonnet`/`haiku`/`opus` aliases point at the latest of each. */
export const MODEL_ALIASES: Record<string, string> = {
  "sonnet-5": "claude-sonnet-5",
  "sonnet-5-1m": "claude-sonnet-5[1m]",
  "haiku-4.5": "claude-haiku-4-5-20251001",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.7-1m": "claude-opus-4-7[1m]",
  "opus-4.8": "claude-opus-4-8",
  "opus-4.8-1m": "claude-opus-4-8[1m]",
  "fable-5": "claude-fable-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
  opus: "claude-opus-4-8",
};

/** Friendly model families a caller can request per-spawn on the spawn_* tools,
 *  independent of the fleet/role defaults. Each maps to its base Claude Code model
 *  id plus whether that family offers a 1M-token context window. The `[1m]` suffix
 *  is only appended (see resolveSpawnModel) when the family supports it — Haiku 4.5
 *  has no 1M variant, so a 1M request on Haiku silently resolves to the plain id
 *  rather than a bogus `...[1m]` that the CLI would reject. */
export const SPAWN_MODEL_FAMILIES = {
  sonnet: { base: "claude-sonnet-5", supports1m: true },
  haiku: { base: "claude-haiku-4-5-20251001", supports1m: false },
  opus: { base: "claude-opus-4-8", supports1m: true },
} as const;

export type SpawnModelFamily = keyof typeof SPAWN_MODEL_FAMILIES;

/** Resolve a caller-supplied spawn model family + 1M toggle to a concrete Claude
 *  Code model id. `context1m` defaults to true (the preferred window) and is honored
 *  only for families that actually offer a 1M window. */
export function resolveSpawnModel(family: SpawnModelFamily, context1m: boolean = true): string {
  const spec = SPAWN_MODEL_FAMILIES[family];
  return context1m && spec.supports1m ? `${spec.base}[1m]` : spec.base;
}

/** The model each agent role runs on, keyed to the kind of work it does. Every
 *  role has a fixed default here — there is no fleet "mode" anymore, so this map
 *  IS the per-type model assignment:
 *    coding (worker)        -> Opus 4.8 [1M ctx]   (writing/shipping code; biggest model + window)
 *    investigation          -> Opus 4.8            (deep reasoning over the codebase)
 *    review (tester)        -> Sonnet 5            (validation; fast and cheap)
 *    research (researcher)  -> Sonnet 5 [1M ctx]   (broad context-gathering over lots of material)
 *    main                   -> Opus 4.8 [1M ctx]   (the reasoning-heavy coordinator; long-lived session)
 *    suborchestrator        -> Opus 4.8            (the reasoning-heavy coordinator)
 *  Override per-role with CHARM_MODEL_<ROLE> (e.g. CHARM_MODEL_WORKER=opus-4.7),
 *  or the whole fleet at once with `charm start -m/--model` (CHARM_MODEL). */
export const DEFAULT_MODEL_BY_ROLE: Record<AgentRole, string> = {
  main: "opus-4.8-1m",
  investigator: "opus-4.8",
  worker: "opus-4.8-1m",
  tester: "sonnet-5",
  researcher: "sonnet-5-1m",
  suborchestrator: "opus-4.8",
};

/** Resolve the model for a spawned agent role. Precedence, highest first:
 *    1. CHARM_MODEL_<ROLE> env override (explicit per-role escape, e.g.
 *       CHARM_MODEL_WORKER=opus-4.7).
 *    2. CHARM_MODEL fleet-wide override (`charm start -m/--model`) — a deliberate
 *       operator choice to run the whole fleet on one model.
 *    3. DEFAULT_MODEL_BY_ROLE — the per-type model for the role. */
export function defaultModelForRole(role: AgentRole): string {
  const roleOverride = process.env[`CHARM_MODEL_${role.toUpperCase()}`];
  if (roleOverride) return resolveModel(roleOverride);
  const fleetOverride = process.env.CHARM_MODEL;
  if (fleetOverride) return resolveModel(fleetOverride);
  return resolveModel(DEFAULT_MODEL_BY_ROLE[role]);
}

/** Thinking-token budgets passed as MAX_THINKING_TOKENS to each claude process.
 *
 *  "max" is reserved for the main agent (investigation synthesis + planning): the
 *  graph decomposition problem benefits from the largest available reasoning budget.
 *  Sub-agents default to "high". Override globally with CHARM_THINKING or
 *  per-role with CHARM_THINKING_<ROLE> (e.g. CHARM_THINKING_WORKER=medium). */
export const THINKING_BUDGETS: Record<string, number> = {
  off: 0,
  low: 4000,
  medium: 10000,
  high: 32000,
  max: 64000,
};

/** Per-role thinking defaults. main gets "max"; everything else gets "high". */
export const DEFAULT_THINKING_BY_ROLE: Record<AgentRole, string> = {
  main: "max",
  investigator: "high",
  worker: "high",
  tester: "high",
  researcher: "high",
  suborchestrator: "max",
};

/** Global thinking floor from CHARM_THINKING (applies to roles that don't have a
 *  per-role override). "high" if not set. */
export function defaultThinkingTokens(): number {
  const level = (process.env.CHARM_THINKING ?? "high").toLowerCase();
  return THINKING_BUDGETS[level] ?? THINKING_BUDGETS.high!;
}

/** Resolve thinking-token budget for a specific role. Precedence:
 *    1. CHARM_THINKING_<ROLE> env override (e.g. CHARM_THINKING_MAIN=high)
 *    2. DEFAULT_THINKING_BY_ROLE (main=max, others=high)
 *  The global CHARM_THINKING env var is NOT consulted here — use CHARM_THINKING_<ROLE>
 *  to tune individual roles without affecting the fleet default. */
export function defaultThinkingForRole(role: AgentRole): number {
  const override = (process.env[`CHARM_THINKING_${role.toUpperCase()}`] ?? "").toLowerCase();
  const level = override || DEFAULT_THINKING_BY_ROLE[role] || "high";
  return THINKING_BUDGETS[level] ?? THINKING_BUDGETS.high!;
}

/** Permission modes accepted by `claude --permission-mode`. Spawned agents run unattended
 *  in tmux panes, so they default to `auto` (skips permission prompts). Override per
 *  environment via CHARM_PERMISSION_MODE; an unrecognized value falls back to `auto`. */
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

/** Whether the built-in Workflow tool is left enabled for spawned agents.
 *  Off by default: charm normally strips Workflow (see buildClaudeCommand) so all
 *  fan-out goes through charm's MCP tools. `charm start --workflow-enable` sets
 *  CHARM_WORKFLOW_ENABLE=1 on the daemon (and the CLI's own env), which this reads
 *  so the whole fleet — orchestrator and every sub-agent — keeps the Workflow tool. */
export function workflowEnabled(): boolean {
  return process.env.CHARM_WORKFLOW_ENABLE === "1";
}

/** Resolve a user-supplied --model value to a real Claude model id.
 *  Accepts either an alias from MODEL_ALIASES or a literal `claude-*` id. */
export function resolveModel(input: string): string {
  const v = input.trim();
  if (MODEL_ALIASES[v]) return MODEL_ALIASES[v]!;
  if (v.startsWith("claude-")) return v;
  const choices = Object.keys(MODEL_ALIASES).join(", ");
  throw new Error(`unknown --model "${input}". Use one of: ${choices} (or a raw claude-* id)`);
}

/** Build the shell command that the tmux pane will run.
 *  CHARM_AGENT_ID is exported so the MCP shim can identify the agent. */
export function buildClaudeCommand(paths: CharmPaths, agent_id: string, spec: SpawnSpec): string {
  // Resolve the role's system prompt: every role loads a single `<role>.md`. The
  // orchestrator (`main`) has no `main.md` — its file is `orchestrator.md`, the
  // complete orchestrator prompt: the top-level gated-pipeline frame (including the
  // hard rule that no worker fan-out happens before the investigation findings are
  // synthesized and the plan approved) AND the detail for the two stages it runs
  // directly (kicking off investigation, then synthesizing findings into worker
  // tickets) plus fleet management. (It used to be assembled from orchestrator.md +
  // planner.md; those were merged into one file.) Missing file -> a one-line stub.
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
  // Baseline agentic-coding behavior. `--system-prompt` (below) REPLACES
  // Claude Code's default system prompt rather than layering on top of it, so
  // none of its "how to write/edit code well" guidance reaches the model
  // unless charm restates it. Kept short and role-agnostic — the per-role
  // file carries the actual job; this is just the floor every role needs
  // regardless of what it's doing. Applied unconditionally, including `plain`.
  const CHARM_BASELINE = [
    "",
    "## Baseline working agreement",
    "You are Claude, working as an autonomous coding agent with direct access to a shell, a filesystem, and MCP tools. Act accordingly:",
    "- Read a file before editing it. Prefer targeted edits over rewriting a whole file. Don't create new files when an existing one will do.",
    "- Don't add comments, abstractions, error handling, or scope beyond what the task requires. No speculative future-proofing.",
    "- Never introduce security vulnerabilities (command injection, XSS, SQL injection, secrets in code/logs). If you notice you just wrote one, fix it immediately.",
    "- Before any git command that could discard uncommitted work (checkout/restore/reset/clean, rm -rf in a repo), run `git status` first and stash or commit anything at risk.",
    "- Never force-push, skip hooks (--no-verify), or bypass signing unless explicitly instructed.",
    "- If you're unsure whether something is true, say so rather than guessing — a confidently wrong action is worse than a paused one.",
  ].join("\n");
  // The charm renders agent-produced markdown (COORDINATION.md, tickets/*.md)
  // inside an Ink TUI. Terminal emoji rendering inflates row
  // height inconsistently across fonts/terminals, which breaks the layout —
  // so forbid emojis in every artifact agents write.
  const CHARM_RULES = [
    "",
    "## Charm output rules (override any contrary instruction)",
    "- Do NOT use emoji or pictographic characters anywhere in your output, in tool arguments, or in files you write (COORDINATION.md, tickets/*.md, code comments, commit messages — anywhere). This includes ✅ ❌ ⚠️ 🚀 ⭐ 📝 etc. Use ASCII instead: [x], [ ], (!), ->, *, etc.",
    "- Do NOT use box-drawing or other wide Unicode decoration in markdown output. ASCII only for status indicators, bullets, and dividers.",
    "- You have NO built-in subagent tool (no Agent/Task tool). The ONLY way to create agents is the charm MCP tools (create_tickets, spawn_investigators, spawn_workers, spawn_researchers, request_review). Never attempt to spawn a subagent any other way.",
  ].join("\n");
  // Operator skills router — injected only for the main agent (orchestrator).
  // Restart/reset-kb are operator actions; the router scopes the *guidance* to the
  // orchestrator so a worker or investigator is never told to run them. The skills
  // themselves ship in the `charm` Claude Code plugin (charm:charm-restart,
  // charm:charm-reset-kb); the router lists trigger -> skill name and the agent
  // invokes it on demand. Sub-agents (and plain windows) never see this section.
  const skillsIndex = join(paths.skillsDir, "INDEX.md");
  const CHARM_SKILLS =
    (spec.role === "main" || spec.role === "suborchestrator") && !spec.plain && existsSync(skillsIndex)
      ? "\n## Charm operator skills (invoke on demand)\n" +
        "When the user asks you to perform one of the operator actions below, FIRST invoke the listed skill " +
        "(via the Skill tool) and follow it exactly — including any confirmation gates — before acting.\n\n" +
        readFileSync(skillsIndex, "utf8").trim() +
        "\n"
      : "";
  // The shared workspace guardrails (.charm/CHARM.md) normally are NOT appended
  // here. They reach every agent file-based instead: `charm init` makes the
  // project's root CLAUDE.md import `@.charm/CHARM.md`, and Claude Code natively
  // loads that root CLAUDE.md for any session whose cwd is the repo root.
  // Appending here too would double-inject the same content, so for a shared-tree
  // spawn (cwd === repo root) we rely solely on the import.
  //
  // A WORKTREE spawn breaks that assumption: its cwd is the worktree checkout, not
  // the repo root, and .charm/CHARM.md is gitignored (see .charm/.gitignore — only
  // kb/proposals/scratchpad/skills are re-included) so `git worktree add` never
  // checks it out. The worktree's root CLAUDE.md is tracked and loads, but its
  // `@.charm/CHARM.md` import resolves to a missing file — the guardrails go dark.
  // So when (and only when) the agent runs in a worktree, append the main repo's
  // CHARM.md directly, by absolute path, restoring the same guardrails without
  // double-injecting in the shared-tree case.
  const charmMdPath = join(paths.charmDir, "CHARM.md");
  const CHARM_WORKSPACE =
    spec.cwd && !spec.plain && existsSync(charmMdPath)
      ? "\n\n" + readFileSync(charmMdPath, "utf8").trim() + "\n"
      : "";
  // Shared coordination ethos for every sub-agent (worker / investigator / tester) —
  // NOT the orchestrator (which carries the other side of this in orchestrator.md)
  // and NOT plain windows. Injected from this single place so the three roles stay
  // in sync rather than drifting across their separate prompt files. It does two
  // things on purpose: (1) gives explicit psychological safety to escalate —
  // surfacing a blocker/failure early is the job, not a failure of it — because the
  // system's main failure mode is an agent burying a problem and rubber-stamping
  // broken work forward; (2) sets a clarity norm for talking to the orchestrator so
  // escalations are terse and decision-first. The "clarity is not silence" line
  // reconciles the two so "be terse" never collapses into "stay quiet."
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
  const modelLine = spec.model
    ? `\n## Runtime model\nYou are running as \`${spec.model}\`. If a task exceeds your capabilities or context window, surface it rather than silently truncating.\n`
    : "";
  // `--system-prompt` (below) REPLACES Claude Code's default system prompt
  // outright, so none of the dynamic context it normally injects (cwd, git
  // status, platform, today's date) reaches the model unless charm supplies an
  // equivalent block itself. Without this, a spawned agent has no idea what
  // day it is or whether its cwd is a git repo short of running `pwd`/`date`/
  // `git status` first. Applied unconditionally, including `plain` windows --
  // a goal-less `charm start` window loses Claude Code's default persona
  // entirely under this flag, so it needs this block just as much as any
  // orchestrated role does.
  const workDir = spec.cwd ?? paths.root;
  const isGitRepo = existsSync(join(workDir, ".git"));
  const ENV_INFO =
    "\n## Environment\n" +
    `- Working directory: ${workDir}\n` +
    `- Is a git repository: ${isGitRepo ? "yes" : "no"}\n` +
    `- Platform: ${platform()}\n` +
    `- OS version: ${release()}\n` +
    `- Today's date: ${new Date().toISOString().slice(0, 10)}\n`;
  const systemPrompt =
    rolePrompt +
    CHARM_BASELINE +
    CHARM_RULES +
    CHARM_COORDINATION +
    CHARM_SKILLS +
    CHARM_WORKSPACE +
    modelLine +
    ENV_INFO;
  const flags: string[] = [];
  if (!spec.interactive) flags.push("-p");
  // Conversation identity. A fresh spawn launches under a charm-owned
  // `--session-id <uuid>` so the id can be resumed later; a resume relaunch
  // instead reattaches to an existing conversation (`--resume <uuid>` or
  // `--continue`) and must NOT pass --session-id (claude rejects creating a
  // session that already exists). Either way every other flag below is identical,
  // which is the whole point — a resumed orchestrator keeps the same MCP config,
  // system prompt, model, and permission mode it was first spawned with.
  if (spec.resume) {
    if (spec.resume === "continue") flags.push("--continue");
    else flags.push("--resume", shellQuote(spec.resume.uuid));
  } else {
    const claudeSessionId = spec.claudeSessionId ?? newClaudeSessionId();
    flags.push("--session-id", shellQuote(claudeSessionId));
  }
  if (spec.model) flags.push("--model", shellQuote(spec.model));
  // Spawned agents run unattended in tmux panes, so they must not stall on permission
  // prompts. Default to `auto` (skips prompts); overridable via CHARM_PERMISSION_MODE.
  flags.push("--permission-mode", shellQuote(defaultPermissionMode()));
  // `--mcp-config` is variadic (`<configs...>`) — commander slurps every
  // following positional until the next flag. Put it FIRST so the next flag
  // (`--disallowed-tools`) terminates the list, otherwise the user prompt
  // gets eaten as a phantom MCP config path.
  flags.push("--mcp-config", shellQuote(paths.sessionMcpConfig));
  // Strip every built-in tool that can spawn agents OUTSIDE charm's orchestration,
  // so all fan-out must go through the charm MCP tools (spawn_workers /
  // spawn_investigators / request_review) the daemon needs for dependency +
  // file-scope enforcement:
  //   - Agent       — the native subagent tool (current name in Claude Code).
  //   - Task        — its older alias; harmless to keep listed for older CLIs.
  //   - Workflow    — multi-agent orchestration that fans out subagents via
  //                   agent()/parallel()/pipeline(); a SECOND spawn path that
  //                   `--disallowed-tools Agent` alone does NOT remove. Verified
  //                   against Claude Code 2.1.161: blocked agents otherwise
  //                   offer to "run it as a Workflow instead", bypassing charm.
  // `--disallowed-tools` is variadic, so the next flag (`--system-prompt`)
  // terminates the list. This is a hard, API-level removal (the tools leave the
  // schema), not a prompt request — the model cannot call them even if told to.
  // NOTE: this does not close the Bash escape hatch (an agent can still run
  // `claude` itself via Bash); that is only closable by sandboxing Bash, which
  // workers need. The flag covers the built-in tools, which is the real exposure.
  //
  // Workflow is the one exception: `charm start --workflow-enable` (CHARM_WORKFLOW_ENABLE=1)
  // deliberately keeps it for the whole fleet, opting into that second fan-out path.
  // Agent/Task are always stripped regardless.
  const disallowedTools = ["Agent", "Task"];
  if (!workflowEnabled()) disallowedTools.push("Workflow");
  flags.push("--disallowed-tools", ...disallowedTools.map((t) => shellQuote(t)));
  // `--system-prompt-file` REPLACES Claude Code's default system prompt entirely
  // (unlike `--append-system-prompt`, which layers on top of it). Charm's
  // assembled prompt is deliberately self-contained — role prompt + charm rules
  // + coordination ethos + skills + workspace guardrails + the ENV_INFO block
  // above — so a spawned agent's entire instruction set is what charm wrote,
  // with no competing default persona/tool-use text to dilute it.
  //
  // We pass it as a FILE, not inline (`--system-prompt '<...>'`): the assembled
  // prompt is ~26KB, and every agent launch is a tmux command (`split-window` /
  // `respawn-pane` / `new-session`). tmux caps a single command at ~16KB and
  // rejects anything larger with "command too long" — so an inline prompt this
  // size fails EVERY spawn, and `charm resume` (which rebuilds the same command)
  // with it. Writing the prompt to a per-agent file under the session's run dir
  // and passing only its path keeps the launched command tiny (<1KB) and well
  // under the limit. The file lives beside the session so it's cleaned up with
  // the run and is trivially inspectable when debugging a spawn.
  const promptDir = join(paths.runDir, "system-prompts");
  mkdirSync(promptDir, { recursive: true });
  const promptFile = join(promptDir, `${agent_id}.txt`);
  writeFileSync(promptFile, systemPrompt);
  flags.push("--system-prompt-file", shellQuote(promptFile));
  // An empty prompt means a blank interactive window (e.g. `charm start` with
  // no goal): omit the positional so Claude opens waiting for user input. A
  // resume relaunch also omits it — the conversation already carries its history,
  // so re-injecting the original goal would re-run it.
  if (spec.prompt && !spec.resume) flags.push(shellQuote(spec.prompt));
  // export agent id, then exec claude
  const thinking = defaultThinkingForRole(spec.role);
  return [
    `export CHARM_AGENT_ID=${shellQuote(agent_id)}`,
    // The agent's role, exported so operator-only CLI commands (charm restart /
    // reset-kb) can hard-refuse when invoked by a sub-agent — the operator skills
    // ship globally in the charm plugin, so a worker/investigator has them in its
    // skill list but must never run the destructive op. Unset for the human terminal.
    `export CHARM_AGENT_ROLE=${shellQuote(spec.role)}`,
    `export CHARM_SOCKET=${shellQuote(paths.socket)}`,
    // Disable Claude Code's per-project prompt history — otherwise the previous
    // charm-start prompt gets pre-populated into the input box and re-submitted
    // after the current prompt begins processing.
    `export CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`,
    `export MAX_THINKING_TOKENS=${thinking}`,
    `exec claude ${flags.join(" ")}`,
  ].join(" && ");
}

/** Pre-approve a directory in ~/.claude.json so Claude Code skips the
 *  "Do you trust this directory?" dialog for interactive sessions. */
export function ensureDirectoryTrusted(dir: string): void {
  const claudeJson = join(homedir(), ".claude.json");
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(readFileSync(claudeJson, "utf8"));
  } catch {
    // file missing or malformed — start fresh
  }
  if (!data.projects) data.projects = {};
  const entry = data.projects[dir] ?? {};
  if (entry.hasTrustDialogAccepted) return;
  entry.hasTrustDialogAccepted = true;
  data.projects[dir] = entry;
  writeFileSync(claudeJson, JSON.stringify(data, null, 2) + "\n");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
