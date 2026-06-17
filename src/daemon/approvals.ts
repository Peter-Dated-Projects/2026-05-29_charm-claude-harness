import type { ApprovalGate } from "../schema.ts";

type Waiter = { gate: ApprovalGate; resolve: (decision: "approve" | "reject") => void };

export class ApprovalQueue {
  private waiters = new Map<string, Waiter>();
  private seq = 0;
  private listeners = new Set<(snapshot: ApprovalGate[]) => void>();

  enqueue(opts: { stage: 2 | 4; label: string; ticket_id: string | null; payload_path: string | null; agent_id?: string | null }): Promise<"approve" | "reject"> {
    this.seq += 1;
    const gate: ApprovalGate = {
      id: `gate-${String(this.seq).padStart(3, "0")}`,
      stage: opts.stage,
      label: opts.label,
      ticket_id: opts.ticket_id,
      payload_path: opts.payload_path,
      agent_id: opts.agent_id ?? null,
      resolved: false,
      created_at: Date.now(),
    };
    return new Promise<"approve" | "reject">((resolve) => {
      this.waiters.set(gate.id, { gate, resolve });
      this.notify();
    });
  }

  resolve(id: string, decision: "approve" | "reject"): boolean {
    const w = this.waiters.get(id);
    if (!w) return false;
    w.gate.resolved = true;
    w.gate.decision = decision;
    this.waiters.delete(id);
    w.resolve(decision);
    this.notify();
    return true;
  }

  /** Cancel every gate owned by an agent that's being torn down, resolving each
   *  waiter as a "reject" so the parked await_approval call returns instead of
   *  hanging forever, and removing it from the queue so the board stops showing
   *  a zombie gate. Returns the ids of the gates that were cancelled. */
  cancelForAgent(agent_id: string): string[] {
    const cancelled: string[] = [];
    for (const [id, w] of this.waiters) {
      if (w.gate.agent_id !== agent_id) continue;
      w.gate.resolved = true;
      w.gate.decision = "reject";
      this.waiters.delete(id);
      w.resolve("reject");
      cancelled.push(id);
    }
    if (cancelled.length > 0) this.notify();
    return cancelled;
  }

  pending(): ApprovalGate[] {
    return [...this.waiters.values()].map((w) => w.gate);
  }

  onChange(fn: (snapshot: ApprovalGate[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    const snap = this.pending();
    for (const l of this.listeners) l(snap);
  }
}
