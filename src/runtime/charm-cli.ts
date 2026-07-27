import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Resolve how to invoke the charm CLI from inside a daemon-spawned process
 * (statusLine hooks, etc.).
 *
 * Precedence:
 *   1. CHARM_CLI_BIN — set by `charm start` when it launches charmd
 *      (`/path/to/charm` or `bun run /path/to/cli.ts`)
 *   2. Sibling binary next to the running executable (`charm-claude` / `charm`)
 *   3. Source checkout: `bun run <repo>/src/cli.ts`
 *   4. Bare `charm` on PATH
 */
export function resolveCharmCliArgv(
  envBin: string | undefined = process.env.CHARM_CLI_BIN,
): string[] {
  const raw = (envBin ?? "").trim();
  if (raw) {
    const bunRun = raw.match(/^(.+?)\s+run\s+(.+)$/);
    if (bunRun) return [bunRun[1]!.trim(), "run", bunRun[2]!.trim()];
    return [raw];
  }

  try {
    const dir = dirname(process.execPath);
    for (const name of ["charm-claude", "charm"]) {
      const p = join(dir, name);
      if (existsSync(p)) return [p];
    }
  } catch {
    /* ignore */
  }

  try {
    // When charmd is `bun run src/daemon/index.ts`, import.meta.dir is src/daemon.
    const cli = join(import.meta.dir, "../cli.ts");
    if (existsSync(cli)) return [process.execPath, "run", cli];
  } catch {
    /* ignore */
  }

  return ["charm"];
}
