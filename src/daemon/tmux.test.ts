import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { Tmux } from "./tmux.ts";

/**
 * Pane-placement tests for Tmux.splitPane. charm runs every session on the
 * DEFAULT tmux server and the daemon is a detached process, so targeting is
 * load-bearing in two ways:
 *   - Untargeted (cli.ts main-pane spawn): a `split-window` with no `-t` lands
 *     in tmux's global "current session", which may be another live charm
 *     session. splitPane defaults the target to `${this.session}` so the pane
 *     stays in the session this Tmux instance owns. (First test.)
 *   - Explicit target (daemon/index.ts spawnAgent passes `${session}:${WINDOW}`):
 *     the sub-agent pane must land in the targeted window, not whatever window
 *     happens to be current. (Second test — this is the primary sub-agent path.)
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
  return paneField(paneId, "#{session_name}");
}

/** The server-global window id (`@N`) that contains a pane, or null if gone. */
function windowOfPane(paneId: string): string | null {
  return paneField(paneId, "#{window_id}");
}

/** Read one tmux format field for a pane by scanning all panes on the server. */
function paneField(paneId: string, field: string): string | null {
  const r = spawnSync(
    "tmux",
    ["list-panes", "-a", "-F", `#{pane_id}\t${field}`],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  for (const line of r.stdout.trim().split("\n")) {
    const [id, value] = line.split("\t");
    if (id === paneId) return value ?? null;
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
  async () => {
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

    // The untargeted call path: the CLI's main-pane spawn (cli.ts) calls
    // splitPane with no explicit target, relying on the class to scope to its
    // own session. (spawnAgent passes an explicit target instead — covered by
    // the next test.)
    const pane = await tmux.splitPane({ cmd: "sh -c 'sleep 30'", cwd, direction: "h" });
    expect(sessionOfPane(pane)).toBe(OWN);
  },
);

test.skipIf(!tmuxAvailable)(
  "splitPane honors an explicit target window (the spawnAgent path)",
  async () => {
    const cwd = tmpdir();
    const tmux = new Tmux(OWN);

    // Window 1 ("charm") is created first; a second window is created last so it
    // becomes the session's CURRENT window. An untargeted split would land in
    // the current (second) window — so targeting window 1 explicitly is the
    // behavior under test (this is what spawnAgent relies on: index.ts targets
    // `${session}:${WINDOW}`).
    tmux.newSession("charm", cwd);
    const firstWindow = windowOfPane(
      spawnSync("tmux", ["display-message", "-p", "-t", `${OWN}:charm`, "#{pane_id}"], { encoding: "utf8" }).stdout.trim(),
    );
    expect(firstWindow).not.toBeNull();
    tmux.newWindow({ name: "second", cmd: "sh -c 'sleep 30'", cwd });

    const pane = await tmux.splitPane({
      cmd: "sh -c 'sleep 30'",
      cwd,
      direction: "h",
      target: `${OWN}:charm`,
    });

    // The pane lands in the explicitly targeted first window, not the current
    // (second) one. A regression that ignored opts.target would fail here.
    expect(windowOfPane(pane)).toBe(firstWindow);
  },
);

test.skipIf(!tmuxAvailable)(
  "listPanes reports a remain-on-exit pane as dead once its command exits",
  async () => {
    const cwd = tmpdir();
    const tmux = new Tmux(OWN);
    // newSession turns on session-level remain-on-exit, so a pane whose command
    // exits stays listed with dead:true — the exact signal the daemon's liveness
    // sweep keys off to reap agents that exited without reporting.
    tmux.newSession("charm", cwd);

    const pane = await tmux.splitPane({ cmd: "sh -c 'exit 0'", cwd, direction: "h" });

    // Poll briefly for the command to exit and the pane to flip to dead.
    let entry: { pane_id: string; dead: boolean } | undefined;
    for (let i = 0; i < 50; i++) {
      entry = tmux.listPanes().find((p) => p.pane_id === pane);
      if (entry?.dead) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(entry).toBeDefined();
    expect(entry!.dead).toBe(true);
  },
);

test.skipIf(!tmuxAvailable)(
  "paneAlive is true for a running pane, false for a dead or absent one",
  async () => {
    const cwd = tmpdir();
    const tmux = new Tmux(OWN);
    tmux.newSession("charm", cwd);

    const live = await tmux.splitPane({ cmd: "sh -c 'sleep 30'", cwd, direction: "h" });
    expect(await tmux.paneAlive(live)).toBe(true);

    // A pane whose command exits is retained (remain-on-exit) but dead — paneIndex
    // would still see it, paneAlive must not. Poll for the exit to land.
    const dead = await tmux.splitPane({ cmd: "sh -c 'exit 0'", cwd, direction: "h" });
    let alive = true;
    for (let i = 0; i < 50; i++) {
      alive = await tmux.paneAlive(dead);
      if (!alive) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(alive).toBe(false);

    // A pane id that never existed reads as not-alive.
    expect(await tmux.paneAlive("%999999")).toBe(false);
  },
);

test.skipIf(!tmuxAvailable)(
  "activePane reports the focused pane and follows selectPane",
  async () => {
    const cwd = tmpdir();
    const tmux = new Tmux(OWN);
    tmux.newSession("charm", cwd);

    // The session's original pane is the active one at boot.
    const original = spawnSync(
      "tmux", ["display-message", "-p", "-t", `${OWN}:charm`, "#{pane_id}"],
      { encoding: "utf8" },
    ).stdout.trim();
    expect(await tmux.activePane()).toBe(original);

    // splitPane uses `-d` (detached), so focus stays on the original pane...
    const other = await tmux.splitPane({ cmd: "sh -c 'sleep 30'", cwd, direction: "h" });
    expect(await tmux.activePane()).toBe(original);

    // ...until we explicitly select the new pane.
    tmux.selectPane(other);
    expect(await tmux.activePane()).toBe(other);
  },
);

test("activePane returns null for a session that does not exist", async () => {
  const tmux = new Tmux(`charm-test-absent-${STAMP}`);
  expect(await tmux.activePane()).toBeNull();
});

test("listPanes returns [] for a session that does not exist", () => {
  // The status!==0 fallback: querying a nonexistent session must not throw.
  const tmux = new Tmux(`charm-test-absent-${STAMP}`);
  expect(tmux.listPanes()).toEqual([]);
});
