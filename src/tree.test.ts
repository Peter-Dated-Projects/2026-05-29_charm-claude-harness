import { expect, test } from "bun:test";
import { renderTicketTree, type TreeTicket } from "./tree.ts";

function t(
  id: string,
  title: string,
  depends_on: string[] = [],
  status: TreeTicket["status"] = "pending",
): TreeTicket {
  return { id, title, status, depends_on };
}

test("empty board", () => {
  expect(renderTicketTree([])).toBe("(no tickets)");
});

test("renders the canonical spanning-tree layout with glyphs and cross-edges", () => {
  // The shape from charm's planning view: one complete root, a fan of children,
  // a nested grandchild, and a node (T-218) whose first dep is the root (its
  // tree parent) with two further deps shown as inline cross-edges.
  const tickets: TreeTicket[] = [
    t("T-212", "get_post pitch data", [], "complete"),
    t("T-214", "backend: create_post + slide CRUD", ["T-212"]),
    t("T-215", "orchestrator: launch_run + custom vars", ["T-212"]),
    t("T-216", "prompts: operator-notes + no-pitch", ["T-212"]),
    t("T-217", "agent_mcp: run_processing", ["T-215"]),
    t("T-218", "agent.rs: teach tools + no-delete", ["T-212", "T-214", "T-217"]),
    t("T-219", "cleanup: vestigial context plumbing", ["T-218"]),
    t("T-220", "cleanup: dead-code sweep", ["T-219"]),
  ];

  const expected = [
    "T-212 ✓  get_post pitch data",
    "  ├─ T-214 ·  backend: create_post + slide CRUD",
    "  ├─ T-215 ·  orchestrator: launch_run + custom vars",
    "  │   └─ T-217 ·  agent_mcp: run_processing",
    "  ├─ T-216 ·  prompts: operator-notes + no-pitch",
    "  └─ T-218 ·  agent.rs: teach tools + no-delete  (← T-214, T-217)",
    "      └─ T-219 ·  cleanup: vestigial context plumbing",
    "          └─ T-220 ·  cleanup: dead-code sweep",
  ].join("\n");

  expect(renderTicketTree(tickets)).toBe(expected);
});

test("tags in-flight statuses but leaves pending/complete to their glyph", () => {
  const out = renderTicketTree([
    t("T-001", "root", [], "complete"),
    t("T-002", "a", ["T-001"], "running"),
    t("T-003", "b", ["T-001"], "blocked"),
    t("T-004", "c", ["T-001"], "pending"),
  ]);
  expect(out).toContain("T-002 ●  a  [running]");
  expect(out).toContain("T-003 ⊘  b  [blocked]");
  // pending shows no word tag, complete shows none either (just its glyph).
  expect(out).toContain("T-004 ·  c");
  expect(out).not.toContain("[pending]");
  expect(out).not.toContain("[complete]");
});

test("multiple roots render as a forest in numeric id order", () => {
  const out = renderTicketTree([
    t("T-002", "second root"),
    t("T-001", "first root"),
    t("T-010", "child of first", ["T-001"]),
  ]);
  const lines = out.split("\n");
  expect(lines[0]).toBe("T-001 ·  first root");
  expect(lines[1]).toBe("  └─ T-010 ·  child of first");
  expect(lines[2]).toBe("T-002 ·  second root");
});

test("numeric id ordering: T-009 before T-010", () => {
  const out = renderTicketTree([
    t("T-001", "root"),
    t("T-010", "ten", ["T-001"]),
    t("T-009", "nine", ["T-001"]),
  ]);
  const lines = out.split("\n");
  expect(lines[1]).toContain("T-009");
  expect(lines[2]).toContain("T-010");
});

test("dependency on a missing ticket is dropped, not stranded", () => {
  // T-002 depends only on a ticket not on the board → it becomes a root rather
  // than vanishing.
  const out = renderTicketTree([t("T-002", "orphan", ["T-999"])]);
  expect(out).toBe("T-002 ·  orphan");
});

test("a cycle does not hang and the tangled nodes still surface", () => {
  const out = renderTicketTree([
    t("T-001", "a", ["T-002"]),
    t("T-002", "b", ["T-001"]),
  ]);
  // Neither node is a root (each depends on the other), so both fall to the
  // cycle-surfacing pass and are listed flat with a marker.
  expect(out).toContain("T-001");
  expect(out).toContain("T-002");
  expect(out).toContain("(cycle)");
});
