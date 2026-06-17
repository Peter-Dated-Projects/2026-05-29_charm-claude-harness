import { expect, test } from "bun:test";
import type { Ticket } from "../schema.ts";
import { Solver, type InFlight, liveDependentsOf } from "./solver.ts";

/**
 * Regression test for bug #5 ("concurrent spawn double-claims overlapping
 * touches"). The invariant: two tickets whose `touches` file-globs overlap must
 * never be runnable at the same time. The daemon enforces this by feeding the
 * solver an `inFlight` set that includes every already-claimed worker (down to
 * `spawning` state), and Solver.nextRunnable must defer any candidate whose
 * touches collide with a claimed file — whether the collision is against an
 * existing in-flight claim or against a sibling it picked earlier in the same
 * pass. This test pins the pure de-confliction logic the spawn path relies on;
 * the daemon-level locking that makes the claim *visible* in time is a separate
 * concern (see spawn-claim.test.ts and the withLayoutLock section of index.ts).
 */

function ticket(opts: {
  id: string;
  touches?: string[];
  depends_on?: string[];
  status?: Ticket["frontmatter"]["status"];
}): Ticket {
  return {
    frontmatter: {
      id: opts.id,
      title: opts.id,
      type: "implementation",
      status: opts.status ?? "ready",
      stage: "approved",
      depends_on: opts.depends_on ?? [],
      touches: opts.touches ?? [],
    },
    body: "",
    path: `/tmp/${opts.id}.md`,
  };
}

test("nextRunnable defers a candidate whose touches collide with an in-flight claim", () => {
  // T-001 is already in flight (a worker is spawning/running for it) and holds
  // src/a.ts. T-002 also touches src/a.ts, so it must NOT come back runnable.
  const tickets = [
    ticket({ id: "T-001", touches: ["src/a.ts"] }),
    ticket({ id: "T-002", touches: ["src/a.ts"] }),
  ];
  const solver = new Solver(tickets);
  const inFlight: InFlight[] = [{ ticket_id: "T-001", touches: ["src/a.ts"] }];

  const runnable = solver.nextRunnable({
    completed: new Set(),
    inFlight,
    candidates: ["T-002"],
  });

  expect(runnable).toEqual([]);
});

test("nextRunnable does not return two candidates that touch the same file in one pass", () => {
  // No prior in-flight claim, but both candidates touch src/shared.ts. Only one
  // may be returned — the second collides with the first's freshly-staked claim.
  const tickets = [
    ticket({ id: "T-001", touches: ["src/shared.ts"] }),
    ticket({ id: "T-002", touches: ["src/shared.ts"] }),
  ];
  const solver = new Solver(tickets);

  const runnable = solver.nextRunnable({
    completed: new Set(),
    inFlight: [],
    candidates: ["T-001", "T-002"],
  });

  expect(runnable).toEqual(["T-001"]);
});

test("nextRunnable detects partial overlap when only one of several touched files collides", () => {
  // T-002 touches two files; only one overlaps the in-flight claim. A single
  // overlapping file is enough to make it unsafe to run concurrently.
  const tickets = [
    ticket({ id: "T-001", touches: ["src/a.ts"] }),
    ticket({ id: "T-002", touches: ["src/b.ts", "src/a.ts"] }),
  ];
  const solver = new Solver(tickets);
  const inFlight: InFlight[] = [{ ticket_id: "T-001", touches: ["src/a.ts"] }];

  const runnable = solver.nextRunnable({
    completed: new Set(),
    inFlight,
    candidates: ["T-002"],
  });

  expect(runnable).toEqual([]);
});

test("nextRunnable returns both candidates when their touches are disjoint (positive case)", () => {
  // Disjoint touches => safe to run concurrently => both come back runnable.
  const tickets = [
    ticket({ id: "T-001", touches: ["src/a.ts"] }),
    ticket({ id: "T-002", touches: ["src/b.ts"] }),
  ];
  const solver = new Solver(tickets);

  const runnable = solver.nextRunnable({
    completed: new Set(),
    inFlight: [],
    candidates: ["T-001", "T-002"],
  });

  expect(runnable).toEqual(["T-001", "T-002"]);
});

test("nextRunnable lets a deferred candidate run once the conflicting claim clears", () => {
  // With T-001's claim gone from inFlight, T-002 (which touches the same file)
  // becomes runnable again — the de-confliction is a live claim, not a ban.
  const tickets = [
    ticket({ id: "T-001", touches: ["src/a.ts"] }),
    ticket({ id: "T-002", touches: ["src/a.ts"] }),
  ];
  const solver = new Solver(tickets);

  const blocked = solver.nextRunnable({
    completed: new Set(),
    inFlight: [{ ticket_id: "T-001", touches: ["src/a.ts"] }],
    candidates: ["T-002"],
  });
  expect(blocked).toEqual([]);

  const freed = solver.nextRunnable({
    completed: new Set(["T-001"]),
    inFlight: [],
    candidates: ["T-002"],
  });
  expect(freed).toEqual(["T-002"]);
});

// --- dependency gating (depends_on) --------------------------------------
// The touches tests above pin the file-conflict half of nextRunnable; these
// pin the dependency half (lines around `depsReady`). A regression that
// ignored depends_on entirely would pass every touches test but fail here.

test("nextRunnable defers a candidate whose dependency is not yet complete", () => {
  // T-002 depends on T-001. With T-001 not in `completed`, T-002 must not run,
  // even though their touches are disjoint (so the only thing holding it back
  // is the unmet dependency, not a file conflict).
  const tickets = [
    ticket({ id: "T-001", touches: ["src/a.ts"] }),
    ticket({ id: "T-002", touches: ["src/b.ts"], depends_on: ["T-001"] }),
  ];
  const solver = new Solver(tickets);

  const runnable = solver.nextRunnable({
    completed: new Set(),
    inFlight: [],
    candidates: ["T-001", "T-002"],
  });

  expect(runnable).toEqual(["T-001"]);
});

test("nextRunnable lets a dependent run once its dependency completes", () => {
  const tickets = [
    ticket({ id: "T-001", touches: ["src/a.ts"] }),
    ticket({ id: "T-002", touches: ["src/b.ts"], depends_on: ["T-001"] }),
  ];
  const solver = new Solver(tickets);

  const runnable = solver.nextRunnable({
    completed: new Set(["T-001"]),
    inFlight: [],
    candidates: ["T-002"],
  });

  expect(runnable).toEqual(["T-002"]);
});

test("nextRunnable skips a candidate that is already complete", () => {
  // A ticket already marked complete must never come back runnable.
  const tickets = [ticket({ id: "T-001", touches: ["src/a.ts"] })];
  const solver = new Solver(tickets);

  const runnable = solver.nextRunnable({
    completed: new Set(["T-001"]),
    inFlight: [],
    candidates: ["T-001"],
  });

  expect(runnable).toEqual([]);
});

test("nextRunnable silently drops a candidate id that names no real ticket", () => {
  // The daemon may pass a stale/typo'd id; nextRunnable filters unknown ids
  // rather than throwing on the byId.get(id)! dereference.
  const tickets = [ticket({ id: "T-001", touches: ["src/a.ts"] })];
  const solver = new Solver(tickets);

  const runnable = solver.nextRunnable({
    completed: new Set(),
    inFlight: [],
    candidates: ["T-001", "T-404"],
  });

  expect(runnable).toEqual(["T-001"]);
});

test("nextRunnable defaults to all tickets when candidates is omitted", () => {
  // The omitted-candidates branch iterates the whole ticket set. Disjoint
  // touches => both come back.
  const tickets = [
    ticket({ id: "T-001", touches: ["src/a.ts"] }),
    ticket({ id: "T-002", touches: ["src/b.ts"] }),
  ];
  const solver = new Solver(tickets);

  const runnable = solver.nextRunnable({ completed: new Set(), inFlight: [] });

  expect(new Set(runnable)).toEqual(new Set(["T-001", "T-002"]));
});

// --- constructor invariants ----------------------------------------------
// The constructor deliberately throws on a dependency graph it can't schedule,
// rather than letting nextRunnable silently defer forever. These guards are the
// loud-failure half of the design and were previously untested.

test("constructor throws on a depends_on naming a nonexistent ticket", () => {
  expect(() => new Solver([ticket({ id: "T-001", depends_on: ["T-404"] })])).toThrow(
    /unknown tickets/,
  );
});

test("constructor throws on a dependency cycle", () => {
  expect(
    () =>
      new Solver([
        ticket({ id: "T-001", depends_on: ["T-002"] }),
        ticket({ id: "T-002", depends_on: ["T-001"] }),
      ]),
  ).toThrow(/cycle/);
});

test("topoOrder returns dependencies before their dependents", () => {
  // Edge direction is dep -> dependent, so a valid topo order must place a
  // dependency ahead of anything that depends on it.
  const solver = new Solver([
    ticket({ id: "T-002", depends_on: ["T-001"] }),
    ticket({ id: "T-001" }),
  ]);

  const order = solver.topoOrder();
  expect(order.indexOf("T-001")).toBeLessThan(order.indexOf("T-002"));
});

test("nextRunnable dedupes a duplicated candidate id (no double-spawn)", () => {
  // input.ticket_ids is only validated as a non-empty string array, so the same
  // id can appear twice. With EMPTY touches the newlyClaimed conflict guard
  // can't dedupe it, so without explicit candidate dedup the id would be emitted
  // (and a worker spawned) twice for one ticket.
  const tickets = [ticket({ id: "T-001", touches: [] })];
  const solver = new Solver(tickets);

  const runnable = solver.nextRunnable({
    completed: new Set(),
    inFlight: [],
    candidates: ["T-001", "T-001"],
  });

  expect(runnable).toEqual(["T-001"]);
});

// --- liveDependentsOf: surfacing a cancelled dependency -------------------
// When a dependency is cancelled, the tickets that depended on it can never
// satisfy their depends_on (only `complete` does). The daemon surfaces those to
// the orchestrator to re-plan; this helper computes the set.

test("liveDependentsOf returns live tickets that directly depend on the cancelled one", () => {
  const tickets = [
    ticket({ id: "T-001", status: "cancelled" }),
    ticket({ id: "T-002", depends_on: ["T-001"], status: "ready" }),
    ticket({ id: "T-003", depends_on: ["T-001"], status: "pending" }),
    ticket({ id: "T-004", touches: ["x"] }), // unrelated
  ];
  expect(liveDependentsOf(tickets, "T-001").sort()).toEqual(["T-002", "T-003"]);
});

test("liveDependentsOf excludes dependents that are themselves done/cancelled/failed", () => {
  // A dependent that already completed, was cancelled, or failed is not waiting
  // on the cancelled dep, so it isn't 'now blocked' and shouldn't be surfaced.
  const tickets = [
    ticket({ id: "T-001", status: "cancelled" }),
    ticket({ id: "T-002", depends_on: ["T-001"], status: "complete" }),
    ticket({ id: "T-003", depends_on: ["T-001"], status: "cancelled" }),
    ticket({ id: "T-004", depends_on: ["T-001"], status: "failed" }),
    ticket({ id: "T-005", depends_on: ["T-001"], status: "blocked" }),
  ];
  expect(liveDependentsOf(tickets, "T-001")).toEqual(["T-005"]);
});

test("liveDependentsOf returns [] when nothing depends on the cancelled ticket", () => {
  const tickets = [
    ticket({ id: "T-001", status: "cancelled" }),
    ticket({ id: "T-002", depends_on: ["T-999"] }),
  ];
  expect(liveDependentsOf(tickets, "T-001")).toEqual([]);
});
