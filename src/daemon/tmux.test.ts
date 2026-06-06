import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { Tmux } from "./tmux.ts";

/**
 * Regression test for sub-agent pane placement (daemon/index.ts spawnAgent ->
 * tmux.splitPane). charm runs every session on the DEFAULT tmux server and the
 * daemon is a detached process, so a `split-window` with no `-t` lands in tmux's
 * global "current session" rather than the one the daemon owns. With two charm
 * sessions live, that misplaces a session's sub-agent pane into the OTHER
 * session's window. The fix pins the split to `${this.session}` (an explicit
 * target, with a default-safe backstop in splitPane). This test recreates the
 * two-session race and asserts the pane lands in the owning session.
 *
 * Isolation note: the Tmux class always uses the default tmux server, so we use
 * uniquely-named sessions and tear down ONLY those by name. We never call
 * `kill-server`, which would destroy the developer's real tmux sessions.
 */

const tmuxAvailable = Tmux.available();

// Distinct enough to never collide with a real session; no Math.random needed.
const STAMP = `${process.pid}`;
const OWN = `charm-test-own-${STAMP}`;
const DECOY = `charm-test-decoy-${STAMP}`;

function killSession(name: string): void {
  spawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
}

/** Which session owns a given pane id, or null if the pane is gone. */
function sessionOfPane(paneId: string): string | null {
  const r = spawnSync(
    "tmux",
    ["list-panes", "-a", "-F", "#{pane_id}\t#{session_name}"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  for (const line of r.stdout.trim().split("\n")) {
    const [id, session] = line.split("\t");
    if (id === paneId) return session ?? null;
  }
  return null;
}

beforeEach(() => {
  killSession(OWN);
  killSession(DECOY);
});

afterEach(() => {
  killSession(OWN);
  killSession(DECOY);
});

test.skipIf(!tmuxAvailable)(
  "splitPane places the sub-agent pane in the daemon's own session, not the current one",
  () => {
    const cwd = tmpdir();
    const tmux = new Tmux(OWN);

    // Create the owning session FIRST, then a decoy. Creating the decoy last
    // makes it tmux's "current session" — exactly the condition under which an
    // untargeted split-window misfires into the wrong session.
    tmux.newSession("charm", cwd);
    spawnSync("tmux", ["new-session", "-d", "-s", DECOY, "-n", "charm", "-c", cwd]);

    // Sanity: precondition holds — an UNtargeted split would land in the decoy.
    const baseline = spawnSync(
      "tmux",
      ["split-window", "-h", "-P", "-F", "#{pane_id}", "-c", cwd, "sh", "-c", "sleep 30"],
      { encoding: "utf8" },
    );
    expect(baseline.status).toBe(0);
    expect(sessionOfPane(baseline.stdout.trim())).toBe(DECOY);

    // The real call path: spawnAgent uses splitPane with direction "h" and no
    // explicit target, relying on the class to scope to its own session.
    const pane = tmux.splitPane({ cmd: "sh -c 'sleep 30'", cwd, direction: "h" });
    expect(sessionOfPane(pane)).toBe(OWN);
  },
);
