import { DirectedGraph } from "graphology";
import { hasCycle, topologicalSort } from "graphology-dag";
import type { Ticket, TicketStatus } from "../schema.ts";

export type InFlight = { ticket_id: string; touches: string[] };

/** A dependency is satisfied only when it reaches `complete`; these statuses can
 *  never become `complete`, so a ticket depending on one of them is stuck. */
const TERMINAL_NOT_COMPLETE = new Set<TicketStatus>(["cancelled", "failed"]);

/**
 * Direct dependents of `cancelledId` that are still live (not complete itself,
 * and not already terminal). When a dependency is cancelled, these tickets can
 * never satisfy their `depends_on` — the solver only counts `complete` deps — so
 * they would otherwise defer forever and silently. The daemon surfaces this list
 * to the orchestrator so it re-plans (drop the edge, re-scope, or cancel them)
 * rather than retrying them in a loop. Direct dependents only: cancelling one of
 * these in turn surfaces ITS dependents, so the chain unwinds one decision at a
 * time under the orchestrator's review.
 */
export function liveDependentsOf(tickets: Ticket[], cancelledId: string): string[] {
  return tickets
    .filter(
      (t) =>
        t.frontmatter.depends_on.includes(cancelledId) &&
        t.frontmatter.status !== "complete" &&
        !TERMINAL_NOT_COMPLETE.has(t.frontmatter.status),
    )
    .map((t) => t.frontmatter.id);
}

export class Solver {
  private g: DirectedGraph;
  private byId: Map<string, Ticket>;

  constructor(tickets: Ticket[]) {
    this.byId = new Map(tickets.map((t) => [t.frontmatter.id, t]));
    this.g = new DirectedGraph({ allowSelfLoops: false });
    for (const t of tickets) this.g.addNode(t.frontmatter.id);
    // Referential integrity: a depends_on id that names no real ticket can never
    // enter `completed`, so nextRunnable would defer the ticket forever with no
    // error. Catch it loudly here rather than letting it silently deadlock.
    const dangling: string[] = [];
    for (const t of tickets) {
      for (const dep of t.frontmatter.depends_on) {
        if (this.byId.has(dep)) {
          this.g.addEdge(dep, t.frontmatter.id);
        } else {
          dangling.push(`${t.frontmatter.id} -> ${dep}`);
        }
      }
    }
    if (dangling.length > 0) {
      throw new Error(
        `ticket dependency graph references unknown tickets: ${dangling.join(", ")}`,
      );
    }
    if (hasCycle(this.g)) throw new Error("ticket dependency graph has a cycle");
  }

  topoOrder(): string[] {
    return topologicalSort(this.g);
  }

  /** Tickets whose deps are all complete and whose touches don't overlap any in-flight worker. */
  nextRunnable(opts: { completed: Set<string>; inFlight: InFlight[]; candidates?: string[] }): string[] {
    const claimed = new Set<string>();
    for (const f of opts.inFlight) for (const path of f.touches) claimed.add(path);

    // Dedupe candidates: input.ticket_ids is only validated as a non-empty
    // string array, so a duplicate id could otherwise be emitted twice (and
    // spawn a second worker on the same ticket). new Set preserves first-seen
    // order.
    const candidates = opts.candidates
      ? [...new Set(opts.candidates)].filter((id) => this.byId.has(id))
      : [...this.byId.keys()];

    const out: string[] = [];
    const newlyClaimed = new Set<string>();
    for (const id of candidates) {
      const t = this.byId.get(id)!;
      if (opts.completed.has(id)) continue;
      const depsReady = t.frontmatter.depends_on.every((d) => opts.completed.has(d));
      if (!depsReady) continue;
      const conflict = t.frontmatter.touches.some((p) => claimed.has(p) || newlyClaimed.has(p));
      if (conflict) continue;
      out.push(id);
      for (const p of t.frontmatter.touches) newlyClaimed.add(p);
    }
    return out;
  }
}
