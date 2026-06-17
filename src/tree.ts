import type { TicketStatus } from "./schema.ts";

/** The minimal ticket shape the tree renderer needs. Deliberately narrower than
 *  the full Ticket / IndexedTicket so callers can feed it from either the sqlite
 *  index or the parsed .md files, and so the renderer stays a pure, testable
 *  function with no store/db dependency. */
export type TreeTicket = {
  id: string;
  title: string;
  status: TicketStatus;
  depends_on: string[];
};

/** One glyph per status, shown immediately after the id. The dependency tree
 *  carries the *structure*; the glyph carries each node's lifecycle state at a
 *  glance — ✓ done, ✗ failed, ● in flight, and so on. */
const STATUS_GLYPH: Record<TicketStatus, string> = {
  complete: "✓",
  failed: "✗",
  running: "●",
  blocked: "⊘",
  ready: "○",
  pending: "·",
  cancelled: "⊗",
};

/** Statuses worth spelling out as a `[word]` tag at the aligned annotation
 *  column. `pending` is the planning default (its `·` glyph is enough) and
 *  `complete` reads cleanly from its `✓`, so neither is tagged — keeping a
 *  freshly-planned board (all pending) uncluttered, showing only structure and
 *  cross-edges. Everything in flight or terminal-but-notable gets a word. */
const TAGGED: ReadonlySet<TicketStatus> = new Set<TicketStatus>([
  "ready",
  "running",
  "blocked",
  "failed",
  "cancelled",
]);

/** The legend printed beneath the tree, kept next to the glyph map it documents
 *  so the two never drift. */
export const TREE_LEGEND =
  "status:  ✓ complete   ✗ failed   ● running   ⊘ blocked   ○ ready   · pending   ⊗ cancelled\n" +
  "(← …)   extra dependencies beyond the tree parent";

/** Numeric-aware id ordering ("T-009" before "T-010"), matching the store's
 *  nextId() which sorts on the integer suffix rather than lexically. */
function byNumericId(a: string, b: string): number {
  return parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10);
}

/**
 * Render a ticket dependency DAG as an ASCII tree.
 *
 * The board is a DAG (`depends_on` edges), but a tree reads far better than a
 * tangle of arrows. So we lay it out as a *spanning tree*: each ticket hangs
 * under its **primary parent** — the first of its dependencies (in `depends_on`
 * order) that exists on the board — and any remaining dependencies are shown
 * inline as `(← T-x, T-y)` cross-edges. A ticket with no (existing) dependency
 * is a root. The planner naturally lists the root-most dependency first, so the
 * primary-parent rule places each ticket as high in the tree as its author
 * intended; reorder `depends_on` to re-parent a node.
 *
 * Output mirrors the canonical charm planning view:
 *
 *   T-212 ✓  get_post pitch data
 *     ├─ T-214 ·  backend: create_post + slide CRUD
 *     ├─ T-215 ·  orchestrator: launch_run + custom vars
 *     │   └─ T-217 ·  agent_mcp: run_processing
 *     ├─ T-216 ·  prompts: operator-notes + no-pitch
 *     └─ T-218 ·  agent.rs: teach tools + no-delete       (← T-214, T-217)
 *         └─ T-219 ·  cleanup: vestigial context plumbing
 *             └─ T-220 ·  cleanup: dead-code sweep
 *
 * Pure and deterministic: no I/O, ordering fixed by numeric id, so it is safe to
 * snapshot in tests and identical across runs.
 */
export function renderTicketTree(tickets: TreeTicket[]): string {
  if (tickets.length === 0) return "(no tickets)";

  const byId = new Map(tickets.map((t) => [t.id, t]));

  // Split each ticket's existing dependencies into a single primary parent (the
  // tree edge) and the rest (cross-edges, annotated inline). Dependencies that
  // don't resolve to a ticket on the board are dropped — a dangling id should
  // never strand a node off the tree.
  const primaryParent = new Map<string, string | null>();
  const extraDeps = new Map<string, string[]>();
  for (const t of tickets) {
    const existing = t.depends_on.filter((d) => byId.has(d));
    primaryParent.set(t.id, existing[0] ?? null);
    extraDeps.set(t.id, existing.slice(1));
  }

  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const t of tickets) {
    const parent = primaryParent.get(t.id)!;
    if (parent === null) roots.push(t.id);
    else {
      const siblings = children.get(parent) ?? [];
      siblings.push(t.id);
      children.set(parent, siblings);
    }
  }
  for (const siblings of children.values()) siblings.sort(byNumericId);
  roots.sort(byNumericId);

  // Two passes: build every line's (label, annotation) first, then align all
  // annotations to a common column so the `[status]` / `(← …)` tags line up.
  type Row = { label: string; annotation: string };
  const rows: Row[] = [];
  const visited = new Set<string>();

  const walk = (id: string, prefix: string, isLast: boolean, isRoot: boolean) => {
    // Cycle guard. The dep graph is supposed to be acyclic (the daemon enforces
    // it), but a hand-edited ticket could introduce a loop; bail rather than
    // recurse forever. Stranded nodes are appended after the walk.
    if (visited.has(id)) return;
    visited.add(id);

    const t = byId.get(id)!;
    const glyph = STATUS_GLYPH[t.status] ?? "?";
    const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
    const label = `${prefix}${connector}${t.id} ${glyph}  ${t.title}`;

    const ann: string[] = [];
    if (TAGGED.has(t.status)) ann.push(`[${t.status}]`);
    const extra = extraDeps.get(id)!;
    if (extra.length) ann.push(`(← ${extra.join(", ")})`);
    rows.push({ label, annotation: ann.join("  ") });

    const kids = children.get(id) ?? [];
    // Root children indent by two spaces; deeper levels carry a `│` down past a
    // parent that still has siblings below it, or blank space past a last child.
    const childPrefix = isRoot ? "  " : prefix + (isLast ? "    " : "│   ");
    kids.forEach((kid, i) => walk(kid, childPrefix, i === kids.length - 1, false));
  };

  roots.forEach((r, i) => walk(r, "", i === roots.length - 1, true));

  // Anything not reached by the walk is tangled in a cycle. Surface it flatly so
  // a corrupt board never silently hides tickets.
  for (const t of tickets) {
    if (visited.has(t.id)) continue;
    const glyph = STATUS_GLYPH[t.status] ?? "?";
    rows.push({ label: `${t.id} ${glyph}  ${t.title}`, annotation: "(cycle)" });
  }

  // Glyphs and box-drawing chars are all single UTF-16 code units, so `.length`
  // is the visible width — fine for column math here.
  const annWidth = Math.max(
    0,
    ...rows.filter((r) => r.annotation).map((r) => r.label.length),
  );
  return rows
    .map((r) => (r.annotation ? `${r.label.padEnd(annWidth + 2)}${r.annotation}` : r.label))
    .join("\n");
}
