import { expect, test } from "bun:test";
import type { Agent } from "../schema.ts";
import { AgentRegistry, holdsTicketClaim, occupiesLiveSlot } from "./registry.ts";

/**
 * Regression test for the registry-level half of bug #5 ("concurrent spawn
 * double-claims overlapping touches"). The fix hinges on a freshly created
 * worker's touches-claim being visible the instant it's created — before its
 * pane subprocess finishes and it flips to `running`. registry.create() sets
 * state `spawning`, and the daemon's inFlight() filter counts `spawning` agents
 * (not just running/blocked). If either of those drifts, a concurrent
 * spawn_workers could solve against a stale view and double-claim a file.
 *
 * This replicates the inFlight() predicate from daemon/index.ts so a change to
 * registry.create()'s initial state, or to the set of states inFlight counts,
 * breaks this test. It does NOT stand up the daemon RPC loop; the end-to-end
 * concurrent-RPC race additionally depends on withLayoutLock serializing the
 * read-solve-spawn section, which isn't exercised here (see note in the report
 * / the lock section of daemon/index.ts).
 */

// holdsTicketClaim is the REAL predicate the daemon's inFlight() filters on
// (imported, not copied) — so if its state set ever drifts, these tests move with
// it instead of silently passing against a stale duplicate.
const holdsClaim = holdsTicketClaim;

test("a freshly create()d worker is in state 'spawning'", () => {
  const registry = new AgentRegistry();
  const agent = registry.create({ role: "worker", ticket_id: "T-001" });
  expect(agent.state).toBe("spawning");
});

test("a freshly create()d worker is immediately counted as holding a claim", () => {
  // The crux: the claim must be visible at `spawning`, before attach() flips it
  // to `running`. A concurrent solve happening in this window must see it.
  const registry = new AgentRegistry();
  const agent = registry.create({ role: "worker", ticket_id: "T-001" });

  const claimed = registry.list().filter(holdsClaim);
  expect(claimed.map((a) => a.id)).toEqual([agent.id]);
});

test("the claim survives the spawning -> running transition", () => {
  const registry = new AgentRegistry();
  const agent = registry.create({ role: "worker", ticket_id: "T-001" });
  expect(registry.list().filter(holdsClaim).map((a) => a.id)).toEqual([agent.id]);

  registry.attach(agent.id, { pane_id: "%1", pid: 1234 });
  expect(registry.get(agent.id)!.state).toBe("running");
  expect(registry.list().filter(holdsClaim).map((a) => a.id)).toEqual([agent.id]);
});

test("a done/failed worker STILL holds its claim until removed (writes may be in flight)", () => {
  // report_status('done'/'failed') runs WITHOUT the layout lock, and the worker's
  // process may still be flushing writes to its touched files. So the file-claim
  // must persist past the terminal state transition — released only when the
  // agent is actually torn down (registry.remove). Otherwise a concurrent
  // spawn_workers could double-claim the freed files mid-write (spawn-race on the
  // done->teardown tail). The cap is freed separately via occupiesLiveSlot.
  const registry = new AgentRegistry();
  const agent = registry.create({ role: "worker", ticket_id: "T-001" });

  registry.setState(agent.id, "done");
  expect(registry.list().filter(holdsClaim).map((a) => a.id)).toEqual([agent.id]);

  registry.setState(agent.id, "failed");
  expect(registry.list().filter(holdsClaim).map((a) => a.id)).toEqual([agent.id]);

  // Teardown — and only teardown — releases the claim.
  registry.remove(agent.id);
  expect(registry.list().filter(holdsClaim)).toEqual([]);
});

test("a blocked worker still holds its claim", () => {
  // `blocked` is a live-slot state: a worker waiting on the orchestrator still
  // owns the files it touched, so a concurrent solve must keep deferring around
  // it. If `blocked` ever dropped out of the live-slot set, its files would be
  // re-claimed mid-edit — the exact double-claim this file guards.
  const registry = new AgentRegistry();
  const agent = registry.create({ role: "worker", ticket_id: "T-001" });

  registry.setState(agent.id, "blocked");
  expect(registry.list().filter(holdsClaim).map((a) => a.id)).toEqual([agent.id]);
});

test("a non-worker in a live slot does NOT hold a ticket-touch claim", () => {
  // Only workers edit files, so only workers stake a touches-claim. An investigator
  // or tester assigned a ticket must not, or the solver would defer real workers
  // behind it.
  for (const role of ["investigator", "tester", "main"] as const) {
    const registry = new AgentRegistry();
    registry.create({ role, ticket_id: "T-001" });
    expect(registry.list().filter(holdsClaim)).toEqual([]);
  }
});

test("a worker with no ticket does NOT hold a claim", () => {
  // ticket_id null is the orchestrator/unassigned path; with no ticket there are
  // no touches to claim.
  const registry = new AgentRegistry();
  registry.create({ role: "worker", ticket_id: null });
  expect(registry.list().filter(holdsClaim)).toEqual([]);
});

test("occupiesLiveSlot truth table: spawning/running/blocked live, done/failed free", () => {
  // This is the single set both the touches-claim filter AND the max-agents cap
  // (liveAgentCount) depend on. Pinning it directly catches a cap-accounting
  // regression (e.g. dropping `blocked`) that the claim tests alone might miss.
  for (const s of ["spawning", "running", "blocked"] as const) {
    expect(occupiesLiveSlot(s)).toBe(true);
  }
  for (const s of ["done", "failed"] as const) {
    expect(occupiesLiveSlot(s)).toBe(false);
  }
});

test("remove() frees the claim and forgets the claude session", () => {
  // remove() is the explicit slot-freeing path (distinct from setState
  // done/failed). After it, the agent is gone from list() and its recorded
  // claude session id is forgotten.
  const registry = new AgentRegistry();
  const agent = registry.create({
    role: "worker",
    ticket_id: "T-001",
    claude_session_id: "sess-abc",
  });
  expect(registry.claudeSessionId(agent.id)).toBe("sess-abc");

  registry.remove(agent.id);
  expect(registry.list()).toEqual([]);
  expect(registry.claudeSessionId(agent.id)).toBeUndefined();
});
