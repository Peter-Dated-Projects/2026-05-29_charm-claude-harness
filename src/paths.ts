import { join, basename } from "node:path";
import { createHash } from "node:crypto";

export function charmPaths(root: string) {
  const charmDir = join(root, ".charm");
  return {
    root,
    charmDir,
    socket: join(charmDir, "sock"),
    db: join(charmDir, "db.sqlite"),
    promptsDir: join(charmDir, "prompts"),
    logsDir: join(charmDir, "logs"),
    ticketsDir: join(charmDir, "tickets"),
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
    coordinationMd: join(charmDir, "COORDINATION.md"),
    mcpConfig: join(charmDir, "charm.json"),
    pidFile: join(charmDir, "charmd.pid"),
    metaJson: join(charmDir, "meta.json"),
    // PIDs of standalone graph-viewer processes spawned by open_graph, one per
    // line. Persisted so `charm stop` can reap them even if the daemon is gone.
    graphPids: join(charmDir, "graph-viewers.pids"),
    // The resolved tmux session name for this root, written by `start`. Lets
    // `stop`/`attach`/`ctl` (and the bash wrapper) recover the exact session
    // name for THIS directory without re-deriving or hardcoding "charm" — which
    // is what lets multiple charms run side by side in different directories.
    sessionFile: join(charmDir, "session"),
  } as const;
}

export type CharmPaths = ReturnType<typeof charmPaths>;

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
  const base =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "charm";
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 6);
  return `charm-${base}-${hash}`;
}
