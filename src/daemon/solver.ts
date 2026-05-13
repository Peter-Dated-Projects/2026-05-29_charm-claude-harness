import { DirectedGraph } from "graphology";
import { hasCycle, topologicalSort } from "graphology-dag";
import type { Ticket } from "../schema.ts";

export type InFlight = { ticket_id: string; touches: string[] };

export class Solver {
  private g: DirectedGraph;
  private byId: Map<string, Ticket>;

  constructor(tickets: Ticket[]) {
    this.byId = new Map(tickets.map((t) => [t.frontmatter.id, t]));
    this.g = new DirectedGraph({ allowSelfLoops: false });
    for (const t of tickets) this.g.addNode(t.frontmatter.id);
    for (const t of tickets) {
      for (const dep of t.frontmatter.depends_on) {
        if (this.byId.has(dep)) this.g.addEdge(dep, t.frontmatter.id);
      }
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

    const candidates = opts.candidates
      ? opts.candidates.filter((id) => this.byId.has(id))
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
