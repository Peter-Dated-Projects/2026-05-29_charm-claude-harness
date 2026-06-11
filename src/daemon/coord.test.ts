import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { charmPaths } from "../paths.ts";
import { CoordinationWriter, type CoordRow } from "./coord.ts";

/**
 * The COORDINATION.md lock must never freeze the daemon. Only the single-threaded
 * daemon writes this file (synchronously, so writes can't interleave in-process),
 * so a held lock is either a crashed-writer leak or a hypothetical cross-process
 * writer. withLock steals a stale lock and otherwise skips the refresh (the board
 * regenerates on the next change) — it never busy-waits.
 */

const ROOT = join(tmpdir(), `charm-coord-test-${process.pid}`);
const paths = charmPaths(ROOT);
const lockPath = paths.coordinationMd + ".lock";

function row(id: string): CoordRow {
  return { ticket_id: id, about: "x", stage: "approved", status: "ready", agent_id: null, agent_state: null };
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(paths.charmDir, { recursive: true });
});
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

test("write renders the board when the lock is free", () => {
  const w = new CoordinationWriter(paths);
  w.write([row("T-001")]);
  expect(readFileSync(paths.coordinationMd, "utf8")).toContain("T-001");
});

test("write skips (does not hang or throw) when a fresh lock is held", () => {
  const w = new CoordinationWriter(paths);
  w.write([row("T-001")]);
  const before = readFileSync(paths.coordinationMd, "utf8");

  // A live writer holds the lock right now.
  writeFileSync(lockPath, "");
  const start = Date.now();
  w.write([row("T-002")]); // must not busy-wait the old 5s timeout, must not throw
  expect(Date.now() - start).toBeLessThan(1000);

  // The fresh lock blocked this refresh; the board is left untouched and will
  // self-heal on the next change.
  expect(readFileSync(paths.coordinationMd, "utf8")).toBe(before);
});

test("write steals a stale lock and proceeds", () => {
  const w = new CoordinationWriter(paths);
  writeFileSync(lockPath, "");
  // Backdate the lock well past the staleness threshold (crashed-writer leak).
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);

  w.write([row("T-003")]);
  expect(readFileSync(paths.coordinationMd, "utf8")).toContain("T-003");
});
