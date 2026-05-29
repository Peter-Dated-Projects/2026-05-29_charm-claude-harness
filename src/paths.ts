import { join } from "node:path";

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
    projectMd: join(charmDir, "PROJECT.md"),
    coordinationMd: join(charmDir, "COORDINATION.md"),
    mcpConfig: join(charmDir, "charm.json"),
    pidFile: join(charmDir, "charmd.pid"),
    metaJson: join(charmDir, "meta.json"),
  } as const;
}

export type CharmPaths = ReturnType<typeof charmPaths>;
