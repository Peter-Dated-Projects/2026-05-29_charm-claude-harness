import { join } from "node:path";

export function harnessPaths(root: string) {
  const harnessDir = join(root, ".harness");
  return {
    root,
    harnessDir,
    socket: join(harnessDir, "sock"),
    db: join(harnessDir, "db.sqlite"),
    promptsDir: join(harnessDir, "prompts"),
    logsDir: join(harnessDir, "logs"),
    ticketsDir: join(root, "tickets"),
    projectMd: join(root, "PROJECT.md"),
    coordinationMd: join(root, "COORDINATION.md"),
    mcpConfig: join(root, "harness.json"),
    pidFile: join(harnessDir, "harnessd.pid"),
  } as const;
}

export type HarnessPaths = ReturnType<typeof harnessPaths>;
