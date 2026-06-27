import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

/**
 * Resolve the daemon's Unix-socket path for a session's run dir.
 *
 * Unix domain sockets are bounded by the kernel's `sockaddr_un.sun_path`:
 * 104 bytes on macOS/BSD, 108 on Linux. A long project path can push the
 * natural `<runDir>/sock` past that limit, and the daemon then dies on every
 * start with an opaque `Failed to listen` (and leaves a stale pidfile behind,
 * which then blocks subsequent starts). Keep the socket inside the run dir when
 * it fits — it's nicer for cleanup and reasoning about side-by-side runs — and
 * otherwise fall back to a short, collision-free path in the system temp dir.
 * The fallback is keyed by the session UUID when there is one (unique per
 * session, so two sessions never share a socket even in the same directory) and
 * by a hash of the *absolute* root otherwise, so the CLI and the daemon (two
 * independently compiled binaries) deterministically agree on the same path.
 */
function resolveSocketPath(runDir: string, root: string, sessionId?: string): string {
  const inDir = join(runDir, "sock");
  // Stay well under the 104-byte macOS floor to leave margin for the kernel's
  // accounting; falling back early is harmless, binding a too-long path is not.
  if (Buffer.byteLength(inDir) <= 100) return inDir;
  const key = sessionId ?? createHash("sha1").update(root).digest("hex").slice(0, 16);
  return join(tmpdir(), `charm-${key}.sock`);
}

/**
 * Resolve all paths for a charm session.
 *
 * Two tiers, split by lifetime and ownership:
 *
 *  - Shared, per-directory (the workspace). One copy per project root, shared by
 *    every session in that directory: the ticket board (db.sqlite, tickets/,
 *    COORDINATION.md), PROJECT.md, the durable knowledge base, prompt templates,
 *    operator skills, the MCP config, and .claude/settings.json. These live
 *    directly under .charm/.
 *
 *  - Per-session, control plane. One copy per running session, namespaced by the
 *    session UUID under .charm/run/<uuid>/: the daemon socket, pidfile, daemon
 *    log, session meta.json, and the graph-viewer pidfile. Isolating these is
 *    what lets multiple daemons coexist (same dir or different dirs) and what
 *    scopes a `:q` to exactly the session it was pressed in — quitting one
 *    session reaps only that session's daemon, panes, and graph viewers.
 *
 * Pass `sessionId` to resolve a concrete session's control-plane paths. Omit it
 * (e.g. `charm init`, or the rare bare `charmd`) to fall back to the legacy
 * single-session layout where control-plane files sit directly under .charm/.
 */
export function charmPaths(root: string, sessionId?: string) {
  const charmDir = join(root, ".charm");
  // Per-session run state nests under .charm/run/<uuid>/; with no session id it
  // collapses to .charm/ (the legacy single-session layout).
  const runRootDir = join(charmDir, "run");
  const runDir = sessionId ? join(runRootDir, sessionId) : charmDir;
  return {
    root,
    charmDir,
    sessionId: sessionId ?? null,
    // Parent of all per-session run dirs; enumerated to discover live sessions.
    runRootDir,
    // This session's run dir (holds socket, pidfile, log, meta, graph pids).
    runDir,
    // Pointer to the most-recently-started session's tmux name, so `charm.sh`
    // (and attach-after-start) can find the session it just launched without
    // re-deriving a now-random name. One per directory.
    lastSessionFile: join(charmDir, "last-session"),
    // ---- per-session control plane (under runDir) ----
    socket: resolveSocketPath(runDir, root, sessionId),
    logsDir: join(runDir, "logs"),
    // ---- shared, per-directory workspace (under .charm/) ----
    db: join(charmDir, "db.sqlite"),
    promptsDir: join(charmDir, "prompts"),
    ticketsDir: join(charmDir, "tickets"),
    // Orchestrator scratchpad for ticket DRAFTS. The orchestrator writes draft
    // ticket files here directly (cheap local write, no MCP round-trip), each
    // following normal ticket conventions; the `promote` tool then moves a draft
    // into ticketsDir and indexes it, which is what makes it a real, spawnable
    // ticket. Drafts here are NOT indexed and never appear on the board.
    scratchpadDir: join(charmDir, "scratchpad"),
    // Orchestrator-managed worktree copies, one subdir per parallel line of work
    // (.charm/worktrees/<name>/). Each is a COMPLETELY SEPARATE clone of the repo
    // (its own .git), not a linked `git worktree`, so an agent's edits there —
    // including to its own .charm — never touch the main checkout; work is merged
    // back deliberately and separately. This is a side resource, not part of the
    // default shared-tree execution model: charm opens copies via MCP tools and
    // must close them by session end, and the daemon owns the git plumbing + a
    // prune safety-net. Gitignored (see .charm/.gitignore) — a copy is ephemeral
    // run state, never committed.
    worktreesDir: join(charmDir, "worktrees"),
    // Design proposals / feature requests (PROP-*.md). list_proposals reads this;
    // finish_proposal moves an accepted/superseded file into proposals/finished/.
    proposalsDir: join(charmDir, "proposals"),
    proposalsFinishedDir: join(charmDir, "proposals", "finished"),
    // The durable, git-tracked knowledge base (the one .charm child that survives
    // across runs). kbIndex is the tiny always-read entry point.
    kbDir: join(charmDir, "kb"),
    kbIndex: join(charmDir, "kb", "INDEX.md"),
    // Operator skills (restart, reset-kb, …) + their router index, scaffolded
    // from templates/skills/. The main agent reads skillsIndex on demand so it
    // knows which SKILL.md to follow when asked to perform an operator action.
    skillsDir: join(charmDir, "skills"),
    skillsIndex: join(charmDir, "skills", "INDEX.md"),
    // The project's Claude Code settings. charm start merges its required MCP
    // permissions into <root>/.claude/settings.json (never clobbering existing
    // keys) so spawned agents trust the charm tools and any project MCP servers.
    claudeDir: join(root, ".claude"),
    claudeSettings: join(root, ".claude", "settings.json"),
    projectMd: join(charmDir, "PROJECT.md"),
    // Workspace facts + guardrails shared by every agent, seeded from
    // templates/charm/CHARM.md and appended to each charm-spawned agent's
    // system prompt by buildClaudeCommand (daemon/spawn.ts). It is named CHARM.md
    // (not CLAUDE.md) so the project's root CLAUDE.md can pull it into native
    // Claude Code context via an `@.charm/CHARM.md` import without a name clash.
    charmMd: join(charmDir, "CHARM.md"),
    // The project's own root CLAUDE.md. charm ensures it exists (creating an empty
    // one if absent) and that it imports the workspace CHARM.md, so any Claude
    // session opened in the repo loads the shared workspace context.
    rootClaudeMd: join(root, "CLAUDE.md"),
    coordinationMd: join(charmDir, "COORDINATION.md"),
    mcpConfig: join(charmDir, "charm.json"),
    // ---- per-session control plane (under runDir), continued ----
    pidFile: join(runDir, "charmd.pid"),
    // This session's identity + description record. Written by `start`, enriched
    // by set_session_description; enumerated by `stop`/`attach`/`status` to
    // discover and pick a session.
    metaJson: join(runDir, "meta.json"),
    // PIDs of standalone graph-viewer processes spawned by open_graph, one per
    // line. Per-session so `:q`/`stop` reaps only THIS session's viewers, and so
    // `charm stop` can reap them even if the daemon is gone.
    graphPids: join(runDir, "graph-viewers.pids"),
    // The orchestrator's resume record: a small JSON ({ claude_session_id, model,
    // permission_mode, mode }) capturing what charm passed to `claude` when it
    // spawned the main agent. Persisted to its own file (rather than meta.json,
    // whose schema lives elsewhere) so it survives a daemon restart and lets
    // `charm resume` relaunch the SAME conversation with `claude --resume <uuid>`
    // re-supplying the same model + permission mode. Per-session, under the run
    // dir.
    orchestratorSessionFile: join(runDir, "orchestrator-session.json"),
    // Per-session MCP config with CHARM_SOCKET baked into the env block.
    // Using a per-session file (rather than the shared .charm/charm.json) ensures
    // that each session's agents start their own charm-mcp instance. Without this,
    // Claude Code can reuse a single charm-mcp process across sessions — and when
    // session A closes and kills its claude panes, that shared process dies and
    // breaks session B's agents too.
    // In legacy single-session mode (no sessionId) this aliases to mcpConfig.
    sessionMcpConfig: join(runDir, "charm.json"),
  } as const;
}

export type CharmPaths = ReturnType<typeof charmPaths>;

/**
 * Assert that `name` is a single, plain path segment — no directory separators,
 * no `..`, not absolute. Used to guard caller-supplied draft/proposal names
 * before they're joined into a directory: the names arrive from an LLM agent via
 * MCP tools, and an un-guarded `join(dir, name + ".md")` with `name` like
 * `../../x` would escape the intended directory and let the agent read, move, or
 * delete arbitrary files. Throws with a clear message rather than sanitizing, so
 * a malformed name surfaces instead of silently resolving somewhere unexpected.
 */
export function assertPlainName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    basename(name) !== name
  ) {
    throw new Error(
      `invalid name (must be a plain file name with no path separators): ${JSON.stringify(name)}`,
    );
  }
}

/**
 * Resolve the on-disk path for a named worktree under .charm/worktrees/. The
 * name arrives from an LLM agent via MCP tools, so it is run through
 * assertPlainName (the same path-injection guard used for draft/proposal names)
 * before being joined — an un-guarded `../../x` would let the agent stand up a
 * git worktree anywhere on disk.
 */
export function worktreePathFor(p: CharmPaths, name: string): string {
  assertPlainName(name);
  return join(p.worktreesDir, name);
}

/**
 * Deterministic, tmux-safe default session name for a project root. Two charms
 * in different directories must not collide on the global tmux session
 * namespace, so the default name is derived from the absolute root path rather
 * than the fixed literal "charm".
 *
 * Format: `charm-<basename>-<6hexhash>`. The basename keeps it human-readable in
 * `tmux ls` (`charm-myproject-…`); the path hash disambiguates two directories
 * that happen to share a basename. Output is restricted to `[a-z0-9_-]`, which
 * avoids tmux's target-separator characters (`.` and `:`).
 */
export function defaultSessionName(root: string): string {
  const base = sessionBaseName(root);
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 6);
  return `charm-${base}-${hash}`;
}

/**
 * Per-session tmux name: `charm-<basename>-<8charsofuuid>`. Unlike
 * defaultSessionName (one stable name per directory), this is unique per session
 * — the UUID suffix is what lets two `charm start`s in the SAME directory get
 * distinct tmux sessions instead of colliding. The name is no longer
 * re-derivable from the root alone (the UUID is random), so the resolved name is
 * persisted in the session's meta.json and the per-directory last-session
 * pointer; `stop`/`attach`/`status` read it back rather than recomputing it.
 */
export function sessionNameForId(root: string, sessionId: string): string {
  const base = sessionBaseName(root);
  // UUIDs contain hyphens; tmux names tolerate them, but strip to keep the
  // suffix compact and unambiguous against the `charm-<base>-` prefix.
  const short = sessionId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "session";
  return `charm-${base}-${short}`;
}

/** tmux-safe basename component shared by both session-name builders. Restricted
 *  to `[a-z0-9_-]`, which avoids tmux's target-separator characters (`.`/`:`). */
function sessionBaseName(root: string): string {
  return (
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "charm"
  );
}
