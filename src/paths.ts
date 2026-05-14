import { join } from "node:path";

export function harnessPaths(root: string) {
  const harnessDir = join(root, ".charm");
  return {
    root,
    harnessDir,
    socket: join(harnessDir, "sock"),
    db: join(harnessDir, "db.sqlite"),
    promptsDir: join(harnessDir, "prompts"),
    logsDir: join(harnessDir, "logs"),
    ticketsDir: join(harnessDir, "tickets"),
    projectMd: join(harnessDir, "PROJECT.md"),
    coordinationMd: join(harnessDir, "COORDINATION.md"),
    mcpConfig: join(harnessDir, "harness.json"),
    pidFile: join(harnessDir, "harnessd.pid"),
    metaJson: join(harnessDir, "meta.json"),
  } as const;
}

export type HarnessPaths = ReturnType<typeof harnessPaths>;
