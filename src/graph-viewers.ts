import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";

/**
 * Tracking for standalone graph-viewer processes.
 *
 * The daemon spawns each graph viewer (open_graph) in a brand-new OS terminal
 * window, fully outside tmux. The daemon therefore can't observe the viewer's
 * PID directly — so the viewer self-registers: on startup it appends its own
 * process.pid to a file in .charm/ (CHARM_GRAPH_PIDFILE), and removes it on exit.
 *
 * Persisting to a file (not daemon memory) is what lets `charm stop` reap every
 * window even when the daemon that launched them is already gone. Format is one
 * PID per line so the `charm.sh` stop path (plain bash) can read it without a
 * JSON parser. Appends are single-line so concurrent viewers don't clobber each
 * other; dead/duplicate entries are pruned on read and kill.
 */

function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs error checking without actually sending a signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read tracked viewer PIDs, de-duplicated. Does not prune dead ones — callers
 *  that care about liveness check it themselves. Returns [] if the file is
 *  missing/unreadable. */
export function readGraphViewerPids(file: string): number[] {
  if (!existsSync(file)) return [];
  try {
    const pids = readFileSync(file, "utf8")
      .split("\n")
      .map((l) => parseInt(l.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
    return Array.from(new Set(pids));
  } catch {
    return [];
  }
}

/** Self-register: append this viewer's PID as a single line. A lone-line append
 *  is atomic enough on a local fs that concurrent viewers starting at once don't
 *  clobber each other (unlike a read-modify-write). Called by the viewer itself. */
export function appendGraphViewerPid(file: string, pid: number): void {
  try {
    appendFileSync(file, `${pid}\n`);
  } catch {
    /* tracking is best-effort; never let it crash the viewer */
  }
}

/** Remove this viewer's PID on clean exit, also pruning any other dead entries so
 *  the file converges back to the set of live viewers. Best-effort. */
export function removeGraphViewerPid(file: string, pid: number): void {
  try {
    const next = readGraphViewerPids(file).filter((p) => p !== pid && isAlive(p));
    if (next.length) writeFileSync(file, next.join("\n") + "\n");
    else unlinkSync(file);
  } catch {
    /* ignore */
  }
}

/** Terminate every tracked viewer that's still alive (SIGTERM), then remove the
 *  tracking file. Returns the PIDs actually signalled. Safe to call when no
 *  viewers or file exist (returns []). */
export function killGraphViewers(file: string): number[] {
  const killed: number[] = [];
  for (const pid of readGraphViewerPids(file)) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid);
      killed.push(pid);
    } catch {
      /* raced with the viewer exiting on its own — already gone */
    }
  }
  try {
    unlinkSync(file);
  } catch {
    /* ignore */
  }
  return killed;
}
